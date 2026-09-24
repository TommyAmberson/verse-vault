/**
 * Events sync took but did not apply. The upload route never refuses an
 * event: one it cannot apply now is stored here with a reason, so the
 * device can forget it and the work rests on the server. Engine build
 * promotes rows that have become applicable; the merge-confirmation
 * route promotes or discards the ones awaiting the learner.
 *
 * See specs/002-resilient-sync-ingest/data-model.md for the lifecycle.
 */

import { randomUUID } from 'node:crypto';

import { and, asc, count, eq, inArray, min, sql } from 'drizzle-orm';

import type { DB, Tx } from '../db/client.js';
import {
  type PendingReasonCode,
  type PendingStatus,
  pendingEvents,
  reviewEvents,
} from '../db/schema.js';
import type { UserMaterial } from './keys.js';
import { writeGraduatedCard, writeGraduatedVerse, writeReviewEvents } from './review-log.js';
import {
  eventKind,
  type GraduateCardEventUpload,
  type GraduateEventUpload,
  type ReviewEventUpload,
  type SyncEventUpload,
} from './sync-events.js';


export type PendingRow = typeof pendingEvents.$inferSelect;

export interface TakeInput {
  clientEventId: string | null;
  kind: string | null;
  timestampSecs: number | null;
  /** The event as uploaded. Stored verbatim so promotion needs no
   *  reconstruction, and so an operator sees exactly what arrived. */
  payload: unknown;
  status: 'pending' | 'unusable';
  reasonCode: PendingReasonCode;
  reason: string;
}

/** Store events taken but not applied. Returns how many rows were new;
 *  an event already held under the same clientEventId is left as it was,
 *  so a retried upload cannot duplicate or overwrite one. */
export function take(
  db: DB | Tx,
  key: UserMaterial,
  events: TakeInput[],
  nowSecs: number,
): number {
  if (events.length === 0) return 0;
  const result = db
    .insert(pendingEvents)
    .values(
      events.map((e) => ({
        id: randomUUID(),
        userId: key.userId,
        materialId: key.materialId,
        clientEventId: e.clientEventId,
        kind: e.kind,
        timestampSecs: e.timestampSecs,
        payloadJson: JSON.stringify(e.payload),
        status: e.status,
        reasonCode: e.reasonCode,
        reason: e.reason,
        receivedAt: nowSecs,
      })),
    )
    .onConflictDoNothing()
    .run();
  return result.changes;
}

/** Which of `clientEventIds` this account already holds here, in any
 *  status. The upload route unions this with review_events so a retry
 *  of an event that is waiting is a duplicate, not a second row. */
export function heldClientEventIds(
  db: DB,
  key: UserMaterial,
  clientEventIds: string[],
): Set<string> {
  if (clientEventIds.length === 0) return new Set();
  const rows = db
    .select({ clientEventId: pendingEvents.clientEventId })
    .from(pendingEvents)
    .where(
      and(
        eq(pendingEvents.userId, key.userId),
        eq(pendingEvents.materialId, key.materialId),
        inArray(pendingEvents.clientEventId, clientEventIds),
      ),
    )
    .all();
  return new Set(rows.map((r) => r.clientEventId).filter((id): id is string => id !== null));
}

function promotableWhere(key: UserMaterial, codes: PendingReasonCode[]) {
  return and(
    eq(pendingEvents.userId, key.userId),
    eq(pendingEvents.materialId, key.materialId),
    eq(pendingEvents.status, 'pending'),
    inArray(pendingEvents.reasonCode, codes),
  );
}

/** Cheap guard for the engine-build path: one indexed probe, so the
 *  common case of nothing pending costs nothing more. */
export function hasPromotable(db: DB, key: UserMaterial, codes: PendingReasonCode[]): boolean {
  const row = db
    .select({ id: pendingEvents.id })
    .from(pendingEvents)
    .where(promotableWhere(key, codes))
    .limit(1)
    .get();
  return row !== undefined;
}

/**
 * Offer every pending row with one of `codes` to `apply`, in recorded
 * order, and delete the rows it applied. `apply` writes the real row
 * with the same transaction handle and returns whether it did; the
 * delete runs in that same transaction, so a pending row and its applied
 * copy never both exist, and a throw rolls the whole promotion back.
 */
export function promote(
  db: DB,
  key: UserMaterial,
  codes: PendingReasonCode[],
  apply: (tx: Tx, row: PendingRow) => boolean,
): PendingRow[] {
  return db.transaction((tx) => {
    const candidates = tx
      .select()
      .from(pendingEvents)
      .where(promotableWhere(key, codes))
      .orderBy(asc(pendingEvents.timestampSecs), asc(pendingEvents.clientEventId))
      .all();
    const promoted = candidates.filter((row) => apply(tx, row));
    const ids = (rows: PendingRow[]) => rows.map((r) => r.id);
    const repaired = promoted.filter((r) => r.repairedBy !== null);
    const plain = promoted.filter((r) => r.repairedBy === null);
    if (plain.length > 0) {
      tx.delete(pendingEvents).where(inArray(pendingEvents.id, ids(plain))).run();
    }
    // A repaired row is the only record of what arrived and what changed
    // it, so it stays, marked applied. Its client id stays held, so a
    // re-upload is a duplicate rather than a second application.
    if (repaired.length > 0) {
      tx.update(pendingEvents)
        .set({ status: 'repaired' })
        .where(inArray(pendingEvents.id, ids(repaired)))
        .run();
    }
    return promoted;
  });
}

/**
 * Write a held event to the table it would have landed in had it been
 * applied on arrival, at the time it was recorded (FR-016): a review
 * joins the log at its own timestamp, so replay orders it exactly as if
 * it had never waited. Returns false for a row that is not a well-formed
 * event, which stays where it is.
 */
export function writeApplied(tx: Tx, key: UserMaterial, row: PendingRow): boolean {
  if (row.clientEventId === null || row.timestampSecs === null) return false;
  const e = JSON.parse(row.payloadJson) as SyncEventUpload;
  const atSecs = row.timestampSecs;
  switch (eventKind(e)) {
    case 'review': {
      const r = e as ReviewEventUpload;
      // An id already in the log means the event already applied: that
      // is success, not a conflict that could fail the build promoting it.
      writeReviewEvents(
        tx,
        [
          {
            ...key,
            snapshotVersion: r.snapshotVersion,
            timestampSecs: atSecs,
            cardId: r.cardId,
            grade: r.grade,
            clientEventId: row.clientEventId,
          },
        ],
        { ignoreDuplicates: true },
      );
      return true;
    }
    case 'graduate':
      writeGraduatedVerse(tx, key, (e as GraduateEventUpload).verseId, atSecs);
      return true;
    case 'graduateCard':
      writeGraduatedCard(tx, key, (e as GraduateCardEventUpload).cardId, atSecs);
      return true;
    default:
      return false;
  }
}

function awaitingWhere(key: UserMaterial) {
  return and(
    eq(pendingEvents.userId, key.userId),
    eq(pendingEvents.materialId, key.materialId),
    eq(pendingEvents.status, 'pending'),
    eq(pendingEvents.reasonCode, 'awaiting-confirmation'),
  );
}

/** The open merge question for this account and material, or `null`
 *  when there is none. The caller adds the server-history side
 *  (`serverEventsSince`, `newestServerTs`), which lives in review_events. */
export function summariseAwaitingConfirmation(
  db: DB,
  key: UserMaterial,
): { queuedCount: number; oldestQueuedTs: number } | null {
  const row = db
    .select({ queuedCount: count(), oldestQueuedTs: min(pendingEvents.timestampSecs) })
    .from(pendingEvents)
    .where(awaitingWhere(key))
    .get();
  if (!row || row.queuedCount === 0) return null;
  return { queuedCount: row.queuedCount, oldestQueuedTs: row.oldestQueuedTs ?? 0 };
}

export function serverEventsSince(db: DB, key: UserMaterial, sinceTs: number): number {
  const row = db
    .select({ count: sql<number>`COUNT(*)` })
    .from(reviewEvents)
    .where(
      and(
        eq(reviewEvents.userId, key.userId),
        eq(reviewEvents.materialId, key.materialId),
        sql`${reviewEvents.timestampSecs} > ${sinceTs}`,
      ),
    )
    .get();
  return row?.count ?? 0;
}

/** The open merge question for this account and material, or `null`.
 *  One shape for the upload's `staleSummary`, and for the
 *  `pendingConfirmation` on GET /state and /api/years, so the modal reads
 *  the same wherever it was raised. */
export interface MergeQuestion {
  queuedCount: number;
  serverEventsSince: number;
  oldestQueuedTs: number;
  newestServerTs: number;
}

export function mergeQuestion(db: DB, key: UserMaterial): MergeQuestion | null {
  const held = summariseAwaitingConfirmation(db, key);
  if (!held) return null;
  const newestRow = db
    .select({ ts: sql<number>`MAX(${reviewEvents.timestampSecs})` })
    .from(reviewEvents)
    .where(
      and(
        eq(reviewEvents.userId, key.userId),
        eq(reviewEvents.materialId, key.materialId),
      ),
    )
    .get();
  return {
    queuedCount: held.queuedCount,
    serverEventsSince: serverEventsSince(db, key, held.oldestQueuedTs),
    oldestQueuedTs: held.oldestQueuedTs,
    newestServerTs: newestRow?.ts ?? held.oldestQueuedTs,
  };
}

/** The learner chose to discard the work awaiting confirmation. Kept,
 *  marked discarded, so a mistaken discard is recoverable by an
 *  operator. Returns how many rows were marked. */
export function markDiscarded(db: DB | Tx, key: UserMaterial): number {
  return db
    .update(pendingEvents)
    .set({ status: 'discarded' })
    .where(awaitingWhere(key))
    .run().changes;
}

export interface OperatorCount {
  userId: string;
  materialId: string;
  status: PendingStatus;
  reasonCode: PendingReasonCode;
  count: number;
}

/** Everything taken but not applied, grouped for an operator. Empty
 *  when nothing is stranded, which is the answer worth seeing plainly. */
export function countForOperator(db: DB): OperatorCount[] {
  return db
    .select({
      userId: pendingEvents.userId,
      materialId: pendingEvents.materialId,
      status: pendingEvents.status,
      reasonCode: pendingEvents.reasonCode,
      count: sql<number>`count(*)`,
    })
    .from(pendingEvents)
    .groupBy(
      pendingEvents.userId,
      pendingEvents.materialId,
      pendingEvents.status,
      pendingEvents.reasonCode,
    )
    .orderBy(
      asc(pendingEvents.userId),
      asc(pendingEvents.materialId),
      asc(pendingEvents.status),
      asc(pendingEvents.reasonCode),
    )
    .all();
}
