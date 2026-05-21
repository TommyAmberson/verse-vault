import { and, desc, eq, inArray } from 'drizzle-orm';
import { Hono } from 'hono';

import type { DB } from '../db/client.js';
import * as schema from '../db/schema.js';
import {
  EngineStore,
  NotEnrolledError,
  type TestStateEntry,
  getLatestSnapshot,
  readTestStateEntries,
} from '../lib/engine.js';
import { type Grade, type ReviewEventInput, persistEngineState } from '../lib/review-log.js';
import { type SessionVariables, getUser, requireAuth } from '../middleware/session.js';

export interface SyncRoutesDeps {
  db: DB;
  engines: EngineStore;
  now?: () => number;
}

/** Caps each upload so the `inArray` dedup stays under SQLite's 999-param limit. */
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

type SyncEventUpload = ReviewEventUpload | GraduateEventUpload;

interface UploadBody {
  events: SyncEventUpload[];
}

interface TestUpdateWire {
  key: { kind: string; element: unknown };
  kind: 'Root' | 'Sub';
}

function eventKind(e: SyncEventUpload): 'review' | 'graduate' {
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

    return c.json({
      snapshot: {
        version: snapshot.version,
        // The MaterialData blob is stored as utf8 JSON; round-trip it as a
        // structured object for clients that don't want to re-parse strings.
        materialData: JSON.parse(snapshot.materialData.toString('utf8')) as unknown,
      },
      testStates: readTestStateEntries(deps.db, key),
      lastEventId: latestEventId(deps.db, user.id, materialId),
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

    let loaded;
    try {
      loaded = await deps.engines.load(key);
    } catch (err) {
      if (err instanceof NotEnrolledError) return c.json({ error: 'Not enrolled' }, 404);
      throw err;
    }
    for (const e of events) {
      if (e.snapshotVersion !== loaded.snapshotVersion) {
        return c.json({ error: 'Snapshot version mismatch — re-fetch state before syncing' }, 409);
      }
    }

    const existing = deps.db
      .select({ clientEventId: schema.reviewEvents.clientEventId })
      .from(schema.reviewEvents)
      .where(
        and(
          eq(schema.reviewEvents.userId, user.id),
          eq(schema.reviewEvents.materialId, materialId),
          inArray(
            schema.reviewEvents.clientEventId,
            events.map((e) => e.clientEventId),
          ),
        ),
      )
      .all();
    const seen = new Set(existing.map((r) => r.clientEventId));

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

    return deps.engines.withLock(key, async () => {
      const touchedKeys = new Set<string>();
      const reviewEventInputs: ReviewEventInput[] = [];
      const graduations: { verseId: number; timestampSecs: number }[] = [];
      // Graduate events whose `engine.graduate_verse` returned 0 (verse was
      // already Active before this batch) are counted alongside
      // clientEventId duplicates: they're no-ops the client should not
      // expect to flip any cards.
      let graduateNoops = 0;

      for (const e of fresh) {
        if (eventKind(e) === 'graduate') {
          const ge = e as GraduateEventUpload;
          const count = loaded.engine.graduate_verse(ge.verseId);
          if (count === 0) graduateNoops += 1;
          // Even when count is 0 we still upsert the graduatedVerses row
          // (no-op via onConflictDoNothing) so the table reflects every
          // graduate event the client tried to apply.
          graduations.push({ verseId: ge.verseId, timestampSecs: ge.timestampSecs });
        } else {
          const re = e as ReviewEventUpload;
          const updates = JSON.parse(
            loaded.engine.replay_event(re.cardId, re.grade, BigInt(re.timestampSecs)),
          ) as TestUpdateWire[];
          for (const u of updates) {
            touchedKeys.add(`${u.key.kind}|${JSON.stringify(u.key.element)}`);
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

      const allStates = JSON.parse(loaded.engine.export_test_states()) as TestStateEntry[];
      const changed = allStates.filter((s) =>
        touchedKeys.has(`${s.test_kind}|${JSON.stringify(s.element)}`),
      );

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
      });

      return c.json({
        accepted: fresh.length - graduateNoops,
        duplicates: events.length - fresh.length + graduateNoops,
        // Send the full state so fat clients can replace their cache in one
        // shot; DB writes were filtered above to just the touched keys.
        testStates: allStates,
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
  } else {
    return `unknown event kind: ${String((e as { kind: unknown }).kind)}`;
  }
  return null;
}
