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

/** Transactional so the event log and the materialized state can't diverge. */
export function recordReview(args: RecordReviewArgs): void {
  const { db, entry, timestampSecs, card, grades, outcome } = args;
  const { userId, materialId } = entry;
  const edges = JSON.parse(entry.engine.export_edge_states()) as EdgeStateEntry[];
  const cards = JSON.parse(entry.engine.export_card_states()) as CardStateEntry[];
  const changedEdgeIds = new Set(outcome.edge_updates.map((u) => u.edge_id));
  const edgeRows = edges
    .filter((e) => changedEdgeIds.has(e.edge_id))
    .map((e) => ({
      userId,
      materialId,
      edgeId: e.edge_id,
      stability: e.stability,
      difficulty: e.difficulty,
      lastReviewSecs: e.last_review_secs,
    }));
  const cardRows = cards.map((c) => ({
    userId,
    materialId,
    cardId: c.card_id,
    state: c.state,
    dueR: c.due_r,
    dueDateSecs: c.due_date_secs,
    priority: c.priority,
  }));

  db.transaction((tx) => {
    tx.insert(schema.reviewEvents)
      .values({
        id: randomUUID(),
        userId,
        materialId,
        snapshotVersion: entry.snapshotVersion,
        timestampSecs,
        cardId: card.source_card_id,
        shown: jsonBlob(card.shown),
        hidden: jsonBlob(card.hidden),
        grades: jsonBlob(grades),
        createdAt: timestampSecs,
      })
      .run();

    if (edgeRows.length > 0) {
      tx.insert(schema.edgeStates)
        .values(edgeRows)
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

    if (cardRows.length > 0) {
      tx.insert(schema.cardStates)
        .values(cardRows)
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
}
