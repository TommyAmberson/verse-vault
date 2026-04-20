import { randomUUID } from 'node:crypto';

import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { Hono } from 'hono';

import type { DB } from '../db/client.js';
import * as schema from '../db/schema.js';
import { type CardStateEntry, type EdgeStateEntry, EngineStore } from '../lib/engine.js';
import { jsonBlob } from '../lib/keys.js';
import type { Grade, ReviewOutcome } from '../lib/review-log.js';
import { type SessionVariables, getUser, requireAuth } from '../middleware/session.js';

export interface SyncRoutesDeps {
  db: DB;
  engines: EngineStore;
  now?: () => number;
}

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

  app.get('/:materialId/state', async (c) => {
    const user = getUser(c);
    const materialId = c.req.param('materialId');
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

    const edges = readEdgeStates(deps.db, user.id, materialId);
    const cards = readCardStates(deps.db, user.id, materialId);
    const latest = deps.db
      .select({ id: schema.reviewEvents.id })
      .from(schema.reviewEvents)
      .where(
        and(
          eq(schema.reviewEvents.userId, user.id),
          eq(schema.reviewEvents.materialId, materialId),
        ),
      )
      .orderBy(desc(schema.reviewEvents.timestampSecs), desc(schema.reviewEvents.id))
      .limit(1)
      .get();

    return c.json({
      snapshot: {
        version: snapshot.version,
        graphData: JSON.parse(snapshot.graphData.toString('utf8')) as unknown,
        cardsData: JSON.parse(snapshot.cardsData.toString('utf8')) as unknown,
      },
      edgeStates: edges,
      cardStates: cards,
      lastEventId: latest?.id ?? null,
    });
  });

  app.post('/:materialId/events', async (c) => {
    const user = getUser(c);
    const materialId = c.req.param('materialId');

    let body: UploadBody;
    try {
      body = await c.req.json<UploadBody>();
    } catch {
      return c.json({ error: 'invalid JSON body' }, 400);
    }
    const events = body.events;
    if (!Array.isArray(events)) return c.json({ error: 'events required' }, 400);
    for (const e of events) {
      const problem = validateUpload(e);
      if (problem) return c.json({ error: problem }, 400);
    }

    const loaded = await deps.engines.load({ userId: user.id, materialId });
    for (const e of events) {
      if (e.snapshotVersion !== loaded.snapshotVersion) {
        return c.json(
          {
            error: 'Snapshot version mismatch — re-fetch state before syncing',
            expected: loaded.snapshotVersion,
            got: e.snapshotVersion,
          },
          409,
        );
      }
    }

    const clientIds = events.map((e) => e.clientEventId);
    const existing = clientIds.length
      ? deps.db
          .select({ clientEventId: schema.reviewEvents.clientEventId })
          .from(schema.reviewEvents)
          .where(
            and(
              eq(schema.reviewEvents.userId, user.id),
              eq(schema.reviewEvents.materialId, materialId),
              inArray(schema.reviewEvents.clientEventId, clientIds),
            ),
          )
          .all()
      : [];
    const seen = new Set(existing.map((r) => r.clientEventId));

    // Apply events to the live engine in (timestamp, clientEventId) order so
    // multi-device uploads stay deterministic regardless of arrival order.
    const fresh = events
      .filter((e) => !seen.has(e.clientEventId))
      .sort((a, b) =>
        a.timestampSecs !== b.timestampSecs
          ? a.timestampSecs - b.timestampSecs
          : a.clientEventId.localeCompare(b.clientEventId),
      );

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

    let lastEventId: string | null = null;
    deps.db.transaction((tx) => {
      if (fresh.length > 0) {
        const rows = fresh.map((e) => {
          const id = randomUUID();
          lastEventId = id;
          return {
            id,
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
          };
        });
        tx.insert(schema.reviewEvents).values(rows).run();
      }

      if (changedEdges.length > 0) {
        tx.insert(schema.edgeStates)
          .values(
            changedEdges.map((e) => ({
              userId: user.id,
              materialId,
              edgeId: e.edge_id,
              stability: e.stability,
              difficulty: e.difficulty,
              lastReviewSecs: e.last_review_secs,
            })),
          )
          .onConflictDoUpdate({
            target: [schema.edgeStates.userId, schema.edgeStates.materialId, schema.edgeStates.edgeId],
            set: {
              stability: sql`excluded.stability`,
              difficulty: sql`excluded.difficulty`,
              lastReviewSecs: sql`excluded.last_review_secs`,
            },
          })
          .run();
      }

      if (allCards.length > 0) {
        tx.insert(schema.cardStates)
          .values(
            allCards.map((c) => ({
              userId: user.id,
              materialId,
              cardId: c.card_id,
              state: c.state,
              dueR: c.due_r,
              dueDateSecs: c.due_date_secs,
              priority: c.priority,
            })),
          )
          .onConflictDoUpdate({
            target: [schema.cardStates.userId, schema.cardStates.materialId, schema.cardStates.cardId],
            set: {
              state: sql`excluded.state`,
              dueR: sql`excluded.due_r`,
              dueDateSecs: sql`excluded.due_date_secs`,
              priority: sql`excluded.priority`,
            },
          })
          .run();
      }
    });

    if (lastEventId === null) {
      const latest = deps.db
        .select({ id: schema.reviewEvents.id })
        .from(schema.reviewEvents)
        .where(
          and(
            eq(schema.reviewEvents.userId, user.id),
            eq(schema.reviewEvents.materialId, materialId),
          ),
        )
        .orderBy(desc(schema.reviewEvents.timestampSecs), desc(schema.reviewEvents.id))
        .limit(1)
        .get();
      lastEventId = latest?.id ?? null;
    }

    // Response returns the engine's full edge/card state so fat clients can
    // replace their local cache in one shot, rather than having to merge
    // deltas. DB writes are filtered to the changed set as an optimization.
    return c.json({
      accepted: fresh.length,
      duplicates: events.length - fresh.length,
      edgeStates: allEdges,
      cardStates: allCards,
      lastEventId,
    });
  });

  return app;
}

function readEdgeStates(db: DB, userId: string, materialId: string): EdgeStateEntry[] {
  return db
    .select()
    .from(schema.edgeStates)
    .where(and(eq(schema.edgeStates.userId, userId), eq(schema.edgeStates.materialId, materialId)))
    .all()
    .map((e) => ({
      edge_id: e.edgeId,
      stability: e.stability,
      difficulty: e.difficulty,
      last_review_secs: e.lastReviewSecs,
    }));
}

function readCardStates(db: DB, userId: string, materialId: string): CardStateEntry[] {
  return db
    .select()
    .from(schema.cardStates)
    .where(and(eq(schema.cardStates.userId, userId), eq(schema.cardStates.materialId, materialId)))
    .all()
    .map((c) => ({
      card_id: c.cardId,
      state: c.state,
      due_r: c.dueR,
      due_date_secs: c.dueDateSecs,
      priority: c.priority,
    }));
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
