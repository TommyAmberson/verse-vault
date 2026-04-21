import type { DB } from './db/client.js';
import { enrollUser } from './lib/enrollment.js';
import { createTestUser } from './test-utils.js';

export interface SeedOptions {
  db: DB;
  userId: string;
  materialId: string;
  /** Off when the user already exists (e.g. created by Better Auth sign-up). */
  createUser?: boolean;
}

/**
 * Test helper: enrolls a user in the placeholder `nkjv-1cor` material,
 * optionally creating the user row first (for tests that don't sign up
 * via Better Auth).
 */
export function seedUserWithFixture(opts: SeedOptions): { snapshotId: string; version: number } {
  const { db, userId, materialId } = opts;
  const now = Math.floor(Date.now() / 1000);

  if (opts.createUser ?? true) createTestUser(db, userId);

  return enrollUser({ db, userId, materialId, now: () => now });
}
