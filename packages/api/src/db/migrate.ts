import { resolve } from 'node:path';

import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';

// Resolved relative to this file so it works from both src/ (tsx dev) and
// dist/ (built).
const MIGRATIONS_FOLDER = resolve(import.meta.dirname, '../../migrations');

export function runMigrations(dbPath: string) {
  const sqlite = new Database(dbPath);
  try {
    migrate(drizzle(sqlite), { migrationsFolder: MIGRATIONS_FOLDER });
  } finally {
    sqlite.close();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const dbPath = process.env.DATABASE_PATH ?? resolve(import.meta.dirname, '../../data/verse-vault.db');
  runMigrations(dbPath);
  console.log(`Migrations applied to ${dbPath}`);
}
