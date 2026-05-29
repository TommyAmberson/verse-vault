import { describe, expect, it } from 'vitest';

import type { WasmEngine } from 'verse-vault-wasm';

import { afterEach } from 'vitest';
import { EngineStore } from './engine.js';
import { type CardRef, cardRefKey } from './export-format.js';
import { buildCardRefIndex, resolveCardRef } from './card-ref.js';
import { seedUserWithFixture } from '../test-fixtures.js';
import { createTestDb } from '../test-utils.js';

/** Stubs the one engine method the indexer reads, so we can drive
 *  every CardKindWire variant deterministically without standing up a
 *  real engine. */
function stubEngine(payload: unknown): WasmEngine {
  return { all_card_renders: () => JSON.stringify(payload) } as unknown as WasmEngine;
}

describe('cardRefKey', () => {
  it('produces stable strings per CardRef shape', () => {
    const refs: CardRef[] = [
      { kind: 'PhraseFill', verseId: 0, position: 1 },
      { kind: 'Recitation', verseId: 0 },
      { kind: 'VerseInClub', verseId: 0, tier: 'Club150' },
      { kind: 'Ftv', verseId: 0, withCitation: true },
      { kind: 'HeadingPassage', headingIdx: 3 },
      { kind: 'ChapterClubList', book: 'John', chapter: 1, tier: 'Club300' },
    ];
    const keys = refs.map(cardRefKey);
    // No collisions across distinct refs.
    expect(new Set(keys).size).toBe(refs.length);
    // Stable under repeat call.
    expect(refs.map(cardRefKey)).toEqual(keys);
  });

  it('treats withCitation true vs false as distinct keys', () => {
    expect(
      cardRefKey({ kind: 'Ftv', verseId: 0, withCitation: true }),
    ).not.toBe(cardRefKey({ kind: 'Ftv', verseId: 0, withCitation: false }));
  });
});

describe('buildCardRefIndex', () => {
  it('round-trips every CardKindWire variant', () => {
    // Mirrors the flattened wire shape `all_card_renders` returns.
    const renders = [
      {
        cardId: 1,
        verseId: 0,
        kind: 'PhraseFill',
        position: 0,
        verse: { book: 'John', chapter: 3, verse: 16 },
      },
      {
        cardId: 2,
        verseId: 0,
        kind: 'VerseAtVerseRef',
        verse: { book: 'John', chapter: 3, verse: 16 },
      },
      {
        cardId: 3,
        verseId: 0,
        kind: 'VerseInChapter',
        verse: { book: 'John', chapter: 3, verse: 16 },
      },
      {
        cardId: 4,
        verseId: 0,
        kind: 'VerseInBook',
        verse: { book: 'John', chapter: 3, verse: 16 },
      },
      {
        cardId: 5,
        verseId: 0,
        kind: 'Recitation',
        verse: { book: 'John', chapter: 3, verse: 16 },
      },
      {
        cardId: 6,
        verseId: 0,
        kind: 'Citation',
        verse: { book: 'John', chapter: 3, verse: 16 },
      },
      {
        cardId: 7,
        verseId: 0,
        kind: 'VerseInHeading',
        headingIdx: 4,
        verse: { book: 'John', chapter: 3, verse: 16 },
      },
      {
        cardId: 8,
        verseId: 0,
        kind: 'VerseInClub',
        tier: 'Club150',
        verse: { book: 'John', chapter: 3, verse: 16 },
      },
      {
        cardId: 9,
        verseId: 0,
        kind: 'Ftv',
        withCitation: false,
        verse: { book: 'John', chapter: 3, verse: 16 },
      },
      {
        cardId: 10,
        verseId: 9999,
        kind: 'HeadingPassage',
        headingIdx: 4,
        verse: { book: 'John', chapter: 3, verse: 16 },
      },
      {
        cardId: 11,
        verseId: 9998,
        kind: 'ChapterClubList',
        tier: 'Club150',
        verse: { book: 'John', chapter: 3, verse: 1 },
      },
    ];
    const index = buildCardRefIndex(stubEngine(renders));
    expect(index.byCardId.size).toBe(renders.length);
    expect(index.byRef.size).toBe(renders.length);
    // Round-trip: cardId → CardRef → cardId.
    for (const r of renders) {
      const ref = index.byCardId.get(r.cardId);
      expect(ref).toBeDefined();
      expect(resolveCardRef(index, ref!)).toBe(r.cardId);
    }
  });

  it('omits verseId from HeadingPassage and ChapterClubList CardRefs', () => {
    const renders = [
      {
        cardId: 1,
        verseId: 9999,
        kind: 'HeadingPassage',
        headingIdx: 2,
        verse: { book: 'John', chapter: 1, verse: 1 },
      },
      {
        cardId: 2,
        verseId: 9998,
        kind: 'ChapterClubList',
        tier: 'Club300',
        verse: { book: 'John', chapter: 5, verse: 1 },
      },
    ];
    const index = buildCardRefIndex(stubEngine(renders));
    const hpRef = index.byCardId.get(1);
    const cclRef = index.byCardId.get(2);
    expect(hpRef).toEqual({ kind: 'HeadingPassage', headingIdx: 2 });
    expect(cclRef).toEqual({
      kind: 'ChapterClubList',
      book: 'John',
      chapter: 5,
      tier: 'Club300',
    });
  });

  it('skips unknown kinds rather than crashing', () => {
    const index = buildCardRefIndex(
      stubEngine([
        {
          cardId: 1,
          verseId: 0,
          kind: 'SomeUnknownKindFromTheFuture',
          verse: { book: 'John', chapter: 1, verse: 1 },
        },
        {
          cardId: 2,
          verseId: 0,
          kind: 'Recitation',
          verse: { book: 'John', chapter: 1, verse: 1 },
        },
      ]),
    );
    expect(index.byCardId.size).toBe(1);
    expect(index.byCardId.has(1)).toBe(false);
    expect(index.byCardId.has(2)).toBe(true);
  });

  it('returns undefined for unresolved CardRefs', () => {
    const index = buildCardRefIndex(stubEngine([]));
    expect(resolveCardRef(index, { kind: 'Recitation', verseId: 0 })).toBeUndefined();
  });
});

describe('buildCardRefIndex against a live engine', () => {
  let cleanup: (() => void) | null = null;
  afterEach(() => {
    cleanup?.();
    cleanup = null;
  });

  it('indexes every card the live engine emits', async () => {
    const test = createTestDb();
    cleanup = test.cleanup;
    seedUserWithFixture({ db: test.db, userId: 'u1', materialId: 'nkjv-cor' });

    const store = new EngineStore(test.db);
    try {
      using loaded = await store.load({ userId: 'u1', materialId: 'nkjv-cor' });
      const index = buildCardRefIndex(loaded.engine);
      // The fixture has at least one card.
      expect(index.byCardId.size).toBeGreaterThan(0);
      // Every cardId → CardRef → cardId round-trips.
      for (const [cardId, ref] of index.byCardId) {
        expect(resolveCardRef(index, ref)).toBe(cardId);
      }
    } finally {
      store.clear();
    }
  });
});
