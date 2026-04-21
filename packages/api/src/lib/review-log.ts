import { randomUUID } from 'node:crypto';

import { sql } from 'drizzle-orm';

import type { DB } from '../db/client.js';
import * as schema from '../db/schema.js';
import type { CardStateEntry, EdgeStateEntry } from './engine.js';
import { jsonBlob } from './keys.js';
import type { SessionCard, SessionEntry } from './sessions.js';

export interface Grade {
  node_id: number;
  grade: 1 | 2 | 3 | 4;
}

/** Mirrors the core's `Grade::is_pass` — Good (3) and Easy (4) are passes. */
export function isPass(g: Grade): boolean {
  return g.grade >= 3;
}

export interface ReviewOutcome {
  edge_updates: Array<{ edge_id: number; grade: number; weight: number }>;
  redrills_inserted: number;
}

export interface RecordReviewArgs {
  db: DB;
  entry: SessionEntry;
  timestampSecs: number;
  card: SessionCard;
  grades: Grade[];
  outcome: ReviewOutcome;
}

type Tx = Parameters<Parameters<DB['transaction']>[0]>[0];

export interface PersistEngineStateArgs {
  userId: string;
  materialId: string;
  eventRows: (typeof schema.reviewEvents.$inferInsert)[];
  changedEdges: EdgeStateEntry[];
  allCards: CardStateEntry[];
}

/**
 * Shared write path for the online session and the offline sync replay.
 * Appending events + upserting materialized state in one transaction keeps
 * the event log and the cache from drifting.
 */
export function persistEngineState(tx: Tx, args: PersistEngineStateArgs): void {
  const { userId, materialId, eventRows, changedEdges, allCards } = args;

  if (eventRows.length > 0) {
    tx.insert(schema.reviewEvents).values(eventRows).run();
  }

  if (changedEdges.length > 0) {
    tx.insert(schema.edgeStates)
      .values(
        changedEdges.map((e) => ({
          userId,
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
          userId,
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
}

export function recordReview(args: RecordReviewArgs): void {
  const { db, entry, timestampSecs, card, grades, outcome } = args;
  const { userId, materialId } = entry;

  const allEdges = JSON.parse(entry.engine.export_edge_states()) as EdgeStateEntry[];
  const allCards = JSON.parse(entry.engine.export_card_states()) as CardStateEntry[];
  const changedEdgeIds = new Set(outcome.edge_updates.map((u) => u.edge_id));
  const changedEdges = allEdges.filter((e) => changedEdgeIds.has(e.edge_id));

  const eventId = randomUUID();
  const eventRows = [
    {
      id: eventId,
      userId,
      materialId,
      snapshotVersion: entry.snapshotVersion,
      timestampSecs,
      cardId: card.source_card_id,
      clientEventId: eventId, // online: server UUID serves as both row id and idempotency key
      shown: jsonBlob(card.shown),
      hidden: jsonBlob(card.hidden),
      grades: jsonBlob(grades),
      createdAt: timestampSecs,
    },
  ];

  db.transaction((tx) => {
    persistEngineState(tx, { userId, materialId, eventRows, changedEdges, allCards });
  });
}
