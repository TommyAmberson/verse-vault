import { describe, expect, it } from 'vitest';

import { createDb } from './client.js';
import { runMigrations } from './migrate.js';
import { user, userMaterials } from './schema.js';

describe('db', () => {
  it('applies migrations to a fresh in-memory db and round-trips a row', () => {
    runMigrations(':memory:');
  });

  it('round-trips user + user_materials with fk cascade', () => {
    // Use a file-backed db so we can re-open and test the shared state.
    // :memory: would give us a fresh db each createDb() call.
    const path = `/tmp/vv-test-${Date.now()}.db`;
    runMigrations(path);

    const db = createDb(path);
    const now = Math.floor(Date.now() / 1000);
    db.insert(user)
      .values({
        id: 'u1',
        email: 'a@b.c',
        name: 'Test',
        emailVerified: false,
        createdAt: new Date(now * 1000),
        updatedAt: new Date(now * 1000),
      })
      .run();
    db.insert(userMaterials)
      .values({ userId: 'u1', materialId: 'nkjv-1cor', clubTier: 150, createdAt: now })
      .run();

    const rows = db.select().from(userMaterials).all();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.materialId).toBe('nkjv-1cor');
  });
});
