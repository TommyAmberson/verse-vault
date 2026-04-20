import { afterEach, describe, expect, it } from 'vitest';

import { createTestDb } from '../test-utils.js';
import { user, userMaterials } from './schema.js';

describe('db', () => {
  let cleanup: (() => void) | null = null;
  afterEach(() => {
    cleanup?.();
    cleanup = null;
  });

  it('round-trips user + user_materials', () => {
    const test = createTestDb();
    cleanup = test.cleanup;

    const now = Math.floor(Date.now() / 1000);
    test.db
      .insert(user)
      .values({
        id: 'u1',
        email: 'alice@example.com',
        name: 'Test',
        emailVerified: false,
        createdAt: new Date(now * 1000),
        updatedAt: new Date(now * 1000),
      })
      .run();
    test.db
      .insert(userMaterials)
      .values({ userId: 'u1', materialId: 'nkjv-1cor', clubTier: 150, createdAt: now })
      .run();

    const rows = test.db.select().from(userMaterials).all();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.materialId).toBe('nkjv-1cor');
  });
});
