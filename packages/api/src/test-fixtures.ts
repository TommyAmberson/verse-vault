import type { DB } from './db/client.js';
import { enrollUser } from './lib/enrollment.js';
import { createTestUser } from './test-utils.js';

/** A v1-wire schedule: one normal week and one review week, the shape
 *  every schedule was stored in before #103 canonicalised writes.
 *
 *  Shared so the folds that are supposed to agree — `migrateV1Week`,
 *  core's `ScheduleWeekRaw`, and migration 0025's SQL — are compared
 *  against one input rather than per-test copies that can drift apart
 *  silently. */
export const V1_SCHEDULE = {
  version: 1,
  materialId: 'nkjv-cor',
  season: '2025-26',
  title: 'Test',
  meetingDayOfWeek: 'Mon',
  weeks: [
    {
      date: '2025-09-08',
      passage: { book: '1 Corinthians', chapter: 1, startVerse: 1, endVerse: 31 },
      verses: { club150: [5, 10], club300: [1, 2] },
      isReview: false,
    },
    {
      date: '2025-11-17',
      passage: null,
      verses: null,
      isReview: true,
    },
  ],
  meets: [],
};

export interface SeedOptions {
  db: DB;
  userId: string;
  materialId: string;
  /** Off when the user already exists (e.g. created by Better Auth sign-up). */
  createUser?: boolean;
}

/**
 * Test helper: enrolls a user in the placeholder `nkjv-cor` material,
 * optionally creating the user row first (for tests that don't sign up
 * via Better Auth).
 */
export function seedUserWithFixture(opts: SeedOptions): { snapshotId: string; version: number } {
  const { db, userId, materialId } = opts;
  const now = Math.floor(Date.now() / 1000);

  if (opts.createUser ?? true) createTestUser(db, userId);

  return enrollUser({ db, userId, materialId, now: () => now });
}
