import { and, eq, sql } from 'drizzle-orm';

import type { DB } from '../db/client.js';
import * as schema from '../db/schema.js';

/**
 * Opaque fingerprint of one (user, material)'s server-side engine state:
 * the review-event log plus both graduation logs. Clients cache the sync
 * state in IndexedDB and normally never refetch; comparing this value
 * against the one stored with the cached snapshot is how they detect
 * that the server's state moved underneath them — another device
 * synced, or an operator repaired rows directly (#126 cleanup) — and
 * refetch instead of serving the stale cache forever.
 *
 * Count + max + sum per table so both additions and deletions move the
 * value: a deletion drops the count, an insertion moves the sum even
 * when the max stays put. Purely derived — no schema change, no write
 * amplification — at the cost of three indexed aggregate scans per
 * call, which is fine at this endpoint's per-navigation call rate.
 *
 * Deliberately NOT covered: `test_states` edited without touching the
 * event/graduation logs. States are a materialised view of the logs, so
 * any legitimate repair touches the logs too.
 */
export function computeStateRev(db: DB, userId: string, materialId: string): string {
  const events = db
    .select({
      n: sql<number>`COUNT(*)`,
      max: sql<number>`COALESCE(MAX(${schema.reviewEvents.createdAt}), 0)`,
      sum: sql<number>`COALESCE(SUM(${schema.reviewEvents.timestampSecs}), 0)`,
    })
    .from(schema.reviewEvents)
    .where(
      and(
        eq(schema.reviewEvents.userId, userId),
        eq(schema.reviewEvents.materialId, materialId),
      ),
    )
    .get();
  const verses = db
    .select({
      n: sql<number>`COUNT(*)`,
      max: sql<number>`COALESCE(MAX(${schema.graduatedVerses.graduatedAtSecs}), 0)`,
      sum: sql<number>`COALESCE(SUM(${schema.graduatedVerses.verseId}), 0)`,
    })
    .from(schema.graduatedVerses)
    .where(
      and(
        eq(schema.graduatedVerses.userId, userId),
        eq(schema.graduatedVerses.materialId, materialId),
      ),
    )
    .get();
  const cards = db
    .select({
      n: sql<number>`COUNT(*)`,
      max: sql<number>`COALESCE(MAX(${schema.graduatedCards.graduatedAtSecs}), 0)`,
      sum: sql<number>`COALESCE(SUM(${schema.graduatedCards.cardId}), 0)`,
    })
    .from(schema.graduatedCards)
    .where(
      and(
        eq(schema.graduatedCards.userId, userId),
        eq(schema.graduatedCards.materialId, materialId),
      ),
    )
    .get();

  const parts = [events, verses, cards].flatMap((r) => [r?.n ?? 0, r?.max ?? 0, r?.sum ?? 0]);
  return parts.join(':');
}
