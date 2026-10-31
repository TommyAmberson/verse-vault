import { eq, sql } from 'drizzle-orm';
import type { Context } from 'hono';

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

/** Move the account's counter on by one. */
function advanceResetCounter(db: DB, userId: string): void {
  db.insert(schema.resetCounters)
    .values({ userId, counter: 1 })
    .onConflictDoUpdate({
      target: schema.resetCounters.userId,
      set: { counter: sql`${schema.resetCounters.counter} + 1` },
    })
    .run();
}

// Wipes running in this process, by account: the counter they started from
// and how many are running. The API is one process, as its per-deck locks
// already assume.
const wipesRunning = new Map<string, { before: number; running: number }>();

/**
 * Run a wipe: the counter moves on first, so any write sent against the old
 * value that takes a deck's lock from here on is refused, but responses keep
 * announcing the old value until the wipe is done. A client therefore only
 * catches up once nothing more will be cleared, and nothing it writes after
 * catching up can be caught by the wipe still running.
 */
export async function duringWipe<T>(db: DB, userId: string, wipe: () => Promise<T>): Promise<T> {
  const entry = wipesRunning.get(userId) ?? { before: currentResetCounter(db, userId), running: 0 };
  entry.running += 1;
  wipesRunning.set(userId, entry);
  try {
    advanceResetCounter(db, userId);
    return await wipe();
  } finally {
    entry.running -= 1;
    if (entry.running === 0) wipesRunning.delete(userId);
  }
}

/** The counter responses announce: the current one, or while a wipe runs,
 *  the one it started from. */
export function announcedResetCounter(db: DB, userId: string): number {
  return wipesRunning.get(userId)?.before ?? currentResetCounter(db, userId);
}

/**
 * Refuse a progress write sent against an older counter: the account was
 * wiped after the client last heard from it, so what it sends predates the
 * wipe (spec 007). Returns the 409 to send, or null to go ahead; the
 * current counter reaches the client in the response header. Call it
 * with no await between the check and the write it guards.
 */
export function refuseIfReset(c: Context, db: DB, userId: string): Response | null {
  const sent = c.req.header(RESET_COUNTER_HEADER);
  // TODO(#199): refuse a missing counter once older web clients have had a
  // release to update (spec 007 FR-008).
  if (sent === undefined) return null;
  const current = currentResetCounter(db, userId);
  if (Number(sent) === current) return null;
  return c.json(
    { error: 'This account was reset on another device; reload to continue.', code: 'reset' },
    409,
  );
}
