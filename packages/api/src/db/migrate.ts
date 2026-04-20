import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { migrate } from 'drizzle-orm/better-sqlite3/migrator';

import { createDb } from './client.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

export function runMigrations(dbPath: string) {
  const db = createDb(dbPath);
  // Migrations live at packages/api/migrations/ — resolve relative to this file
  // so it works from both src/ (tsx dev) and dist/ (built).
  const migrationsFolder = resolve(__dirname, '../../migrations');
  migrate(db, { migrationsFolder });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const dbPath = process.env.DATABASE_PATH ?? resolve(__dirname, '../../data/verse-vault.db');
  runMigrations(dbPath);
  console.log(`Migrations applied to ${dbPath}`);
}
