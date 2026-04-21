import { afterEach, describe, expect, it } from 'vitest';

import { seedUserWithFixture } from '../test-fixtures.js';
import { createTestDb } from '../test-utils.js';
import { EngineStore, NotEnrolledError } from './engine.js';

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
    const edgeStates = JSON.parse(loaded.engine.export_edge_states()) as Array<{ edge_id: number }>;
    expect(edgeStates.length).toBeGreaterThan(0);
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
});
