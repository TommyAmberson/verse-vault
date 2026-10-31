import { afterEach, describe, expect, it } from 'vitest';

import { createTestDb, createTestUser } from '../test-utils.js';

import { advanceResetCounter, currentResetCounter, staleResetCounter } from './reset-counter.js';

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

  it('reads 0 for an account never wiped and goes up by one per wipe', () => {
    const db = setup();
    expect(currentResetCounter(db, 'u1')).toBe(0);
    advanceResetCounter(db, 'u1');
    expect(currentResetCounter(db, 'u1')).toBe(1);
    advanceResetCounter(db, 'u1');
    expect(currentResetCounter(db, 'u1')).toBe(2);
  });

  it('refuses only a sent counter that is not the current one', () => {
    const db = setup();
    advanceResetCounter(db, 'u1');
    expect(staleResetCounter(db, 'u1', '1')).toBeNull();
    expect(staleResetCounter(db, 'u1', '0')).toBe(1);
    expect(staleResetCounter(db, 'u1', 'junk')).toBe(1);
    expect(staleResetCounter(db, 'u1', undefined)).toBeNull();
  });
});
