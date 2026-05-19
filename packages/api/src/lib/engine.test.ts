import { and, eq } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';

import { graphSnapshots, testStates as testStatesTable } from '../db/schema.js';
import { seedUserWithFixture } from '../test-fixtures.js';
import { createTestDb, createTestUser } from '../test-utils.js';
import { enrollUser } from './enrollment.js';
import { EngineStore, NotEnrolledError, type TestStateEntry } from './engine.js';

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

    const store = new EngineStore(test.db, 0.9, () => 0, () => fixtureMaterial([2, 2, 2, 3]));
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

    const store = new EngineStore(test.db, 0.9, () => 0, () => fixtureMaterial([2, 2, 2, 3]));
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
    const store = new EngineStore(test.db, 0.9, () => 1, () => bundled);

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
    const store = new EngineStore(test.db, 0.9, () => 1, () => bundled);
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
