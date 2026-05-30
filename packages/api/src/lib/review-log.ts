import { and, eq, inArray, sql } from 'drizzle-orm';

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

/** A read/write executor: either the root `DB` or a transaction handle.
 *  The dedup read runs pre-transaction in sync but inside the import
 *  transaction, so the shared helper accepts both. */
type Executor = DB | Tx;

/** SQLite caps bind parameters at 999; test_states has 9 columns, so 100
 *  rows leaves headroom. Sync replays and seeding both can hit thousands. */
const TEST_STATES_BATCH = 100;

/** `review_events` has 9 columns, so 100 rows/insert stays under the 999
 *  bind-parameter cap. An import can carry tens of thousands of events. */
const REVIEW_EVENTS_BATCH = 100;

/** clientEventIds are one bind parameter each; 500/query is well under the
 *  cap and matches the sync upload ceiling. */
const EVENT_ID_DEDUP_BATCH = 500;

/** Of `clientEventIds`, return the subset already stored for this
 *  (user, material) — the dedup hits. Chunked so a large import stays
 *  under SQLite's bind-parameter cap; sync passes a bounded batch and
 *  benefits from the same chunking for free. Both callers want the
 *  "already seen" set to filter their fresh events. */
export function existingEventIds(
  exec: Executor,
  userId: string,
  materialId: string,
  clientEventIds: string[],
): Set<string> {
  const seen = new Set<string>();
  for (let i = 0; i < clientEventIds.length; i += EVENT_ID_DEDUP_BATCH) {
    const chunk = clientEventIds.slice(i, i + EVENT_ID_DEDUP_BATCH);
    const rows = exec
      .select({ clientEventId: schema.reviewEvents.clientEventId })
      .from(schema.reviewEvents)
      .where(
        and(
          eq(schema.reviewEvents.userId, userId),
          eq(schema.reviewEvents.materialId, materialId),
          inArray(schema.reviewEvents.clientEventId, chunk),
        ),
      )
      .all();
    for (const r of rows) seen.add(r.clientEventId);
  }
  return seen;
}

/** Chunked append of `review_events`. The row `id` is the
 *  `clientEventId` (stable + unique), and `createdAt` is the event's own
 *  timestamp — same convention across the online, sync, and import write
 *  paths. Callers are responsible for dedup (see `existingEventIds`). */
export function writeReviewEvents(tx: Tx, events: ReviewEventInput[]): void {
  for (let i = 0; i < events.length; i += REVIEW_EVENTS_BATCH) {
    const slice = events.slice(i, i + REVIEW_EVENTS_BATCH);
    if (slice.length === 0) continue;
    tx.insert(schema.reviewEvents)
      .values(
        slice.map((e) => ({
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
}

interface UpsertOpts {
  /** When false, plain insert (used for fresh seeding where keys are unique). */
  onConflict: boolean;
}

/** Chunked upsert of `test_states` rows, shared between online review writes,
 *  sync replay, and enrollment seeding. */
export function writeTestStates(
  tx: Tx,
  userId: string,
  materialId: string,
  entries: TestStateEntry[],
  opts: UpsertOpts,
): void {
  if (entries.length === 0) return;
  for (let i = 0; i < entries.length; i += TEST_STATES_BATCH) {
    const slice = entries.slice(i, i + TEST_STATES_BATCH);
    if (slice.length === 0) continue;
    const values = slice.map((s) => ({
      userId,
      materialId,
      testKind: s.test_kind,
      element: JSON.stringify(s.element),
      stability: s.stability,
      difficulty: s.difficulty,
      lastSeenSecs: s.last_seen_secs,
      lastBaseSecs: s.last_base_secs,
      lastRootSecs: s.last_root_secs,
      pendingRelearn: s.pending_relearn ? 1 : 0,
    }));
    const stmt = tx.insert(schema.testStates).values(values);
    if (opts.onConflict) {
      stmt
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
            pendingRelearn: sql`excluded.pending_relearn`,
          },
        })
        .run();
    } else {
      stmt.run();
    }
  }
}

/**
 * Shared write path for online reviews and offline sync replay. Append the
 * events and upsert the touched test_states in one transaction so the event
 * log and the materialised state never drift.
 */
export function persistEngineState(tx: Tx, args: PersistArgs): void {
  const { events, testStateUpdates, userId, materialId } = args;

  writeReviewEvents(tx, events);
  writeTestStates(tx, userId, materialId, testStateUpdates, { onConflict: true });
}
