import { afterEach, describe, expect, it } from 'vitest';

import { createTestDb, createTestUser } from '../test-utils.js';

import { announcedResetCounter, currentResetCounter, duringWipe } from './reset-counter.js';

describe('reset counter', () => {
  let cleanup: (() => void) | null = null;
  afterEach(() => {
    cleanup?.();
    cleanup = null;
  });

  function setup() {
    const test = createTestDb();
    cleanup = test.cleanup;
    createTestUser(test.db, 'u1');
    return test.db;
  }

  it('moves on once per wipe, announcing the new value only when the wipe is done', async () => {
    const db = setup();
    expect(currentResetCounter(db, 'u1')).toBe(0);
    await duringWipe(db, 'u1', async () => {
      expect(currentResetCounter(db, 'u1')).toBe(1);
      expect(announcedResetCounter(db, 'u1')).toBe(0);
    });
    expect(announcedResetCounter(db, 'u1')).toBe(1);
    await duringWipe(db, 'u1', async () => {});
    expect(announcedResetCounter(db, 'u1')).toBe(2);
  });
});
