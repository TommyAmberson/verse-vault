import { afterEach, describe, expect, it, vi } from 'vitest';

import { createTestDb } from '../test-utils.js';
import { ApibibleCache, CACHE_TTL_SECS } from './apibible-cache.js';

const BIBLE_ID = 'bible-x';
const PASSAGE_ID = '1CO.1';
const BOOK_CODE = '1CO';

function makeOk(content: unknown) {
  return new Response(JSON.stringify({ data: content }), { status: 200 });
}

function makeErr(status: number, body: string) {
  return new Response(body, { status });
}

describe('ApibibleCache passages', () => {
  let cleanup: (() => void) | null = null;
  afterEach(() => {
    cleanup?.();
    cleanup = null;
  });

  it('fetches once and caches subsequent reads', async () => {
    const test = createTestDb();
    cleanup = test.cleanup;
    const fetchMock = vi.fn().mockResolvedValueOnce(makeOk({ content: '<p>For God</p>' }));
    const cache = new ApibibleCache(test.db, 'k', () => 1_000, fetchMock);

    const first = await cache.getPassageHtml(BIBLE_ID, PASSAGE_ID);
    const second = await cache.getPassageHtml(BIBLE_ID, PASSAGE_ID);

    expect(first).toBe('<p>For God</p>');
    expect(second).toBe('<p>For God</p>');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('refreshes after the TTL elapses', async () => {
    const test = createTestDb();
    cleanup = test.cleanup;
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(makeOk({ content: 'old' }))
      .mockResolvedValueOnce(makeOk({ content: 'new' }));
    let now = 1_000;
    const cache = new ApibibleCache(test.db, 'k', () => now, fetchMock);

    expect(await cache.getPassageHtml(BIBLE_ID, PASSAGE_ID)).toBe('old');
    now += CACHE_TTL_SECS + 1;
    expect(await cache.getPassageHtml(BIBLE_ID, PASSAGE_ID)).toBe('new');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('coalesces concurrent cold reads into a single fetch', async () => {
    const test = createTestDb();
    cleanup = test.cleanup;
    let resolveFetch: ((value: Response) => void) | null = null;
    const fetchMock = vi.fn().mockImplementationOnce(
      () =>
        new Promise<Response>((r) => {
          resolveFetch = r;
        }),
    );
    const cache = new ApibibleCache(test.db, 'k', () => 1_000, fetchMock);

    const a = cache.getPassageHtml(BIBLE_ID, PASSAGE_ID);
    const b = cache.getPassageHtml(BIBLE_ID, PASSAGE_ID);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    resolveFetch!(makeOk({ content: 'shared' }));
    expect(await a).toBe('shared');
    expect(await b).toBe('shared');
  });

  it('throws ApibibleError on non-2xx', async () => {
    const test = createTestDb();
    cleanup = test.cleanup;
    const fetchMock = vi.fn().mockResolvedValueOnce(makeErr(401, 'bad api-key'));
    const cache = new ApibibleCache(test.db, 'k', () => 1_000, fetchMock);

    await expect(cache.getPassageHtml(BIBLE_ID, PASSAGE_ID)).rejects.toThrow(/HTTP 401/);
  });
});

describe('ApibibleCache sections', () => {
  let cleanup: (() => void) | null = null;
  afterEach(() => {
    cleanup?.();
    cleanup = null;
  });

  it('round-trips a section list through the cache', async () => {
    const test = createTestDb();
    cleanup = test.cleanup;
    const fetchMock = vi.fn().mockResolvedValueOnce(
      makeOk([
        {
          id: '1CO.S1',
          title: 'Greeting',
          firstVerseId: '1CO.1.1',
          lastVerseId: '1CO.1.3',
        },
      ]),
    );
    const cache = new ApibibleCache(test.db, 'k', () => 1_000, fetchMock);

    const first = await cache.getSections(BIBLE_ID, BOOK_CODE);
    const second = await cache.getSections(BIBLE_ID, BOOK_CODE);

    expect(first).toEqual([
      { id: '1CO.S1', title: 'Greeting', firstVerseId: '1CO.1.1', lastVerseId: '1CO.1.3' },
    ]);
    expect(second).toEqual(first);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('ApibibleCache prune-on-load', () => {
  let cleanup: (() => void) | null = null;
  afterEach(() => {
    cleanup?.();
    cleanup = null;
  });

  it('drops expired entries from the on-disk cache when constructed', async () => {
    const test = createTestDb();
    cleanup = test.cleanup;
    // Seed an entry as if it had been written long ago.
    const stale = new ApibibleCache(test.db, 'k', () => 1_000, vi.fn().mockResolvedValueOnce(makeOk({ content: 'x' })));
    await stale.getPassageHtml(BIBLE_ID, PASSAGE_ID);

    // New cache constructed at a time well past TTL — prune should
    // wipe the stale row.
    const fetchMock = vi.fn().mockResolvedValueOnce(makeOk({ content: 'fresh' }));
    const fresh = new ApibibleCache(
      test.db,
      'k',
      () => 1_000 + CACHE_TTL_SECS + 1,
      fetchMock,
    );
    expect(await fresh.getPassageHtml(BIBLE_ID, PASSAGE_ID)).toBe('fresh');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
