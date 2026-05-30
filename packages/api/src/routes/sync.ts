import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { Hono } from 'hono';

import type { DB } from '../db/client.js';
import * as schema from '../db/schema.js';
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
  existingEventIds,
  type Grade,
  type ReviewEventInput,
  persistEngineState,
} from '../lib/review-log.js';
import { type SessionVariables, getUser, requireAuth } from '../middleware/session.js';

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
  const app = new Hono<{ Variables: SessionVariables }>();
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
    });
  });

  app.post('/:materialId/events', async (c) => {
    const user = getUser(c);
    const materialId = c.req.param('materialId');
    const key = { userId: user.id, materialId };

    let body: UploadBody;
    try {
      body = await c.req.json<UploadBody>();
    } catch {
      return c.json({ error: 'invalid JSON body' }, 400);
    }
    const events = body.events;
    if (!Array.isArray(events)) return c.json({ error: 'events required' }, 400);
    if (events.length > MAX_BATCH_SIZE) {
      return c.json({ error: `Batch too large — max ${MAX_BATCH_SIZE} events per request` }, 413);
    }
    const nowSecs = now();
    for (const e of events) {
      const problem = validateUpload(e, nowSecs);
      if (problem) return c.json({ error: problem }, 400);
    }

    if (events.length === 0) {
      return c.json(unchangedResponse(deps.db, key, 0, 0));
    }

    const raw = await deps.engines.tryLoad(key);
    if (raw === null) return c.json({ error: 'Not enrolled' }, 404);
    using loaded = raw;
    for (const e of events) {
      if (e.snapshotVersion !== loaded.snapshotVersion) {
        return c.json({ error: 'Snapshot version mismatch — re-fetch state before syncing' }, 409);
      }
    }

    const seen = existingEventIds(
      deps.db,
      user.id,
      materialId,
      events.map((e) => e.clientEventId),
    );

    const fresh = events
      .filter((e) => !seen.has(e.clientEventId))
      .sort((a, b) =>
        a.timestampSecs !== b.timestampSecs
          ? a.timestampSecs - b.timestampSecs
          : a.clientEventId.localeCompare(b.clientEventId),
      );

    if (fresh.length === 0) {
      return c.json(unchangedResponse(deps.db, key, 0, events.length));
    }

    // Stale-merge preflight: if the batch's oldest event predates more
    // than STALE_MERGE_THRESHOLD already-applied server events, the
    // user probably didn't sync this device for a long time and the
    // automatic merge can drag down FSRS stability on cards reviewed
    // since. Surface the confirmation prompt before doing any work.
    // The client re-POSTs with confirmMerge:true to proceed, or
    // discards locally and never returns.
    if (body.confirmMerge !== true) {
      const oldestQueuedTs = fresh.reduce(
        (min, e) => (e.timestampSecs < min ? e.timestampSecs : min),
        fresh[0].timestampSecs,
      );
      const sinceRow = deps.db
        .select({ count: sql<number>`COUNT(*)` })
        .from(schema.reviewEvents)
        .where(
          and(
            eq(schema.reviewEvents.userId, user.id),
            eq(schema.reviewEvents.materialId, materialId),
            sql`${schema.reviewEvents.timestampSecs} > ${oldestQueuedTs}`,
          ),
        )
        .get();
      const serverEventsSince = sinceRow?.count ?? 0;
      if (serverEventsSince > STALE_MERGE_THRESHOLD) {
        const newestRow = deps.db
          .select({ ts: sql<number>`MAX(${schema.reviewEvents.timestampSecs})` })
          .from(schema.reviewEvents)
          .where(
            and(
              eq(schema.reviewEvents.userId, user.id),
              eq(schema.reviewEvents.materialId, materialId),
            ),
          )
          .get();
        return c.json({
          needsConfirm: true,
          staleSummary: {
            queuedCount: fresh.length,
            serverEventsSince,
            oldestQueuedTs,
            newestServerTs: newestRow?.ts ?? oldestQueuedTs,
          },
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
    let outOfOrder = false;
    if (freshReviewCardIds.length > 0) {
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
        accepted: fresh.length - graduateNoops,
        duplicates: events.length - fresh.length + graduateNoops,
        rebuilt: outOfOrder,
        // Send the full state so fat clients can replace their cache in one
        // shot; DB writes were filtered above to just the touched keys
        // (or wholesale-replaced inside rebuildFromEvents).
        testStates: resultStates,
        lastEventId: latestEventId(deps.db, user.id, materialId),
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
  };
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

function validateUpload(e: SyncEventUpload, nowSecs: number): string | null {
  if (typeof e.clientEventId !== 'string' || !e.clientEventId) return 'clientEventId required';
  if (!Number.isInteger(e.timestampSecs) || e.timestampSecs < 0) {
    return 'timestampSecs must be a non-negative integer';
  }
  if (e.timestampSecs > nowSecs + CLOCK_SKEW_TOLERANCE_SECS) {
    return 'timestampSecs more than 24h in the future — check device clock';
  }
  if (!Number.isInteger(e.snapshotVersion) || e.snapshotVersion < 1) {
    return 'snapshotVersion must be a positive integer';
  }
  const kind = eventKind(e);
  if (kind === 'review') {
    const re = e as ReviewEventUpload;
    if (!Number.isInteger(re.cardId) || re.cardId < 0) {
      return 'cardId must be a non-negative integer';
    }
    if (![1, 2, 3, 4].includes(re.grade)) {
      return 'grade must be 1..=4';
    }
  } else if (kind === 'graduate') {
    const ge = e as GraduateEventUpload;
    if (!Number.isInteger(ge.verseId) || ge.verseId < 0) {
      return 'verseId must be a non-negative integer';
    }
  } else if (kind === 'graduateCard') {
    const gc = e as GraduateCardEventUpload;
    if (!Number.isInteger(gc.cardId) || gc.cardId < 0) {
      return 'cardId must be a non-negative integer';
    }
  } else {
    return `unknown event kind: ${String((e as { kind: unknown }).kind)}`;
  }
  return null;
}
