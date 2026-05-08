import { afterEach, describe, expect, it } from 'vitest';

import { seedUserWithFixture } from '../test-fixtures.js';
import { createTestDb } from '../test-utils.js';
import { EngineStore, NotEnrolledError, type TestStateEntry } from './engine.js';

describe('EngineStore', () => {
  let cleanup: (() => void) | null = null;
  afterEach(() => {
    cleanup?.();
    cleanup = null;
  });

  it('loads an engine from a seeded snapshot', async () => {
    const test = createTestDb();
    cleanup = test.cleanup;
    seedUserWithFixture({ db: test.db, userId: 'u1', materialId: 'nkjv-1cor' });

    const store = new EngineStore(test.db);
    const loaded = await store.load({ userId: 'u1', materialId: 'nkjv-1cor' });

    expect(loaded.snapshotVersion).toBe(1);
    const states = JSON.parse(loaded.engine.export_test_states()) as TestStateEntry[];
    expect(states.length).toBeGreaterThan(0);
    store.clear();
  });

  it('throws when no snapshot exists', async () => {
    const test = createTestDb();
    cleanup = test.cleanup;

    const store = new EngineStore(test.db);
    await expect(store.load({ userId: 'missing', materialId: 'x' })).rejects.toBeInstanceOf(
      NotEnrolledError,
    );
  });

  it('caches engines across calls', async () => {
    const test = createTestDb();
    cleanup = test.cleanup;
    seedUserWithFixture({ db: test.db, userId: 'u1', materialId: 'nkjv-1cor' });

    const store = new EngineStore(test.db);
    const a = await store.load({ userId: 'u1', materialId: 'nkjv-1cor' });
    const b = await store.load({ userId: 'u1', materialId: 'nkjv-1cor' });
    expect(a.engine).toBe(b.engine);
    store.clear();
  });

  it('serialises concurrent withLock callers', async () => {
    const test = createTestDb();
    cleanup = test.cleanup;
    seedUserWithFixture({ db: test.db, userId: 'u1', materialId: 'nkjv-1cor' });

    const store = new EngineStore(test.db);
    const key = { userId: 'u1', materialId: 'nkjv-1cor' };

    const order: number[] = [];
    let resolveFirst: () => void = () => {};
    const first = store.withLock(key, async () => {
      order.push(1);
      await new Promise<void>((r) => {
        resolveFirst = r;
      });
      order.push(3);
    });
    const second = store.withLock(key, async () => {
      order.push(4);
    });
    // Yield once so the first lambda starts before we release it.
    await new Promise((r) => setTimeout(r, 0));
    order.push(2);
    resolveFirst();
    await Promise.all([first, second]);
    expect(order).toEqual([1, 2, 3, 4]);
    store.clear();
  });
});
