import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createApp } from './app.js';
import { type DB, createDb } from './db/client.js';
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
