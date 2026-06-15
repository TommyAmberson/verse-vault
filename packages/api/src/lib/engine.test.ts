import { and, eq } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';

import type { DB } from '../db/client.js';
import { graphSnapshots, testStates as testStatesTable } from '../db/schema.js';
import { seedUserWithFixture } from '../test-fixtures.js';
import { createTestDb, createTestUser } from '../test-utils.js';
import { enrollUser } from './enrollment.js';
import {
  EngineStore,
  NotEnrolledError,
  changedStatesFromUpdates,
  type TestStateEntry,
  type TestUpdateWire,
} from './engine.js';

function fixtureMaterial(phraseWordCounts: number[]): string {
  return JSON.stringify({
    year: 3,
    books: ['John'],
    chapters: [{ book: 'John', number: 3, start_verse: 16, end_verse: 16 }],
    verses: [
      {
        book: 'John',
        chapter: 3,
        verse: 16,
        phraseWordCounts,
        annotations: [],
        ftvWordCount: 2,
        clubs: [],
      },
    ],
    headings: [],
  });
}

interface PhraseElement {
  kind: 'Phrase';
  verse_id: number;
  start_word: number;
  end_word: number;
}

describe('EngineStore', () => {
  let cleanup: (() => void) | null = null;
  afterEach(() => {
    cleanup?.();
    cleanup = null;
  });

  it('loads an engine from a seeded snapshot', async () => {
    const test = createTestDb();
    cleanup = test.cleanup;
    seedUserWithFixture({ db: test.db, userId: 'u1', materialId: 'nkjv-cor' });

    const store = new EngineStore(test.db);
    const loaded = await store.load({ userId: 'u1', materialId: 'nkjv-cor' });

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
    seedUserWithFixture({ db: test.db, userId: 'u1', materialId: 'nkjv-cor' });

    const store = new EngineStore(test.db);
    const a = await store.load({ userId: 'u1', materialId: 'nkjv-cor' });
    const b = await store.load({ userId: 'u1', materialId: 'nkjv-cor' });
    expect(a.engine).toBe(b.engine);
    store.clear();
  });

  it('readTestStateEntries rewrites legacy positional Phrase elements to ranges', async () => {
    const test = createTestDb();
    cleanup = test.cleanup;
    createTestUser(test.db, 'u1');
    enrollUser({
      db: test.db,
      userId: 'u1',
      materialId: 'nkjv-cor',
      materialJson: fixtureMaterial([2, 2, 2, 3]),
      now: () => 0,
    });
    // Manually rewrite a row to the legacy positional shape, mimicking
    // pre-migration data.
    const verseRefRow = test.db
      .select()
      .from(testStatesTable)
      .where(
        and(
          eq(testStatesTable.userId, 'u1'),
          eq(testStatesTable.materialId, 'nkjv-cor'),
          eq(testStatesTable.testKind, 'PhraseFromContext'),
        ),
      )
      .all()
      .find((r) => {
        const e = JSON.parse(r.element) as PhraseElement;
        return e.start_word === 2 && e.end_word === 4;
      });
    if (!verseRefRow) throw new Error('expected a phrase row at range (2,4)');
    test.db
      .update(testStatesTable)
      .set({ element: JSON.stringify({ kind: 'Phrase', verse_id: 0, position: 1 }) })
      .where(
        and(
          eq(testStatesTable.userId, 'u1'),
          eq(testStatesTable.materialId, 'nkjv-cor'),
          eq(testStatesTable.testKind, 'PhraseFromContext'),
          eq(testStatesTable.element, verseRefRow.element),
        ),
      )
      .run();

    const store = new EngineStore(test.db, () => 0, () => fixtureMaterial([2, 2, 2, 3]));
    const loaded = await store.load({ userId: 'u1', materialId: 'nkjv-cor' });
    const states = JSON.parse(loaded.engine.export_test_states()) as TestStateEntry[];
    const phrase1 = states.find((s) => {
      const e = s.element as PhraseElement;
      return s.test_kind === 'PhraseFromContext' && e.start_word === 2 && e.end_word === 4;
    });
    expect(phrase1).toBeDefined();
    store.clear();
  });

  it('readTestStateEntries drops rows whose position no longer maps', async () => {
    const test = createTestDb();
    cleanup = test.cleanup;
    createTestUser(test.db, 'u1');
    enrollUser({
      db: test.db,
      userId: 'u1',
      materialId: 'nkjv-cor',
      materialJson: fixtureMaterial([2, 2, 2, 3]),
      now: () => 0,
    });
    // Inject a legacy-shape row pointing at position 99 — past the
    // verse's 4-phrase count, so the adapter should drop it.
    test.db
      .insert(testStatesTable)
      .values({
        userId: 'u1',
        materialId: 'nkjv-cor',
        testKind: 'PhraseFromContext',
        element: JSON.stringify({ kind: 'Phrase', verse_id: 0, position: 99 }),
        stability: 1,
        difficulty: 5,
        lastSeenSecs: 0,
        lastBaseSecs: 0,
        lastRootSecs: 0,
        pendingRelearn: 0,
      })
      .run();

    const store = new EngineStore(test.db, () => 0, () => fixtureMaterial([2, 2, 2, 3]));
    const loaded = await store.load({ userId: 'u1', materialId: 'nkjv-cor' });
    const states = JSON.parse(loaded.engine.export_test_states()) as TestStateEntry[];
    const orphan = states.find((s) => {
      const e = s.element as { position?: number };
      return e.position === 99;
    });
    expect(orphan).toBeUndefined();
    store.clear();
  });

  it('bumps the snapshot version when bundled materialData changes', async () => {
    const test = createTestDb();
    cleanup = test.cleanup;
    createTestUser(test.db, 'u1');
    const before = fixtureMaterial([2, 2, 2, 3]);
    const after = fixtureMaterial([3, 3, 3]);
    enrollUser({
      db: test.db,
      userId: 'u1',
      materialId: 'nkjv-cor',
      materialJson: before,
      now: () => 0,
    });

    let bundled = before;
    const store = new EngineStore(test.db, () => 1, () => bundled);

    // Same content → no bump.
    const first = await store.load({ userId: 'u1', materialId: 'nkjv-cor' });
    expect(first.snapshotVersion).toBe(1);

    // Switch bundled blob and re-load → bump.
    bundled = after;
    const second = await store.load({ userId: 'u1', materialId: 'nkjv-cor' });
    expect(second.snapshotVersion).toBe(2);
    expect(second.engine).not.toBe(first.engine);

    const rows = test.db
      .select()
      .from(graphSnapshots)
      .where(
        and(
          eq(graphSnapshots.userId, 'u1'),
          eq(graphSnapshots.materialId, 'nkjv-cor'),
        ),
      )
      .all();
    expect(rows.length).toBe(2);
    store.clear();
  });

  it('bumps from the migration-placeholder content_sha on first load', async () => {
    // Migration 0020 backfills pre-existing snapshot rows with the literal
    // 'pre-content-sha-migration' string. The first EngineStore.load
    // against such a row must detect the mismatch against the real disk
    // SHA and bump the user, populating content_sha for future requests.
    const test = createTestDb();
    cleanup = test.cleanup;
    createTestUser(test.db, 'u1');
    const fixture = fixtureMaterial([2, 2, 2, 3]);
    enrollUser({
      db: test.db,
      userId: 'u1',
      materialId: 'nkjv-cor',
      materialJson: fixture,
      now: () => 0,
    });

    // Simulate the post-migration state by overwriting the enrolled row's
    // content_sha with the placeholder.
    test.db
      .update(graphSnapshots)
      .set({ contentSha: 'pre-content-sha-migration' })
      .where(
        and(eq(graphSnapshots.userId, 'u1'), eq(graphSnapshots.materialId, 'nkjv-cor')),
      )
      .run();

    const store = new EngineStore(test.db, () => 1, () => fixture);
    const loaded = await store.load({ userId: 'u1', materialId: 'nkjv-cor' });
    expect(loaded.snapshotVersion).toBe(2);

    const latest = test.db
      .select()
      .from(graphSnapshots)
      .where(
        and(eq(graphSnapshots.userId, 'u1'), eq(graphSnapshots.materialId, 'nkjv-cor')),
      )
      .orderBy(graphSnapshots.version)
      .all();
    expect(latest).toHaveLength(2);
    // v1 still holds the placeholder; v2 has the real sha of the fixture.
    expect(latest[0].contentSha).toBe('pre-content-sha-migration');
    expect(latest[1].contentSha).toMatch(/^[a-f0-9]{64}$/);
    store.clear();
  });

  it('concurrent loads on a placeholder row both succeed via unique-constraint recovery', async () => {
    // Two simultaneous loads at bump-time would both try to insert
    // version=2; the uniq_graph_snapshots_user_material_version index
    // makes one INSERT throw. Both callers must still return a usable
    // engine — the loser catches the constraint error and re-fetches
    // the row the winner wrote.
    const test = createTestDb();
    cleanup = test.cleanup;
    createTestUser(test.db, 'u1');
    const fixture = fixtureMaterial([2, 2, 2, 3]);
    enrollUser({
      db: test.db,
      userId: 'u1',
      materialId: 'nkjv-cor',
      materialJson: fixture,
      now: () => 0,
    });
    test.db
      .update(graphSnapshots)
      .set({ contentSha: 'pre-content-sha-migration' })
      .where(
        and(eq(graphSnapshots.userId, 'u1'), eq(graphSnapshots.materialId, 'nkjv-cor')),
      )
      .run();

    const store = new EngineStore(test.db, () => 1, () => fixture);
    const [a, b] = await Promise.all([
      store.load({ userId: 'u1', materialId: 'nkjv-cor' }),
      store.load({ userId: 'u1', materialId: 'nkjv-cor' }),
    ]);
    expect(a.snapshotVersion).toBe(2);
    expect(b.snapshotVersion).toBe(2);

    // Exactly one new row should have been written (version 2). Both
    // callers see the same row's SHA.
    const rows = test.db
      .select()
      .from(graphSnapshots)
      .where(
        and(eq(graphSnapshots.userId, 'u1'), eq(graphSnapshots.materialId, 'nkjv-cor')),
      )
      .all();
    expect(rows.length).toBe(2);
    store.clear();
  });

  it('preserves FSRS state across split changes when the word range survives', async () => {
    const test = createTestDb();
    cleanup = test.cleanup;
    createTestUser(test.db, 'u1');
    const before = fixtureMaterial([2, 2, 2, 3]);
    const after = fixtureMaterial([3, 3, 3]);
    enrollUser({
      db: test.db,
      userId: 'u1',
      materialId: 'nkjv-cor',
      materialJson: before,
      now: () => 0,
    });

    // Boost the stability of the (6, 9) phrase — the only range that
    // survives the [2,2,2,3] → [3,3,3] resplit (cumulative-sum: old
    // position 3 = (6, 9); new position 2 = (6, 9)).
    const matched = test.db
      .select()
      .from(testStatesTable)
      .where(
        and(
          eq(testStatesTable.userId, 'u1'),
          eq(testStatesTable.materialId, 'nkjv-cor'),
          eq(testStatesTable.testKind, 'PhraseFromContext'),
        ),
      )
      .all()
      .find((r) => {
        const e = JSON.parse(r.element) as PhraseElement;
        return e.start_word === 6 && e.end_word === 9;
      });
    if (!matched) throw new Error('expected a phrase row at (6, 9)');
    test.db
      .update(testStatesTable)
      .set({ stability: 99 })
      .where(
        and(
          eq(testStatesTable.userId, 'u1'),
          eq(testStatesTable.materialId, 'nkjv-cor'),
          eq(testStatesTable.testKind, 'PhraseFromContext'),
          eq(testStatesTable.element, matched.element),
        ),
      )
      .run();

    let bundled = before;
    const store = new EngineStore(test.db, () => 1, () => bundled);
    bundled = after;
    const loaded = await store.load({ userId: 'u1', materialId: 'nkjv-cor' });
    const states = JSON.parse(loaded.engine.export_test_states()) as TestStateEntry[];
    const survivor = states.find((s) => {
      const e = s.element as PhraseElement;
      return e.start_word === 6 && e.end_word === 9;
    });
    expect(survivor?.stability).toBe(99);
    // The other ranges in the new split don't match anything old —
    // they boot fresh via new_unseen (stability 1).
    const fresh = states.find((s) => {
      const e = s.element as PhraseElement;
      return e.start_word === 0 && e.end_word === 3;
    });
    expect(fresh?.stability).toBe(1);
    store.clear();
  });

  it('serialises concurrent withLock callers', async () => {
    const test = createTestDb();
    cleanup = test.cleanup;
    seedUserWithFixture({ db: test.db, userId: 'u1', materialId: 'nkjv-cor' });

    const store = new EngineStore(test.db);
    const key = { userId: 'u1', materialId: 'nkjv-cor' };

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

describe('EngineStore eviction', () => {
  let cleanup: (() => void) | null = null;
  afterEach(() => {
    cleanup?.();
    cleanup = null;
  });

  function seed(db: DB, userId: string, materialId = 'nkjv-cor') {
    seedUserWithFixture({ db, userId, materialId });
  }

  it('LRU evicts the least-recently-used entry when over the cap', async () => {
    const test = createTestDb();
    cleanup = test.cleanup;
    seed(test.db, 'u1');
    seed(test.db, 'u2');
    seed(test.db, 'u3');

    let clock = 100;
    const store = new EngineStore(test.db, () => clock, undefined, { maxEntries: 2 });

    clock = 100;
    const u1Orig = await store.load({ userId: 'u1', materialId: 'nkjv-cor' });
    clock = 200;
    const u2Orig = await store.load({ userId: 'u2', materialId: 'nkjv-cor' });
    clock = 300;
    await store.load({ userId: 'u3', materialId: 'nkjv-cor' });

    // Inserting u3 with the cache full at maxEntries=2 should evict u1
    // (oldest lastUsedAt=100). u2 was used at 200 so it survives.
    clock = 400;
    const u1Reload = await store.load({ userId: 'u1', materialId: 'nkjv-cor' });
    expect(u1Reload.engine).not.toBe(u1Orig.engine);
    // The reload of u1 also evicts the LRU at this point (u2@200 since
    // u3@300 is newer), so testing u2 here would also see a fresh engine.
    // The u1 != u1Orig check above is enough to confirm LRU eviction
    // happened on the first u3 insert. u2Orig kept just to anchor the
    // setup ordering.
    void u2Orig;
    store.clear();
  });

  it('cache hit bumps lastUsedAt so the recently-used entry survives eviction', async () => {
    const test = createTestDb();
    cleanup = test.cleanup;
    seed(test.db, 'u1');
    seed(test.db, 'u2');
    seed(test.db, 'u3');

    let clock = 100;
    const store = new EngineStore(test.db, () => clock, undefined, { maxEntries: 2 });

    clock = 100;
    const u1Orig = await store.load({ userId: 'u1', materialId: 'nkjv-cor' });
    clock = 200;
    await store.load({ userId: 'u2', materialId: 'nkjv-cor' });
    clock = 300;
    // Cache hit on u1 should bump its lastUsedAt to 300, making u2 the LRU.
    await store.load({ userId: 'u1', materialId: 'nkjv-cor' });
    clock = 400;
    await store.load({ userId: 'u3', materialId: 'nkjv-cor' });

    // u2 was the LRU (lastUsed=200) so it should have been evicted, not u1.
    clock = 500;
    const u1AfterPressure = await store.load({ userId: 'u1', materialId: 'nkjv-cor' });
    expect(u1AfterPressure.engine).toBe(u1Orig.engine);
    store.clear();
  });

  it('reap() evicts entries idle past idleTtlSecs', async () => {
    const test = createTestDb();
    cleanup = test.cleanup;
    seed(test.db, 'u1');

    let clock = 100;
    const store = new EngineStore(test.db, () => clock, undefined, {
      idleTtlSecs: 50,
    });

    clock = 100;
    const u1Orig = await store.load({ userId: 'u1', materialId: 'nkjv-cor' });

    // Within TTL — reap is a no-op.
    clock = 140;
    store.reap();
    const u1Within = await store.load({ userId: 'u1', materialId: 'nkjv-cor' });
    expect(u1Within.engine).toBe(u1Orig.engine);

    // Past TTL — reap evicts.
    clock = 300;
    store.reap();
    clock = 400;
    const u1Past = await store.load({ userId: 'u1', materialId: 'nkjv-cor' });
    expect(u1Past.engine).not.toBe(u1Orig.engine);
    store.clear();
  });

  it('evicted engines defer free() until the grace period elapses', async () => {
    const test = createTestDb();
    cleanup = test.cleanup;
    seed(test.db, 'u1');

    let clock = 100;
    const store = new EngineStore(test.db, () => clock, undefined, {
      idleTtlSecs: 50,
    });

    clock = 100;
    const handle = await store.load({ userId: 'u1', materialId: 'nkjv-cor' });
    // Dispose synchronously so refcount drops to 0; the test exercises
    // the grace-period gate, not the refcount-pin path.
    handle[Symbol.dispose]();

    // Past TTL → evicts to pending. Grace period (30s) hasn't elapsed.
    clock = 200;
    store.reap();
    expect((store as unknown as { pendingFree: unknown[] }).pendingFree.length).toBe(1);

    // Still within grace at +29s after eviction. Another reap doesn't drain.
    clock = 229;
    store.reap();
    expect((store as unknown as { pendingFree: unknown[] }).pendingFree.length).toBe(1);

    // Past grace at +31s. Reap drains the pending entry.
    clock = 231;
    store.reap();
    expect((store as unknown as { pendingFree: unknown[] }).pendingFree.length).toBe(0);

    store.clear();
  });

  it('invalidate() defers free() via pendingFree', async () => {
    const test = createTestDb();
    cleanup = test.cleanup;
    seed(test.db, 'u1');

    let clock = 100;
    const store = new EngineStore(test.db, () => clock);

    const handle = await store.load({ userId: 'u1', materialId: 'nkjv-cor' });
    handle[Symbol.dispose]();

    store.invalidate({ userId: 'u1', materialId: 'nkjv-cor' });
    // Cache entry gone; engine sits in pendingFree, not freed yet.
    const internal = store as unknown as {
      cache: Map<string, unknown>;
      pendingFree: unknown[];
    };
    expect(internal.cache.size).toBe(0);
    expect(internal.pendingFree.length).toBe(1);

    // Past grace → next reap drains it.
    clock = 200;
    store.reap();
    expect(internal.pendingFree.length).toBe(0);

    store.clear();
  });

  it('live LoadedEngine handle pins entry against free even past grace', async () => {
    const test = createTestDb();
    cleanup = test.cleanup;
    seed(test.db, 'u1');

    let clock = 100;
    const store = new EngineStore(test.db, () => clock, undefined, {
      idleTtlSecs: 50,
    });

    clock = 100;
    const held = await store.load({ userId: 'u1', materialId: 'nkjv-cor' });
    const internal = store as unknown as { pendingFree: unknown[] };

    // Evict at clock=200 (past TTL). evictedAt is recorded as 200.
    clock = 200;
    store.reap();
    expect(internal.pendingFree.length).toBe(1);

    // Advance well past grace. Drain still skips because refcount > 0.
    clock = 1000;
    store.reap();
    expect(internal.pendingFree.length).toBe(1);

    // Underlying engine is still callable through the pinned handle.
    expect(() => held.engine.new_card_count()).not.toThrow();

    // Disposing the handle drops refcount → opportunistic drain fires
    // inside the release path. At clock=1000, evictedAt=200 is past
    // grace (cutoff=970), and refcount is now 0, so the entry frees.
    held[Symbol.dispose]();
    expect(internal.pendingFree.length).toBe(0);

    store.clear();
  });

  it('start() and stop() are idempotent; clear() stops the reaper', () => {
    const test = createTestDb();
    cleanup = test.cleanup;

    // Pick a long interval so the timer never actually fires under the test.
    const store = new EngineStore(test.db, () => 0, undefined, {
      reaperIntervalSecs: 3600,
    });

    const internal = store as unknown as { reaperHandle: NodeJS.Timeout | null };
    expect(internal.reaperHandle).toBeNull();

    store.start();
    expect(internal.reaperHandle).not.toBeNull();
    store.start();
    expect(internal.reaperHandle).not.toBeNull();

    store.stop();
    expect(internal.reaperHandle).toBeNull();
    store.stop();
    expect(internal.reaperHandle).toBeNull();

    store.start();
    store.clear();
    expect(internal.reaperHandle).toBeNull();
  });
});

describe('changedStatesFromUpdates', () => {
  function mkUpdate(testKind: string, position: number, pendingRelearn: boolean): TestUpdateWire {
    return {
      key: { kind: testKind, element: { kind: 'Phrase', verse_id: 0, position } },
      kind: 'Root',
      before: {
        stability: 1,
        difficulty: 5,
        last_seen_secs: 0,
        last_base_secs: 0,
        last_root_secs: 0,
        pending_relearn: false,
      },
      after: {
        stability: 2.5,
        difficulty: 4.8,
        last_seen_secs: 86400,
        last_base_secs: 86400,
        last_root_secs: 86400,
        pending_relearn: pendingRelearn,
      },
    };
  }

  it('maps each update to a TestStateEntry carrying the post-update state', () => {
    const updates = [mkUpdate('PhraseFromContext', 0, false), mkUpdate('VerseChapter', 1, true)];
    const changed = changedStatesFromUpdates(updates);
    expect(changed).toHaveLength(2);
    expect(changed[0]).toEqual({
      element: { kind: 'Phrase', verse_id: 0, position: 0 },
      test_kind: 'PhraseFromContext',
      stability: 2.5,
      difficulty: 4.8,
      last_seen_secs: 86400,
      last_base_secs: 86400,
      last_root_secs: 86400,
      pending_relearn: false,
    });
    expect(changed[1].pending_relearn).toBe(true);
  });

  it('collapses duplicate test keys to the last update (last-write-wins)', () => {
    // Same key, different `after` values — only the last should land in
    // the result. Mirrors what the prior export-then-filter approach
    // would have produced (DB row = final cached engine state).
    const first = mkUpdate('PhraseFromContext', 0, true);
    const second = mkUpdate('PhraseFromContext', 0, false);
    second.after.stability = 99;

    const changed = changedStatesFromUpdates([first, second]);
    expect(changed).toHaveLength(1);
    expect(changed[0].stability).toBe(99);
    expect(changed[0].pending_relearn).toBe(false);
  });

  it('returns an empty array for an empty updates list', () => {
    expect(changedStatesFromUpdates([])).toEqual([]);
  });

  it('dedups elements regardless of object-field insertion order', () => {
    // Two semantically-equal ElementIds with different field orders —
    // could happen if a future TS caller constructs them field-by-field
    // (Rust serde is stable-order today, but the helper is a public
    // export with no compile-time guarantee on caller layout).
    const updateA: TestUpdateWire = {
      key: { kind: 'PhraseFromContext', element: { kind: 'Phrase', verse_id: 0, position: 1 } },
      kind: 'Root',
      before: {
        stability: 1,
        difficulty: 5,
        last_seen_secs: 0,
        last_base_secs: 0,
        last_root_secs: 0,
        pending_relearn: false,
      },
      after: {
        stability: 1.5,
        difficulty: 5,
        last_seen_secs: 100,
        last_base_secs: 100,
        last_root_secs: 100,
        pending_relearn: false,
      },
    };
    const updateB: TestUpdateWire = {
      key: { kind: 'PhraseFromContext', element: { position: 1, verse_id: 0, kind: 'Phrase' } },
      kind: 'Root',
      before: updateA.before,
      after: { ...updateA.after, stability: 9.9 },
    };

    const changed = changedStatesFromUpdates([updateA, updateB]);
    expect(changed).toHaveLength(1);
    expect(changed[0].stability).toBe(9.9);
  });
});
