import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect } from 'vitest';

import { createApp } from './app.js';
import { type DB, createDb } from './db/client.js';
import { user } from './db/schema.js';
import { runMigrations } from './db/migrate.js';

export const TEST_AUTH_ENV = {
  baseUrl: 'http://localhost:3000',
  secret: 'test-secret-at-least-32-chars-long-xxxxxxxx',
  webOrigin: 'http://localhost:5173',
};

export interface TestDb {
  db: DB;
  path: string;
  dir: string;
  cleanup: () => void;
}

/// Creates a fresh migrated SQLite database in its own temp directory.
/// The `dir` holds the main `.db`, the `-wal`, and the `-shm` sidecars;
/// `cleanup()` removes the whole dir.
export function createTestDb(): TestDb {
  const dir = mkdtempSync(join(tmpdir(), 'vv-test-'));
  const path = join(dir, 'test.db');
  runMigrations(path);
  return {
    db: createDb(path),
    path,
    dir,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

export function createTestApp() {
  const test = createTestDb();
  const app = createApp({ db: test.db, authEnv: TEST_AUTH_ENV });
  return { app, ...test };
}

export type TestApp = ReturnType<typeof createTestApp>;

/** Inserts a bare user row for tests that don't need a Better Auth session. */
export function createTestUser(db: DB, userId: string): void {
  const now = Math.floor(Date.now() / 1000);
  db.insert(user)
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

/** Creates a user via Better Auth's email sign-up and returns the session cookie + user id. */
export async function signUpTestUser(
  test: TestApp,
  email: string,
  password = 'superSecret123!',
): Promise<{ cookie: string; userId: string }> {
  const res = await test.app.request('/api/auth/sign-up/email', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password, name: email }),
  });
  expect(res.status).toBe(200);
  const cookie = res.headers.get('set-cookie')!;
  const row = test.db
    .select()
    .from(user)
    .all()
    .find((r) => r.email === email);
  if (!row) throw new Error(`user not found: ${email}`);
  return { cookie, userId: row.id };
}

/** Hits POST /api/materials/enroll and asserts success. */
export async function enrollViaApi(
  test: TestApp,
  cookie: string,
  materialId: string,
  clubTier: number | null = null,
): Promise<void> {
  const res = await test.app.request('/api/materials/enroll', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', cookie },
    body: JSON.stringify({ materialId, clubTier }),
  });
  expect(res.status).toBe(200);
}
