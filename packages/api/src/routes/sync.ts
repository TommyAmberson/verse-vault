import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { Hono } from 'hono';

import type { DB } from '../db/client.js';
import * as schema from '../db/schema.js';
import type { PendingReasonCode } from '../db/schema.js';
import {
  EngineStore,
  changedStatesFromUpdates,
  type TestStateEntry,
  type TestUpdateWire,
  getLatestSnapshot,
  readGraduatedCardIds,
  readGraduatedVerseIds,
  readTestStateEntries,
} from '../lib/engine.js';
import { getMaterialJson } from '../lib/materials.js';
import {
  hasPromotable,
  heldClientEventIds,
  markDiscarded,
  type PendingRow,
  promote,
  summariseAwaitingConfirmation,
  take,
  type TakeInput,
  writeApplied,
} from '../lib/pending-events.js';
import type { UserMaterial } from '../lib/keys.js';
import { computeStateRev } from '../lib/state-rev.js';
import {
  existingEventIds,
  type Grade,
  type ReviewEventInput,
  persistEngineState,
} from '../lib/review-log.js';
import { type AppVariables, getUser, requireAuth } from '../middleware/session.js';

export interface SyncRoutesDeps {
  db: DB;
  engines: EngineStore;
  now?: () => number;
}

/** Caps each upload to bound per-request work; the dedup query chunks
 *  internally (see `existingEventIds`) so it isn't tied to this value. */
const MAX_BATCH_SIZE = 500;

/** Events with `timestampSecs` more than this far in the future are rejected.
 *  A broken device RTC (BIOS battery dead, etc.) would otherwise wedge the
 *  user's event timeline arbitrarily. */
const CLOCK_SKEW_TOLERANCE_SECS = 24 * 60 * 60;

interface BaseEventUpload {
  clientEventId: string;
  timestampSecs: number;
  snapshotVersion: number;
}

interface ReviewEventUpload extends BaseEventUpload {
  /** Optional for backward compat: legacy uploads omit `kind`. */
  kind?: 'review';
  cardId: number;
  grade: Grade;
}

interface GraduateEventUpload extends BaseEventUpload {
  kind: 'graduate';
  verseId: number;
}

interface GraduateCardEventUpload extends BaseEventUpload {
  kind: 'graduateCard';
  cardId: number;
}

type SyncEventUpload = ReviewEventUpload | GraduateEventUpload | GraduateCardEventUpload;

interface UploadBody {
  events: SyncEventUpload[];
  /** Set true to bypass the stale-merge preflight after the client has
   *  shown the confirmation modal. */
  confirmMerge?: boolean;
}

/** Threshold for the stale-merge preflight: a batch whose oldest event
 *  predates more than this many already-applied server events triggers
 *  a `needsConfirm` response so the user can choose Sync / Discard /
 *  Cancel before the merge actually runs. */
const STALE_MERGE_THRESHOLD = 10;

function eventKind(e: SyncEventUpload): 'review' | 'graduate' | 'graduateCard' {
  return e.kind ?? 'review';
}

export function syncRoutes(deps: SyncRoutesDeps) {
  const app = new Hono<{ Variables: AppVariables }>();
  const now = deps.now ?? (() => Math.floor(Date.now() / 1000));

  app.use('*', requireAuth());

  app.get('/:materialId/state', (c) => {
    const user = getUser(c);
    const materialId = c.req.param('materialId');
    const key = { userId: user.id, materialId };

    const snapshot = getLatestSnapshot(deps.db, key);
    if (!snapshot) return c.json({ error: 'Not enrolled' }, 404);

    // Material content lives on disk (`data/<materialId>.json`); the DB
    // only tracks which version (by content_sha) each user is on. A
    // throw here means the deck file was removed without dropping
    // enrollments — operator-side data inconsistency. Return 500 with
    // a meaningful message instead of letting Hono convert to a bare
    // 500 with stack trace.
    let materialJson: string;
    try {
      materialJson = getMaterialJson(materialId);
    } catch (err) {
      console.error(`sync /state: cannot load disk JSON for ${materialId}:`, err);
      return c.json(
        { error: `Material content unavailable for ${materialId}` },
        500,
      );
    }
    return c.json({
      snapshot: {
        version: snapshot.version,
        // Round-trip as a structured object for clients that don't want
        // to re-parse strings.
        materialData: JSON.parse(materialJson) as unknown,
      },
      testStates: readTestStateEntries(deps.db, key),
      lastEventId: latestEventId(deps.db, user.id, materialId),
      // Cards default to `New` when the client constructs the engine
      // from materialData + testStates; ship the graduation logs so the
      // client can flip the right cards to `Active` after build,
      // mirroring what `EngineStore.load` does server-side. Two paths:
      // `graduate_verse` for the unconditional verse-bound kinds, and
      // `graduate_card` for HP / CCL / conditional kinds.
      graduatedVerseIds: readGraduatedVerseIds(deps.db, key),
      graduatedCardIds: readGraduatedCardIds(deps.db, key),
      // Fingerprint of the logs this response was built from — see
      // `computeStateRev` for what it detects and why.
      stateRev: computeStateRev(deps.db, user.id, materialId),
      // An open merge question, read from the server so any device can
      // raise it, including one wiped since the upload that opened it.
      pendingConfirmation: staleSummary(deps.db, key),
    });
  });

  app.post('/:materialId/confirm', async (c) => {
    const user = getUser(c);
    const materialId = c.req.param('materialId');
    const key = { userId: user.id, materialId };

    let decision: unknown;
    try {
      decision = ((await c.req.json()) as { decision?: unknown })?.decision;
    } catch {
      return c.json({ error: 'invalid JSON body' }, 400);
    }
    if (decision !== 'merge' && decision !== 'discard') {
      return c.json({ error: "decision must be 'merge' or 'discard'" }, 400);
    }
    if (!getLatestSnapshot(deps.db, key)) return c.json({ error: 'Not enrolled' }, 404);

    // Answering with nothing open is a no-op, not an error: another
    // device may have answered first.
    if (decision === 'discard') {
      return c.json({ discarded: markDiscarded(deps.db, key) });
    }
    const merged = await mergeAwaiting(deps, key);
    return c.json({
      ...unchangedResponse(deps.db, key, merged.length, 0),
      rebuilt: merged.length > 0,
    });
  });

  app.post('/:materialId/events', async (c) => {
    const user = getUser(c);
    const materialId = c.req.param('materialId');
    const key = { userId: user.id, materialId };

    // The only refusals left strand nothing: a body that is not a list
    // of events carries nothing to take, 413 is a page size, and 409
    // below is a stale stamp the client fixes itself. Every event in a
    // readable list is taken (spec FR-001) and gets a disposition.
    let body: UploadBody;
    try {
      body = await c.req.json<UploadBody>();
    } catch {
      return c.json({ error: 'invalid JSON body' }, 400);
    }
    const events: unknown[] = body?.events;
    if (!Array.isArray(events)) return c.json({ error: 'events required' }, 400);
    if (events.length > MAX_BATCH_SIZE) {
      return c.json({ error: `Batch too large — max ${MAX_BATCH_SIZE} events per request` }, 413);
    }
    const nowSecs = now();

    const dispositions: Disposition[] = new Array(events.length);
    const notApplied: { index: number; take: TakeInput }[] = [];
    const setAside = (
      index: number,
      parsed: UploadIds,
      status: TakeInput['status'],
      reasonCode: PendingReasonCode,
      reason: string,
    ) => {
      dispositions[index] = {
        index,
        clientEventId: parsed.clientEventId,
        disposition: status,
        reasonCode,
        reason,
      };
      notApplied.push({
        index,
        take: {
          clientEventId: parsed.clientEventId,
          kind: parsed.kind,
          timestampSecs: parsed.timestampSecs,
          payload: events[index] ?? null,
          status,
          reasonCode,
          reason,
        },
      });
    };

    const wellFormed: { index: number; event: SyncEventUpload }[] = [];
    events.forEach((raw, index) => {
      const parsed = parseUpload(raw, nowSecs);
      if (parsed.event) wellFormed.push({ index, event: parsed.event });
      else setAside(index, parsed, 'unusable', 'malformed', parsed.problem);
    });

    const raw = await deps.engines.tryLoad(key);
    if (raw === null) {
      // Not enrolled. Refusing would strand these on the device for
      // good; hold them until the account enrols in this material.
      const held = heldClientEventIds(
        deps.db,
        key,
        wellFormed.map((w) => w.event.clientEventId),
      );
      let duplicates = 0;
      for (const { index, event } of wellFormed) {
        if (held.has(event.clientEventId)) {
          dispositions[index] = duplicateOf(index, event);
          duplicates += 1;
        } else {
          held.add(event.clientEventId);
          setAside(
            index,
            uploadIds(event),
            'pending',
            'not-enrolled',
            `not enrolled in ${materialId}`,
          );
        }
      }
      takeNotApplied(deps.db, key, notApplied, nowSecs, c.get('requestId'));
      return c.json({
        accepted: 0,
        duplicates,
        rebuilt: false,
        testStates: [],
        lastEventId: null,
        stateRev: computeStateRev(deps.db, user.id, materialId),
        dispositions,
      });
    }
    using loaded = raw;
    for (const { event } of wellFormed) {
      if (event.snapshotVersion !== loaded.snapshotVersion) {
        return c.json({ error: 'Snapshot version mismatch — re-fetch state before syncing' }, 409);
      }
    }

    // An older client answers the merge question by re-sending its
    // batch with confirmMerge. Those events are already held, awaiting
    // that answer, so merge them rather than calling them duplicates.
    // The merge rebuilds the engine, which leaves `loaded` stale, so
    // anything applied below must go through a rebuild too.
    const mergedIds = new Set<string>();
    if (body.confirmMerge === true) {
      for (const row of await mergeAwaiting(deps, key)) {
        if (row.clientEventId !== null) mergedIds.add(row.clientEventId);
      }
    }

    // Already taken, into either table, or earlier in this same request.
    const ids = wellFormed.map((w) => w.event.clientEventId);
    const seen = existingEventIds(deps.db, user.id, materialId, ids);
    for (const id of heldClientEventIds(deps.db, key, ids)) seen.add(id);

    // Classify card ids before anything persists. An id the learner's
    // engine lacks never reaches review_events or graduated_cards, where
    // replay would have to cope with it forever. Core's max-emission
    // config says whether it is a card they switched off (it waits) or
    // one nothing produces (unusable).
    const classes = deps.engines.classifyCardIds(
      key,
      loaded,
      wellFormed
        .filter((w) => eventKind(w.event) !== 'graduate')
        .map((w) => (w.event as { cardId: number }).cardId),
    );

    let duplicates = 0;
    let mergedHere = 0;
    const applicable: { index: number; event: SyncEventUpload }[] = [];
    for (const w of wellFormed) {
      const { index, event } = w;
      if (seen.has(event.clientEventId)) {
        if (mergedIds.delete(event.clientEventId)) {
          dispositions[index] = {
            index,
            clientEventId: event.clientEventId,
            disposition: 'applied',
          };
          mergedHere += 1;
        } else {
          dispositions[index] = duplicateOf(index, event);
          duplicates += 1;
        }
        continue;
      }
      seen.add(event.clientEventId);
      if (eventKind(event) !== 'graduate') {
        const cardId = (event as { cardId: number }).cardId;
        const cls = classes.get(cardId);
        if (cls === 'not-emitted') {
          setAside(
            index,
            uploadIds(event),
            'pending',
            'card-not-emitted',
            `card id ${cardId} is not emitted by the current config`,
          );
          continue;
        }
        if (cls === 'unknown') {
          setAside(
            index,
            uploadIds(event),
            'unusable',
            'card-unknown',
            `card id ${cardId} is not produced by any config for this deck`,
          );
          continue;
        }
      }
      dispositions[index] = { index, clientEventId: event.clientEventId, disposition: 'applied' };
      applicable.push(w);
    }

    const fresh = applicable
      .map((w) => w.event)
      .sort((a, b) =>
        a.timestampSecs !== b.timestampSecs
          ? a.timestampSecs - b.timestampSecs
          : a.clientEventId.localeCompare(b.clientEventId),
      );

    if (fresh.length === 0) {
      takeNotApplied(deps.db, key, notApplied, nowSecs, c.get('requestId'));
      return c.json({
        ...unchangedResponse(deps.db, key, mergedHere, duplicates),
        rebuilt: mergedHere > 0,
        dispositions,
      });
    }

    // Stale-merge preflight: if the batch's oldest event predates more
    // than STALE_MERGE_THRESHOLD already-applied server events, the
    // user probably didn't sync this device for a long time and the
    // automatic merge can drag down FSRS stability on cards reviewed
    // since, so the learner is asked first. The batch is taken before
    // asking, held as awaiting-confirmation: while the question is open
    // the work must rest on the server, not in the browser (FR-011).
    // POST .../confirm answers it; GET /state re-raises it on any device.
    if (body.confirmMerge !== true) {
      const oldestQueuedTs = fresh.reduce(
        (min, e) => (e.timestampSecs < min ? e.timestampSecs : min),
        fresh[0].timestampSecs,
      );
      if (serverEventsSince(deps.db, key, oldestQueuedTs) > STALE_MERGE_THRESHOLD) {
        for (const { index, event } of applicable) {
          setAside(
            index,
            uploadIds(event),
            'pending',
            'awaiting-confirmation',
            'batch predates newer history; waiting for the learner to merge or discard it',
          );
        }
        takeNotApplied(deps.db, key, notApplied, nowSecs, c.get('requestId'));
        return c.json({
          ...unchangedResponse(deps.db, key, mergedHere, duplicates),
          rebuilt: mergedHere > 0,
          needsConfirm: true,
          staleSummary: staleSummary(deps.db, key),
          dispositions,
        });
      }
    }

    // Per-card out-of-order detection: any incoming review with a
    // timestamp earlier than what's already applied for the same card
    // means the cached engine's state for that card was computed
    // against the wrong ordering. FSRS is path-dependent, so the only
    // correct fix is to drop the cached engine and replay the full log
    // in (timestamp, clientEventId) order. Graduation events are
    // order-insensitive — they just flip lifecycle — so we only check
    // review events here.
    const freshReviewCardIds = [
      ...new Set(
        fresh.filter((e) => eventKind(e) === 'review').map((e) => (e as ReviewEventUpload).cardId),
      ),
    ];
    // A merge above already rebuilt the cached engine, so `loaded` is no
    // longer the engine to apply to in order.
    let outOfOrder = mergedHere > 0 || mergedIds.size > 0;
    if (!outOfOrder && freshReviewCardIds.length > 0) {
      const maxByCard = deps.db
        .select({
          cardId: schema.reviewEvents.cardId,
          maxTs: sql<number>`MAX(${schema.reviewEvents.timestampSecs})`,
        })
        .from(schema.reviewEvents)
        .where(
          and(
            eq(schema.reviewEvents.userId, user.id),
            eq(schema.reviewEvents.materialId, materialId),
            inArray(schema.reviewEvents.cardId, freshReviewCardIds),
          ),
        )
        .groupBy(schema.reviewEvents.cardId)
        .all();
      const maxByCardMap = new Map(maxByCard.map((r) => [r.cardId, r.maxTs]));
      for (const e of fresh) {
        if (eventKind(e) !== 'review') continue;
        const re = e as ReviewEventUpload;
        const existingMax = maxByCardMap.get(re.cardId);
        if (existingMax !== undefined && re.timestampSecs < existingMax) {
          outOfOrder = true;
          break;
        }
      }
    }

    // `return await` so the outer `using loaded` disposes after the
    // lock callback resolves, not when the function returns the
    // pending promise.
    return await deps.engines.withLock(key, async () => {
      const allUpdates: TestUpdateWire[] = [];
      const reviewEventInputs: ReviewEventInput[] = [];
      const graduations: { verseId: number; timestampSecs: number }[] = [];
      const cardGraduations: { cardId: number; timestampSecs: number }[] = [];
      // Graduate events whose `engine.graduate_verse` returned 0 (verse was
      // already Active before this batch) are counted alongside
      // clientEventId duplicates: they're no-ops the client should not
      // expect to flip any cards. Same accounting for graduateCard.
      let graduateNoops = 0;

      for (const e of fresh) {
        const kind = eventKind(e);
        if (kind === 'graduate') {
          const ge = e as GraduateEventUpload;
          // On the in-order path we apply to the cached engine for the
          // no-op count. On the rebuild path the cached engine is about
          // to be thrown away — the call is wasted but cheap, and it
          // keeps the no-op accounting consistent across both paths.
          const count = loaded.engine.graduate_verse(ge.verseId);
          if (count === 0) graduateNoops += 1;
          graduations.push({ verseId: ge.verseId, timestampSecs: ge.timestampSecs });
        } else if (kind === 'graduateCard') {
          const gc = e as GraduateCardEventUpload;
          const flipped = loaded.engine.graduate_card(gc.cardId);
          if (!flipped) graduateNoops += 1;
          cardGraduations.push({ cardId: gc.cardId, timestampSecs: gc.timestampSecs });
        } else {
          const re = e as ReviewEventUpload;
          if (!outOfOrder) {
            const updates = JSON.parse(
              loaded.engine.replay_event(re.cardId, re.grade, BigInt(re.timestampSecs)),
            ) as TestUpdateWire[];
            allUpdates.push(...updates);
          }
          reviewEventInputs.push({
            userId: user.id,
            materialId,
            snapshotVersion: re.snapshotVersion,
            timestampSecs: re.timestampSecs,
            cardId: re.cardId,
            grade: re.grade,
            clientEventId: re.clientEventId,
          });
        }
      }

      // In-order path: `replay_event`'s wire format already carries the
      // post-update state for each touched test, so we skip the full-
      // catalog `export_test_states` + filter that the old code did
      // here. `changedStatesFromUpdates` handles the "same test touched
      // by multiple events in this batch" case via last-write-wins.
      const changed: TestStateEntry[] = outOfOrder
        ? []
        : changedStatesFromUpdates(allUpdates);

      try {
        deps.db.transaction((tx) => {
          takeNotApplied(tx, key, notApplied, nowSecs, c.get('requestId'));
          persistEngineState(tx, {
            userId: user.id,
            materialId,
            events: reviewEventInputs,
            testStateUpdates: changed,
          });
          for (const g of graduations) {
            tx.insert(schema.graduatedVerses)
              .values({
                userId: user.id,
                materialId,
                verseId: g.verseId,
                graduatedAtSecs: g.timestampSecs,
              })
              .onConflictDoNothing()
              .run();
          }
          for (const g of cardGraduations) {
            tx.insert(schema.graduatedCards)
              .values({
                userId: user.id,
                materialId,
                cardId: g.cardId,
                graduatedAtSecs: g.timestampSecs,
              })
              .onConflictDoNothing()
              .run();
          }
        });
      } catch (err) {
        // The cached engine already absorbed engine.replay_event /
        // engine.graduate_verse calls for this batch above. If the DB
        // write failed, drop the cached engine so the next request
        // reconstructs it from disk state — otherwise the in-memory
        // engine would diverge from `reviewEvents` + `graduatedVerses`
        // until process restart.
        deps.engines.invalidate(key);
        throw err;
      }

      let resultStates: TestStateEntry[];
      if (outOfOrder) {
        // Rebuild from the full log. testStates table is wiped and
        // re-written inside rebuildFromEvents; the in-memory engine is
        // replaced too. Use the new engine to source the response.
        using rebuilt = deps.engines.rebuildFromEvents(key);
        resultStates = JSON.parse(rebuilt.engine.export_test_states()) as TestStateEntry[];
      } else {
        // The response carries the full catalog because thin clients
        // wholesale-replace their cache. Eliminating this export
        // requires a wire-shape change (response carries only the
        // delta + the client merges) — out of scope here; the
        // DB-write path's full export is already gone above.
        resultStates = JSON.parse(loaded.engine.export_test_states()) as TestStateEntry[];
      }

      return c.json({
        accepted: fresh.length - graduateNoops + mergedHere,
        duplicates: duplicates + graduateNoops,
        rebuilt: outOfOrder,
        // Send the full state so fat clients can replace their cache in one
        // shot; DB writes were filtered above to just the touched keys
        // (or wholesale-replaced inside rebuildFromEvents).
        testStates: resultStates,
        lastEventId: latestEventId(deps.db, user.id, materialId),
        // Post-merge fingerprint. The flush that just moved the server's
        // state stores this beside its cached snapshot — without it,
        // every boot after any synced session would see the years-row
        // fingerprint ahead of the cached one and needlessly refetch.
        stateRev: computeStateRev(deps.db, user.id, materialId),
        dispositions,
      });
    });
  });

  return app;
}

function unchangedResponse(
  db: DB,
  key: { userId: string; materialId: string },
  accepted: number,
  duplicates: number,
) {
  return {
    accepted,
    duplicates,
    rebuilt: false,
    testStates: readTestStateEntries(db, key),
    lastEventId: latestEventId(db, key.userId, key.materialId),
    stateRev: computeStateRev(db, key.userId, key.materialId),
  };
}

function serverEventsSince(db: DB, key: UserMaterial, sinceTs: number): number {
  const row = db
    .select({ count: sql<number>`COUNT(*)` })
    .from(schema.reviewEvents)
    .where(
      and(
        eq(schema.reviewEvents.userId, key.userId),
        eq(schema.reviewEvents.materialId, key.materialId),
        sql`${schema.reviewEvents.timestampSecs} > ${sinceTs}`,
      ),
    )
    .get();
  return row?.count ?? 0;
}

/** The open merge question for this account and material, or `null`.
 *  One shape for the upload's `staleSummary` and GET /state's
 *  `pendingConfirmation`, so the modal reads the same either way. */
function staleSummary(
  db: DB,
  key: UserMaterial,
): {
  queuedCount: number;
  serverEventsSince: number;
  oldestQueuedTs: number;
  newestServerTs: number;
} | null {
  const held = summariseAwaitingConfirmation(db, key);
  if (!held) return null;
  const newestRow = db
    .select({ ts: sql<number>`MAX(${schema.reviewEvents.timestampSecs})` })
    .from(schema.reviewEvents)
    .where(
      and(
        eq(schema.reviewEvents.userId, key.userId),
        eq(schema.reviewEvents.materialId, key.materialId),
      ),
    )
    .get();
  return {
    queuedCount: held.queuedCount,
    serverEventsSince: serverEventsSince(db, key, held.oldestQueuedTs),
    oldestQueuedTs: held.oldestQueuedTs,
    newestServerTs: newestRow?.ts ?? held.oldestQueuedTs,
  };
}

/** Apply every event held awaiting the learner's merge answer, at its
 *  recorded time, then rebuild: the batch predates applied history by
 *  definition, so only a replay from the log orders it correctly. */
async function mergeAwaiting(deps: SyncRoutesDeps, key: UserMaterial): Promise<PendingRow[]> {
  if (!hasPromotable(deps.db, key, ['awaiting-confirmation'])) return [];
  return deps.engines.withLock(key, async () => {
    const promoted = promote(deps.db, key, ['awaiting-confirmation'], (tx, row) =>
      writeApplied(tx, key, row),
    );
    // Nothing here reads the rebuilt engine; release the handle at once
    // so the cache holds the only reference.
    if (promoted.length > 0) deps.engines.rebuildFromEvents(key)[Symbol.dispose]();
    return promoted;
  });
}

function latestEventId(db: DB, userId: string, materialId: string): string | null {
  const latest = db
    .select({ id: schema.reviewEvents.id })
    .from(schema.reviewEvents)
    .where(
      and(
        eq(schema.reviewEvents.userId, userId),
        eq(schema.reviewEvents.materialId, materialId),
      ),
    )
    .orderBy(desc(schema.reviewEvents.timestampSecs), desc(schema.reviewEvents.id))
    .limit(1)
    .get();
  return latest?.id ?? null;
}

/** One event's outcome, reported back to the client by position. */
interface Disposition {
  index: number;
  clientEventId: string | null;
  disposition: 'applied' | 'duplicate' | 'pending' | 'unusable';
  reasonCode?: PendingReasonCode;
  reason?: string;
}

function duplicateOf(index: number, event: SyncEventUpload): Disposition {
  return { index, clientEventId: event.clientEventId, disposition: 'duplicate' };
}

/** The identifying fields of an upload, as far as they can be read. A
 *  malformed event may have none of them, and is taken anyway. */
interface UploadIds {
  clientEventId: string | null;
  kind: string | null;
  timestampSecs: number | null;
}

type ParsedUpload =
  | (UploadIds & { event: SyncEventUpload; problem?: undefined })
  | (UploadIds & { event?: undefined; problem: string });

function uploadIds(e: SyncEventUpload): UploadIds {
  return { clientEventId: e.clientEventId, kind: eventKind(e), timestampSecs: e.timestampSecs };
}

/** Store what was taken but not applied, and log it: until this feature
 *  the reason an event did not land lived only in a response body
 *  nobody keeps. One JSON line per request, with the requestId, in the
 *  shape the request logger emits so `journalctl | jq` can join them. */
function takeNotApplied(
  db: Parameters<typeof take>[0],
  key: { userId: string; materialId: string },
  notApplied: { index: number; take: TakeInput }[],
  nowSecs: number,
  requestId: string | undefined,
): void {
  if (notApplied.length === 0) return;
  take(db, key, notApplied.map((n) => n.take), nowSecs);
  console.warn(
    JSON.stringify({
      requestId,
      event: 'sync.events_not_applied',
      userId: key.userId,
      materialId: key.materialId,
      events: notApplied.map((n) => ({
        index: n.index,
        clientEventId: n.take.clientEventId,
        status: n.take.status,
        reasonCode: n.take.reasonCode,
        reason: n.take.reason,
      })),
    }),
  );
}

/** Read one uploaded event. Anything that fails is still taken, as
 *  `unusable` / `malformed`, with the problem as its reason. */
function parseUpload(raw: unknown, nowSecs: number): ParsedUpload {
  const obj = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {};
  const clientEventId =
    typeof obj.clientEventId === 'string' && obj.clientEventId ? obj.clientEventId : null;
  const kind = obj.kind === undefined ? 'review' : typeof obj.kind === 'string' ? obj.kind : null;
  const timestampSecs = Number.isInteger(obj.timestampSecs) ? (obj.timestampSecs as number) : null;
  const ids: UploadIds = { clientEventId, kind, timestampSecs };
  const fail = (problem: string): ParsedUpload => ({ ...ids, problem });

  if (typeof raw !== 'object' || raw === null) return fail('event must be an object');
  if (clientEventId === null) return fail('clientEventId must be a non-empty string');
  if (timestampSecs === null || timestampSecs < 0) {
    return fail('timestampSecs must be a non-negative integer');
  }
  if (timestampSecs > nowSecs + CLOCK_SKEW_TOLERANCE_SECS) {
    return fail('timestampSecs more than 24h in the future — check device clock');
  }
  if (!Number.isInteger(obj.snapshotVersion) || (obj.snapshotVersion as number) < 1) {
    return fail('snapshotVersion must be a positive integer');
  }
  const nonNegativeInt = (v: unknown) => Number.isInteger(v) && (v as number) >= 0;
  if (kind === 'review') {
    if (!nonNegativeInt(obj.cardId)) return fail('cardId must be a non-negative integer');
    if (![1, 2, 3, 4].includes(obj.grade as number)) return fail('grade must be 1..=4');
  } else if (kind === 'graduate') {
    if (!nonNegativeInt(obj.verseId)) return fail('verseId must be a non-negative integer');
  } else if (kind === 'graduateCard') {
    if (!nonNegativeInt(obj.cardId)) return fail('cardId must be a non-negative integer');
  } else {
    return fail(`unknown event kind: ${String(obj.kind)}`);
  }
  return { ...ids, event: raw as SyncEventUpload };
}
