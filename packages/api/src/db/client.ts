import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';

import * as schema from './schema.js';

export type DB = ReturnType<typeof createDb>;

/** The narrower handle drizzle's `db.transaction` callback receives. It
 *  shares the table API (insert/update/select/delete), so helpers can
 *  accept `DB | Tx` and run inside or outside a transaction. */
export type Tx = Parameters<Parameters<DB['transaction']>[0]>[0];

export function createDb(dbPath: string) {
  const sqlite = new Database(dbPath);
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('foreign_keys = ON');
  return drizzle(sqlite, { schema });
}
