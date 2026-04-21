import { afterEach, describe, expect, it } from 'vitest';

import * as schema from '../db/schema.js';
import { createTestDb } from '../test-utils.js';
import { AlreadyEnrolledError, UnknownMaterialError, enrollUser } from './enrollment.js';

const MATERIAL_ID = 'nkjv-1cor';

function createUser(db: ReturnType<typeof createTestDb>['db'], userId: string): void {
  const now = Math.floor(Date.now() / 1000);
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

describe('enrollUser', () => {
  let cleanup: (() => void) | null = null;
  afterEach(() => {
    cleanup?.();
    cleanup = null;
  });

  it('enrolls a new user', () => {
    const test = createTestDb();
    cleanup = test.cleanup;
    createUser(test.db, 'u1');

    const result = enrollUser({ db: test.db, userId: 'u1', materialId: MATERIAL_ID });
    expect(result.version).toBe(1);
    expect(result.snapshotId).toBeTruthy();
  });

  it('throws UnknownMaterialError for unknown materials', () => {
    const test = createTestDb();
    cleanup = test.cleanup;
    createUser(test.db, 'u1');

    expect(() =>
      enrollUser({ db: test.db, userId: 'u1', materialId: 'does-not-exist' }),
    ).toThrow(UnknownMaterialError);
  });

  it('throws AlreadyEnrolledError when the PK constraint fires', () => {
    // Simulates the concurrent-enroll race: another request already wrote the
    // user_materials row between a would-be pre-check and this insert. The PK
    // constraint is now the authoritative guard and must surface as 409, not
    // 500.
    const test = createTestDb();
    cleanup = test.cleanup;
    createUser(test.db, 'u1');

    enrollUser({ db: test.db, userId: 'u1', materialId: MATERIAL_ID });

    expect(() => enrollUser({ db: test.db, userId: 'u1', materialId: MATERIAL_ID })).toThrow(
      AlreadyEnrolledError,
    );
  });
});
