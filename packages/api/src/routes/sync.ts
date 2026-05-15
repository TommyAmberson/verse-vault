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
import { type Grade, persistEngineState } from '../lib/review-log.js';
import { type SessionVariables, getUser, requireAuth } from '../middleware/session.js';

export interface SyncRoutesDeps {
  db: DB;
  engines: EngineStore;
  now?: () => number;
}

/** Caps each upload so the `inArray` dedup stays under SQLite's 999-param limit. */
const MAX_BATCH_SIZE = 500;

interface ReviewEventUpload {
  clientEventId: string;
  timestampSecs: number;
  snapshotVersion: number;
  cardId: number;
  grade: Grade;
}

interface UploadBody {
  events: ReviewEventUpload[];
}

interface TestUpdateWire {
  key: { kind: string; element: unknown };
  kind: 'Root' | 'Sub';
}

export function syncRoutes(deps: SyncRoutesDeps) {
  const app = new Hono<{ Variables: SessionVariables }>();

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
    for (const e of events) {
      const problem = validateUpload(e);
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
      for (const e of fresh) {
        const updates = JSON.parse(
          loaded.engine.replay_event(e.cardId, e.grade, BigInt(e.timestampSecs)),
        ) as TestUpdateWire[];
        for (const u of updates) {
          touchedKeys.add(`${u.key.kind}|${JSON.stringify(u.key.element)}`);
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
          events: fresh.map((e) => ({
            userId: user.id,
            materialId,
            snapshotVersion: e.snapshotVersion,
            timestampSecs: e.timestampSecs,
            cardId: e.cardId,
            grade: e.grade,
            clientEventId: e.clientEventId,
          })),
          testStateUpdates: changed,
        });
      });

      return c.json({
        accepted: fresh.length,
        duplicates: events.length - fresh.length,
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

function validateUpload(e: ReviewEventUpload): string | null {
  if (typeof e.clientEventId !== 'string' || !e.clientEventId) return 'clientEventId required';
  if (!Number.isInteger(e.timestampSecs) || e.timestampSecs < 0) {
    return 'timestampSecs must be a non-negative integer';
  }
  if (!Number.isInteger(e.snapshotVersion) || e.snapshotVersion < 1) {
    return 'snapshotVersion must be a positive integer';
  }
  if (!Number.isInteger(e.cardId) || e.cardId < 0) {
    return 'cardId must be a non-negative integer';
  }
  if (![1, 2, 3, 4].includes(e.grade)) {
    return 'grade must be 1..=4';
  }
  return null;
}
