import { sql } from 'drizzle-orm';

import type { DB } from '../db/client.js';
import * as schema from '../db/schema.js';
import type { TestStateEntry } from './engine.js';

/** FSRS rating: 1=Again, 2=Hard, 3=Good, 4=Easy. */
export type Grade = 1 | 2 | 3 | 4;

/** Mirrors the core's `Grade::is_pass` — only `Again` (1) is a fail. */
export function isPass(grade: number): boolean {
  return grade > 1;
}

export interface ReviewEventInput {
  userId: string;
  materialId: string;
  snapshotVersion: number;
  timestampSecs: number;
  cardId: number;
  grade: Grade;
  /** Idempotency key. Server-generated for online reviews; client-generated
   *  for offline events syncing through the sync API. */
  clientEventId: string;
}

export interface PersistArgs {
  /** Append-only review events to insert this transaction. */
  events: ReviewEventInput[];
  /** Subset of `test_states` rows to upsert — typically the keys touched by
   *  the engine `replay_event` call. */
  testStateUpdates: TestStateEntry[];
  userId: string;
  materialId: string;
}

type Tx = Parameters<Parameters<DB['transaction']>[0]>[0];

/**
 * Shared write path for online reviews and offline sync replay. Append the
 * events and upsert the touched test_states in one transaction so the event
 * log and the materialised state never drift.
 */
export function persistEngineState(tx: Tx, args: PersistArgs): void {
  const { events, testStateUpdates, userId, materialId } = args;

  if (events.length > 0) {
    tx.insert(schema.reviewEvents)
      .values(
        events.map((e) => ({
          id: e.clientEventId,
          userId: e.userId,
          materialId: e.materialId,
          snapshotVersion: e.snapshotVersion,
          timestampSecs: e.timestampSecs,
          cardId: e.cardId,
          grade: e.grade,
          clientEventId: e.clientEventId,
          createdAt: e.timestampSecs,
        })),
      )
      .run();
  }

  if (testStateUpdates.length > 0) {
    tx.insert(schema.testStates)
      .values(
        testStateUpdates.map((s) => ({
          userId,
          materialId,
          testKind: s.test_kind,
          element: JSON.stringify(s.element),
          stability: s.stability,
          difficulty: s.difficulty,
          lastSeenSecs: s.last_seen_secs,
          lastBaseSecs: s.last_base_secs,
          lastRootSecs: s.last_root_secs,
        })),
      )
      .onConflictDoUpdate({
        target: [
          schema.testStates.userId,
          schema.testStates.materialId,
          schema.testStates.testKind,
          schema.testStates.element,
        ],
        set: {
          stability: sql`excluded.stability`,
          difficulty: sql`excluded.difficulty`,
          lastSeenSecs: sql`excluded.last_seen_secs`,
          lastBaseSecs: sql`excluded.last_base_secs`,
          lastRootSecs: sql`excluded.last_root_secs`,
        },
      })
      .run();
  }
}
