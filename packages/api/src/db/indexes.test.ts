import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

import { runMigrations } from './migrate.js';

describe('indexes', () => {
  it('creates user+material indexes on review_events and graph_snapshots', () => {
    const path = `/tmp/vv-idx-test-${Date.now()}.db`;
    runMigrations(path);

    const sqlite = new Database(path);
    const indexes = sqlite
      .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE 'idx_%'")
      .all() as Array<{ name: string }>;
    const names = indexes.map((i) => i.name).sort();
    sqlite.close();

    expect(names).toEqual(
      ['idx_graph_snapshots_user_material', 'idx_review_events_user_material_time'].sort(),
    );
  });

  it('uses the review_events index for (user_id, material_id) replay queries', () => {
    const path = `/tmp/vv-idx-plan-${Date.now()}.db`;
    runMigrations(path);

    const sqlite = new Database(path);
    const plan = sqlite
      .prepare(
        'EXPLAIN QUERY PLAN SELECT * FROM review_events WHERE user_id = ? AND material_id = ? ORDER BY timestamp_secs',
      )
      .all('u1', 'nkjv-1cor') as Array<{ detail: string }>;
    sqlite.close();

    const detail = plan.map((p) => p.detail).join(' ');
    expect(detail).toContain('idx_review_events_user_material_time');
  });
});
