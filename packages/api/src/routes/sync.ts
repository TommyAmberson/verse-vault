import { randomUUID } from 'node:crypto';

import { and, desc, eq, inArray } from 'drizzle-orm';
import { Hono } from 'hono';

import type { DB } from '../db/client.js';
import * as schema from '../db/schema.js';
import {
  type CardStateEntry,
  type EdgeStateEntry,
  EngineStore,
  readCardStateEntries,
  readEdgeStateEntries,
} from '../lib/engine.js';
import { jsonBlob } from '../lib/keys.js';
import { type Grade, type ReviewOutcome, persistEngineState } from '../lib/review-log.js';
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
  cardId: number | null;
  shown: number[];
  hidden: number[];
  grades: Grade[];
}

interface UploadBody {
  events: ReviewEventUpload[];
}

export function syncRoutes(deps: SyncRoutesDeps) {
  const now = deps.now ?? (() => Math.floor(Date.now() / 1000));
  const app = new Hono<{ Variables: SessionVariables }>();

  app.use('*', requireAuth());

  app.get('/:materialId/state', (c) => {
    const user = getUser(c);
    const materialId = c.req.param('materialId');
    const key = { userId: user.id, materialId };

    const snapshot = deps.db
      .select()
      .from(schema.graphSnapshots)
      .where(
        and(
          eq(schema.graphSnapshots.userId, user.id),
          eq(schema.graphSnapshots.materialId, materialId),
        ),
      )
      .orderBy(desc(schema.graphSnapshots.version))
      .limit(1)
      .get();
    if (!snapshot) return c.json({ error: 'Not enrolled' }, 404);

    return c.json({
      snapshot: {
        version: snapshot.version,
        graphData: JSON.parse(snapshot.graphData.toString('utf8')) as unknown,
        cardsData: JSON.parse(snapshot.cardsData.toString('utf8')) as unknown,
      },
      edgeStates: readEdgeStateEntries(deps.db, key),
      cardStates: readCardStateEntries(deps.db, key),
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

    const loaded = await deps.engines.load(key);
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

    // Sort so multi-device uploads stay deterministic regardless of arrival order.
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

    const changedEdgeIds = new Set<number>();
    for (const e of fresh) {
      const outcome = JSON.parse(
        loaded.engine.replay_event(
          JSON.stringify(e.shown),
          JSON.stringify(e.hidden),
          JSON.stringify(e.grades),
          BigInt(e.timestampSecs),
        ),
      ) as ReviewOutcome;
      for (const u of outcome.edge_updates) changedEdgeIds.add(u.edge_id);
    }

    const allEdges = JSON.parse(loaded.engine.export_edge_states()) as EdgeStateEntry[];
    const changedEdges = allEdges.filter((e) => changedEdgeIds.has(e.edge_id));
    const allCards = JSON.parse(loaded.engine.export_card_states()) as CardStateEntry[];
    const createdAt = now();
    const eventRows = fresh.map((e) => ({
      id: randomUUID(),
      userId: user.id,
      materialId,
      snapshotVersion: e.snapshotVersion,
      timestampSecs: e.timestampSecs,
      cardId: e.cardId,
      clientEventId: e.clientEventId,
      shown: jsonBlob(e.shown),
      hidden: jsonBlob(e.hidden),
      grades: jsonBlob(e.grades),
      createdAt,
    }));

    deps.db.transaction((tx) => {
      persistEngineState(tx, {
        userId: user.id,
        materialId,
        eventRows,
        changedEdges,
        allCards,
      });
    });

    // Response carries the engine's full edge/card state so fat clients can
    // replace their local cache in one shot; DB writes are filtered above.
    return c.json({
      accepted: fresh.length,
      duplicates: events.length - fresh.length,
      edgeStates: allEdges,
      cardStates: allCards,
      lastEventId: eventRows[eventRows.length - 1]!.id,
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
    edgeStates: readEdgeStateEntries(db, key),
    cardStates: readCardStateEntries(db, key),
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
  if (typeof e.timestampSecs !== 'number') return 'timestampSecs required';
  if (typeof e.snapshotVersion !== 'number') return 'snapshotVersion required';
  if (e.cardId !== null && typeof e.cardId !== 'number') return 'cardId must be number or null';
  if (!Array.isArray(e.shown)) return 'shown must be an array';
  if (!Array.isArray(e.hidden)) return 'hidden must be an array';
  if (!Array.isArray(e.grades)) return 'grades must be an array';
  return null;
}
