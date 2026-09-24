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

import { and, asc, count, eq, inArray, isNull, min, ne, or, sql } from 'drizzle-orm';
import type { WasmEngine } from 'verse-vault-wasm';

import type { DB, Tx } from '../db/client.js';
import {
  type PendingReasonCode,
  type PendingStatus,
  pendingEvents,
  reviewEvents,
} from '../db/schema.js';
import type { CardIdClass } from './engine.js';
import type { UserMaterial } from './keys.js';
import { type Repair, repairEpoch } from './repairs.js';
import {
  existingEventIds,
  writeGraduatedCard,
  writeGraduatedVerse,
  writeReviewEvents,
} from './review-log.js';
import {
  cardIdOf,
  eventKind,
  parseUpload,
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
  db: DB | Tx,
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

function promotableWhere(key: UserMaterial, codes: readonly PendingReasonCode[]) {
  return and(
    eq(pendingEvents.userId, key.userId),
    eq(pendingEvents.materialId, key.materialId),
    eq(pendingEvents.status, 'pending'),
    inArray(pendingEvents.reasonCode, codes),
  );
}

/** Cheap guard for the engine-build path: one indexed probe, so the
 *  common case of nothing pending costs nothing more. */
export function hasPromotable(
  db: DB,
  key: UserMaterial,
  codes: readonly PendingReasonCode[],
): boolean {
  const row = db
    .select({ id: pendingEvents.id })
    .from(pendingEvents)
    .where(promotableWhere(key, codes))
    .limit(1)
    .get();
  return row !== undefined;
}

function heldRows(tx: Tx, key: UserMaterial, codes: readonly PendingReasonCode[]): PendingRow[] {
  return tx
    .select()
    .from(pendingEvents)
    .where(promotableWhere(key, codes))
    .orderBy(asc(pendingEvents.timestampSecs), asc(pendingEvents.clientEventId))
    .all();
}

/** Retire rows whose real row was just written. A plain row is deleted,
 *  so the pair never coexists. A repaired row is the only record of what
 *  arrived and what changed it, so it stays, marked applied; its client
 *  id stays held, so a re-upload is a duplicate, not a second apply. */
function finishPromoted(tx: Tx, promoted: PendingRow[]): void {
  const ids = (rows: PendingRow[]) => rows.map((r) => r.id);
  const repaired = promoted.filter((r) => r.repairedBy !== null);
  const plain = promoted.filter((r) => r.repairedBy === null);
  if (plain.length > 0) {
    tx.delete(pendingEvents).where(inArray(pendingEvents.id, ids(plain))).run();
  }
  if (repaired.length > 0) {
    tx.update(pendingEvents)
      .set({ status: 'repaired' })
      .where(inArray(pendingEvents.id, ids(repaired)))
      .run();
  }
}

/**
 * Write a held event to the table it would have landed in had it been
 * applied on arrival, at the time it was recorded (FR-016): a review
 * joins the log at its own timestamp, so replay orders it exactly as if
 * it had never waited. Returns false for a row that is not a well-formed
 * event, which stays where it is.
 */
function writeApplied(tx: Tx, key: UserMaterial, row: PendingRow): boolean {
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

/** What becomes of a well-formed event, given how its card classifies. */
export type Verdict =
  | { apply: true }
  | { apply: false; status: 'pending' | 'unusable'; reasonCode: PendingReasonCode; reason: string };

/**
 * The one rule for whether an event applies, waits, or is unusable,
 * shared by the upload, promotion and repairs so the three can never
 * disagree. A card the learner's config emits applies; one only some
 * other config emits waits; one no config emits is unusable. A verse
 * graduation names no card and always applies. An id missing from
 * `classes` is treated as unknown rather than guessed at.
 */
export function judge(e: SyncEventUpload, classes: ReadonlyMap<number, CardIdClass>): Verdict {
  const cardId = cardIdOf(e);
  if (cardId === null) return { apply: true };
  switch (classes.get(cardId) ?? 'unknown') {
    case 'emitted':
      return { apply: true };
    case 'not-emitted':
      return {
        apply: false,
        status: 'pending',
        reasonCode: 'card-not-emitted',
        reason: `card id ${cardId} is not emitted by the current config`,
      };
    case 'unknown':
      return {
        apply: false,
        status: 'unusable',
        reasonCode: 'card-unknown',
        reason: `card id ${cardId} is not produced by any config for this deck`,
      };
  }
}

/** Which of `clientEventIds` this account already holds for the
 *  material, applied or held. The upload's dedup set, and the check a
 *  repair's newly assigned id must pass. */
export function takenClientEventIds(
  db: DB | Tx,
  key: UserMaterial,
  clientEventIds: string[],
): Set<string> {
  const taken = existingEventIds(db, key.userId, key.materialId, clientEventIds);
  for (const id of heldClientEventIds(db, key, clientEventIds)) taken.add(id);
  return taken;
}

/** Pending reasons an engine build resolves by itself. `awaiting-
 *  confirmation` is deliberately absent: it waits for the learner's
 *  answer, however applicable it is (spec FR-007). */
const BUILD_RESOLVES: readonly PendingReasonCode[] = ['card-not-emitted', 'not-enrolled'];

export interface ResolveContext {
  /** The learner's freshly built engine, under their current config. */
  engine: WasmEngine;
  repairs: readonly Repair[];
  classify: (cardIds: number[]) => ReadonlyMap<number, CardIdClass>;
  nowSecs: number;
}

/**
 * Everything an engine build does with held events, in order:
 *
 * 1. Offer shipped repairs to unusable rows this set of repairs has not
 *    seen (research D9). A fix makes the row pending.
 * 2. Re-judge every row a build resolves (`rejudgeHeld`). One whose card
 *    no config emits any more is demoted to unusable, where step 1 of a
 *    later build can reach it.
 *
 * Returns the rows applied. The common case of nothing held costs two
 * indexed probes.
 */
export function resolveHeld(db: DB, key: UserMaterial, ctx: ResolveContext): PendingRow[] {
  repairUnusable(db, key, ctx);
  return rejudgeHeld(db, key, BUILD_RESOLVES, ctx.classify);
}

/**
 * Re-judge every held row with one of `codes`, in one transaction. A row
 * that now applies is written to its real table at its recorded time
 * (FR-016) and retired; one that still waits keeps an up-to-date reason;
 * one whose card no config emits any more is demoted to unusable, where
 * repairs can reach it. Returns the rows applied.
 */
export function rejudgeHeld(
  db: DB,
  key: UserMaterial,
  codes: readonly PendingReasonCode[],
  classify: ResolveContext['classify'],
): PendingRow[] {
  if (!hasPromotable(db, key, codes)) return [];
  return db.transaction((tx) => {
    const rows = heldRows(tx, key, codes);
    const events = rows.map((r) => JSON.parse(r.payloadJson) as SyncEventUpload);
    const classes = classify(events.map(cardIdOf).filter((id): id is number => id !== null));
    const applied: PendingRow[] = [];
    rows.forEach((row, i) => {
      const verdict = judge(events[i], classes);
      if (verdict.apply) {
        if (writeApplied(tx, key, row)) applied.push(row);
        return;
      }
      if (verdict.status === row.status && verdict.reasonCode === row.reasonCode) return;
      tx.update(pendingEvents)
        .set({
          status: verdict.status,
          reasonCode: verdict.reasonCode,
          reason: verdict.reason,
          // A row newly unusable has not been offered this set of repairs.
          ...(verdict.status === 'unusable' ? { repairEpoch: null } : {}),
        })
        .where(eq(pendingEvents.id, row.id))
        .run();
    });
    finishPromoted(tx, applied);
    return applied;
  });
}

/** Step 1 of `resolveHeld`, in one transaction. Every row offered is
 *  stamped with the current epoch, so each repair runs once per row. */
function repairUnusable(db: DB, key: UserMaterial, ctx: ResolveContext): void {
  const epoch = repairEpoch(ctx.repairs);
  const rows = db
    .select()
    .from(pendingEvents)
    .where(
      and(
        eq(pendingEvents.userId, key.userId),
        eq(pendingEvents.materialId, key.materialId),
        eq(pendingEvents.status, 'unusable'),
        or(isNull(pendingEvents.repairEpoch), ne(pendingEvents.repairEpoch, epoch)),
      ),
    )
    .all();
  if (rows.length === 0) return;
  const repaired: { row: PendingRow; fix: RepairFix }[] = [];
  db.transaction((tx) => {
    for (const row of rows) {
      const fix = firstRepair(tx, key, row, ctx);
      tx.update(pendingEvents)
        .set(
          fix
            ? {
                payloadJson: JSON.stringify(fix.event),
                // The upload, even when an earlier repair already rewrote it.
                originalPayloadJson: row.originalPayloadJson ?? row.payloadJson,
                repairedBy: fix.repairId,
                clientEventId: fix.event.clientEventId,
                kind: eventKind(fix.event),
                timestampSecs: fix.event.timestampSecs,
                // Provisional: step 2 re-judges it in this same build.
                status: 'pending',
                reasonCode: 'card-not-emitted',
                reason: `repaired by ${fix.repairId}`,
                repairEpoch: epoch,
              }
            : { repairEpoch: epoch },
        )
        .where(eq(pendingEvents.id, row.id))
        .run();
      if (fix) repaired.push({ row, fix });
    }
  });
  for (const { row, fix } of repaired) {
    console.warn(
      JSON.stringify({
        event: 'engine.event_repaired',
        userId: key.userId,
        materialId: key.materialId,
        pendingId: row.id,
        clientEventId: fix.event.clientEventId,
        repairId: fix.repairId,
      }),
    );
  }
}

interface RepairFix {
  repairId: string;
  event: SyncEventUpload;
}

/** The first shipped repair whose output parses as an upload would and
 *  is not judged unusable, or `null`. */
function firstRepair(
  tx: Tx,
  key: UserMaterial,
  row: PendingRow,
  ctx: ResolveContext,
): RepairFix | null {
  for (const r of ctx.repairs) {
    let out: unknown;
    try {
      out = r.repair(JSON.parse(row.payloadJson), { key, engine: ctx.engine });
    } catch (err) {
      console.error(`pending-events: repair ${r.id} threw on pending event ${row.id}`, err);
      continue;
    }
    if (out === null || out === undefined) continue;
    const event = parseUpload(out, ctx.nowSecs).event;
    if (!event) continue;
    // An id the event already had is its identity; one it lacked must
    // not collide with an event either table already holds.
    if (row.clientEventId !== null) {
      if (event.clientEventId !== row.clientEventId) continue;
    } else if (takenClientEventIds(tx, key, [event.clientEventId]).size > 0) {
      continue;
    }
    const cardId = cardIdOf(event);
    const verdict = judge(event, ctx.classify(cardId === null ? [] : [cardId]));
    if (!verdict.apply && verdict.status === 'unusable') continue;
    return { repairId: r.id, event };
  }
  return null;
}
