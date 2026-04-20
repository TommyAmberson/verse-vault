import Database from 'better-sqlite3';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createTestDb } from '../test-utils.js';

describe('indexes', () => {
  let path: string;
  let cleanup: () => void;
  let sqlite: Database.Database;

  beforeAll(() => {
    const test = createTestDb();
    path = test.path;
    cleanup = test.cleanup;
    sqlite = new Database(path, { readonly: true });
  });

  afterAll(() => {
    sqlite.close();
    cleanup();
  });

  function planFor(sql: string, ...args: unknown[]): string {
    const rows = sqlite.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...args) as Array<{
      detail: string;
    }>;
    return rows.map((r) => r.detail).join(' ');
  }

  it('creates all hot-path indexes', () => {
    const rows = sqlite
      .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE 'idx_%'")
      .all() as Array<{ name: string }>;
    expect(rows.map((r) => r.name).sort()).toEqual(
      [
        'idx_account_provider',
        'idx_graph_snapshots_user_material',
        'idx_review_events_user_material_time',
        'idx_verification_identifier',
      ].sort(),
    );
  });

  it('uses idx_review_events_user_material_time for (user, material) replay', () => {
    expect(
      planFor(
        'SELECT * FROM review_events WHERE user_id = ? AND material_id = ? ORDER BY timestamp_secs',
        'u1',
        'nkjv-1cor',
      ),
    ).toContain('idx_review_events_user_material_time');
  });

  it('uses idx_account_provider for OAuth callback lookups', () => {
    expect(
      planFor('SELECT * FROM account WHERE provider_id = ? AND account_id = ?', 'google', 'x'),
    ).toContain('idx_account_provider');
  });

  it('uses idx_verification_identifier for identifier lookups', () => {
    expect(planFor('SELECT * FROM verification WHERE identifier = ?', 'alice@example.com')).toContain(
      'idx_verification_identifier',
    );
  });
});
