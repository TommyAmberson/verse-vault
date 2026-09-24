import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';

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
import { getMaterial, getMaterialJson } from '../lib/materials.js';
import {
  hasPromotable,
  judge,
  markDiscarded,
  rejudgeHeld,
  type PendingRow,
  mergeQuestion,
  serverEventsSince,
  take,
  takenClientEventIds,
  type TakeInput,
} from '../lib/pending-events.js';
import type { UserMaterial } from '../lib/keys.js';
import { computeStateRev } from '../lib/state-rev.js';
import {
  cardIdOf,
  eventKind,
  type GraduateCardEventUpload,
  type GraduateEventUpload,
  parseUpload,
  type ReviewEventUpload,
  type SyncEventUpload,
  type UploadIds,
} from '../lib/sync-events.js';
import {
  type ReviewEventInput,
  persistEngineState,
  writeGraduatedCard,
  writeGraduatedVerse,
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

/** Caps an upload's body. A full page of well-formed events is about
 *  125 KB; this leaves headroom while bounding what one request can ask
 *  the server to store, since malformed events are kept verbatim. */
const MAX_UPLOAD_BYTES = 1024 * 1024;

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
      pendingConfirmation: mergeQuestion(deps.db, key),
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

  app.use(
    '/:materialId/events',
    bodyLimit({
      maxSize: MAX_UPLOAD_BYTES,
      onError: (c) => c.json({ error: 'payload too large' }, 413),
    }),
  );

  app.post('/:materialId/events', async (c) => {
    const user = getUser(c);
    const materialId = c.req.param('materialId');
    const key = { userId: user.id, materialId };

    // The only refusals left strand nothing: a material the catalogue
    // does not have can never apply an event, a body that is not a list
    // of events carries nothing to take, 413 is a page size, and 409
    // below is a stale stamp the client fixes itself. Every event in a
    // readable list is taken (spec FR-001) and gets a disposition.
    if (!getMaterial(materialId)) {
      return c.json({ error: `Unknown material: ${materialId}` }, 404);
    }
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

    const wellFormed: UploadEntry[] = [];
    events.forEach((raw, index) => {
      const parsed = parseUpload(raw, nowSecs);
      if (parsed.event) wellFormed.push({ index, event: parsed.event, ids: parsed });
      else setAside(index, parsed, 'unusable', 'malformed', parsed.problem);
    });

    // Already taken, into either table, or earlier in this same request.
    const seen = takenClientEventIds(
      deps.db,
      key,
      wellFormed.map((w) => w.event.clientEventId),
    );
    let duplicates = 0;

    const raw = await deps.engines.tryLoad(key);
    if (raw === null) {
      // Not enrolled. Refusing would strand these on the device for
      // good; hold them until the account enrols in this material.
      for (const { index, event, ids } of wellFormed) {
        if (seen.has(event.clientEventId)) {
          dispositions[index] = duplicateOf(index, event);
          duplicates += 1;
          continue;
        }
        seen.add(event.clientEventId);
        setAside(index, ids, 'pending', 'not-enrolled', `not enrolled in ${materialId}`);
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

    // Judge each event before anything persists. An id the learner's
    // engine lacks never reaches review_events or graduated_cards, where
    // replay would have to cope with it forever: core's max-emission
    // config says whether it is a card they switched off (it waits) or
    // one nothing produces (unusable).
    const classes = deps.engines.classifyCardIds(
      key,
      loaded.engine,
      wellFormed.map((w) => cardIdOf(w.event)).filter((id): id is number => id !== null),
    );

    let mergedHere = 0;
    const applicable: UploadEntry[] = [];
    for (const w of wellFormed) {
      const { index, event, ids } = w;
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
      const verdict = judge(event, classes);
      if (!verdict.apply) {
        setAside(index, ids, verdict.status, verdict.reasonCode, verdict.reason);
        continue;
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
        for (const { index, ids } of applicable) {
          setAside(
            index,
            ids,
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
          staleSummary: mergeQuestion(deps.db, key),
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
            writeGraduatedVerse(tx, key, g.verseId, g.timestampSecs);
          }
          for (const g of cardGraduations) {
            writeGraduatedCard(tx, key, g.cardId, g.timestampSecs);
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

/** Apply every event held awaiting the learner's merge answer, at its
 *  recorded time, then rebuild: the batch predates applied history by
 *  definition, so only a replay from the log orders it correctly. Each
 *  event is re-judged first, by the rule the upload used: a card the
 *  learner has switched off since keeps waiting, and one no config emits
 *  any more becomes unusable, rather than either reaching the log. */
async function mergeAwaiting(deps: SyncRoutesDeps, key: UserMaterial): Promise<PendingRow[]> {
  if (!hasPromotable(deps.db, key, ['awaiting-confirmation'])) return [];
  // Loaded outside the lock, as every route does: load never takes it.
  using loaded = await deps.engines.load(key);
  return await deps.engines.withLock(key, async () => {
    const promoted = rejudgeHeld(deps.db, key, ['awaiting-confirmation'], (ids) =>
      deps.engines.classifyCardIds(key, loaded.engine, ids),
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

/** A well-formed upload, its position in the request, and its ids. */
interface UploadEntry {
  index: number;
  event: SyncEventUpload;
  ids: UploadIds;
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

/** Store what was taken but not applied, and log it: until this feature
 *  the reason an event did not land lived only in a response body
 *  nobody keeps. One JSON line per request, with the requestId, in the
 *  shape the request logger emits so `journalctl | jq` can join them. */
function takeNotApplied(
  db: Parameters<typeof take>[0],
  key: UserMaterial,
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
