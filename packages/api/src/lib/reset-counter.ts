import { eq, sql } from 'drizzle-orm';

import type { DB } from '../db/client.js';
import * as schema from '../db/schema.js';

/** Carries the counter both ways (spec 007): on requests, the value the
 *  client last saw; on responses, `<userId>:<counter>`, the account's
 *  current value. */
export const RESET_COUNTER_HEADER = 'X-Reset-Epoch';

/** The account's current reset counter; 0 for an account never wiped. */
export function currentResetCounter(db: DB, userId: string): number {
  const row = db
    .select({ counter: schema.resetCounters.counter })
    .from(schema.resetCounters)
    .where(eq(schema.resetCounters.userId, userId))
    .get();
  return row?.counter ?? 0;
}

/** Move the account's counter on by one and return the new value. A wipe
 *  calls this before clearing anything, so every write that takes a deck's
 *  lock after the wipe starts sees the new value. */
export function advanceResetCounter(db: DB, userId: string): number {
  const row = db
    .insert(schema.resetCounters)
    .values({ userId, counter: 1 })
    .onConflictDoUpdate({
      target: schema.resetCounters.userId,
      set: { counter: sql`${schema.resetCounters.counter} + 1` },
    })
    .returning({ counter: schema.resetCounters.counter })
    .get();
  return row.counter;
}

/**
 * Whether a progress write must be refused: the request sent a counter and
 * it isn't the account's current one. Returns the current counter for the
 * refusal, or null to go ahead.
 */
export function staleResetCounter(
  db: DB,
  userId: string,
  sent: string | undefined,
): number | null {
  // TODO(spec 007 FR-008): refuse a missing counter once older web clients
  // have had a release to update.
  if (sent === undefined) return null;
  const current = currentResetCounter(db, userId);
  return Number(sent) === current ? null : current;
}
