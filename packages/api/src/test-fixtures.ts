import type { DB } from './db/client.js';
import * as schema from './db/schema.js';
import { enrollUser } from './lib/enrollment.js';

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

  if (opts.createUser ?? true) {
    db.insert(schema.user)
      .values({
        id: userId,
        email: `${userId}@example.com`,
        name: userId,
        emailVerified: false,
        createdAt: new Date(now * 1000),
        updatedAt: new Date(now * 1000),
      })
      .run();
  }

  return enrollUser({ db, userId, materialId, now: () => now });
}
