import { type SQL, and, eq, sql } from 'drizzle-orm';

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
 * Count + max + sum per table so every repair shape moves the value: a
 * deletion drops the count, an insertion moves the sum even when the
 * max stays put, and folding `card_id + grade` into the events sum
 * catches in-place UPDATE repairs and same-timestamp replacements too. Purely
 * derived — no schema change, no write amplification — and each
 * aggregate is a covering-index scan (migration 0026 for the events
 * one), so the per-navigation /api/years call stays cheap as the log
 * grows.
 *
 * Deliberately NOT covered: `test_states` edited without touching the
 * event/graduation logs. States are a materialised view of the logs, so
 * a repair that only rewrites states diverges from its own source of
 * truth and needs a rebuild, not a client refetch.
 */
export function computeStateRev(db: DB, userId: string, materialId: string): string {
  const agg = (
    table: typeof schema.reviewEvents | typeof schema.graduatedVerses | typeof schema.graduatedCards,
    max: SQL<number>,
    sum: SQL<number>,
  ) =>
    db
      .select({ n: sql<number>`COUNT(*)`, max, sum })
      .from(table)
      .where(and(eq(table.userId, userId), eq(table.materialId, materialId)))
      .get();

  const e = schema.reviewEvents;
  const v = schema.graduatedVerses;
  const c = schema.graduatedCards;
  const parts = [
    agg(
      e,
      sql<number>`COALESCE(MAX(${e.timestampSecs}), 0)`,
      sql<number>`COALESCE(SUM(${e.timestampSecs} + ${e.cardId} + ${e.grade}), 0)`,
    ),
    agg(
      v,
      sql<number>`COALESCE(MAX(${v.graduatedAtSecs}), 0)`,
      sql<number>`COALESCE(SUM(${v.verseId}), 0)`,
    ),
    agg(
      c,
      sql<number>`COALESCE(MAX(${c.graduatedAtSecs}), 0)`,
      sql<number>`COALESCE(SUM(${c.cardId}), 0)`,
    ),
  ].flatMap((r) => [r?.n ?? 0, r?.max ?? 0, r?.sum ?? 0]);
  return parts.join(':');
}
