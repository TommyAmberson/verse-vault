import { and, eq, lt, sql } from 'drizzle-orm';

import type { DB } from '../db/client.js';
import * as schema from '../db/schema.js';

/**
 * Server-side cache for api.bible content, backed by SQLite. The TOS
 * (API.Bible Minimum Acceptable Use Agreement) requires that cached
 * scripture content be refreshed within 30 days of fetch and not used
 * to train an AI/LLM; this class is runtime plumbing only.
 *
 * The TTL is enforced both at read (every lookup checks `now - fetchedAt`)
 * and at startup (`pruneExpired` runs in the constructor) so on-disk
 * rows never sit past the TTL even when a passage is never re-read.
 */
export const CACHE_TTL_SECS = 30 * 24 * 60 * 60;
const API_BASE = 'https://rest.api.bible/v1';

export interface Section {
  id: string;
  title: string;
  firstVerseId: string;
  lastVerseId: string;
}

export class ApibibleError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
  ) {
    super(message);
    this.name = 'ApibibleError';
  }
}

type FetchImpl = typeof fetch;

export class ApibibleCache {
  private readonly inflightPassages = new Map<string, Promise<string>>();
  private readonly inflightSections = new Map<string, Promise<Section[]>>();

  constructor(
    private readonly db: DB,
    private readonly apiKey: string,
    private readonly nowSecs: () => number = () => Math.floor(Date.now() / 1000),
    private readonly fetchImpl: FetchImpl = fetch,
  ) {
    this.pruneExpired();
  }

  /** Plain-HTML chapter content, cache-aware. `passageId` is the api.bible
   *  shape `{USX_BOOK}.{chapter}` (e.g. `"1CO.1"`). */
  async getPassageHtml(bibleId: string, passageId: string): Promise<string> {
    return this.readThrough(
      this.inflightPassages,
      `${bibleId}|${passageId}`,
      () => {
        const row = this.db
          .select()
          .from(schema.apibiblePassages)
          .where(
            and(
              eq(schema.apibiblePassages.bibleId, bibleId),
              eq(schema.apibiblePassages.passageId, passageId),
            ),
          )
          .get();
        return row ? { fetchedAt: row.fetchedAt, value: row.contentHtml } : null;
      },
      (now) => this.fetchAndCachePassage(bibleId, passageId, now),
    );
  }

  /** Section list for a book, cache-aware. */
  async getSections(bibleId: string, bookCode: string): Promise<Section[]> {
    return this.readThrough(
      this.inflightSections,
      `${bibleId}|${bookCode}`,
      () => {
        const row = this.db
          .select()
          .from(schema.apibibleSections)
          .where(
            and(
              eq(schema.apibibleSections.bibleId, bibleId),
              eq(schema.apibibleSections.bookCode, bookCode),
            ),
          )
          .get();
        return row
          ? { fetchedAt: row.fetchedAt, value: JSON.parse(row.sectionsJson) as Section[] }
          : null;
      },
      (now) => this.fetchAndCacheSections(bibleId, bookCode, now),
    );
  }

  /** Drop entries past the TTL from the on-disk cache. Runs in the
   *  constructor so the file is fresh before the first read. */
  pruneExpired(): void {
    const cutoff = this.nowSecs() - CACHE_TTL_SECS;
    this.db
      .delete(schema.apibiblePassages)
      .where(lt(schema.apibiblePassages.fetchedAt, cutoff))
      .run();
    this.db
      .delete(schema.apibibleSections)
      .where(lt(schema.apibibleSections.fetchedAt, cutoff))
      .run();
  }

  /** Cache read-through with single-flight: dedupe concurrent cold fetches
   *  for the same key so two callers don't fire two api.bible round-trips. */
  private async readThrough<T>(
    inflight: Map<string, Promise<T>>,
    key: string,
    dbRead: () => { fetchedAt: number; value: T } | null,
    fetchFresh: (now: number) => Promise<T>,
  ): Promise<T> {
    const hit = dbRead();
    const now = this.nowSecs();
    if (hit && now - hit.fetchedAt < CACHE_TTL_SECS) return hit.value;

    const existing = inflight.get(key);
    if (existing) return existing;

    const promise = fetchFresh(now).finally(() => inflight.delete(key));
    inflight.set(key, promise);
    return promise;
  }

  private async fetchAndCachePassage(
    bibleId: string,
    passageId: string,
    now: number,
  ): Promise<string> {
    const qs = new URLSearchParams({
      'content-type': 'html',
      'include-notes': 'false',
      'include-titles': 'false',
      'include-chapter-numbers': 'false',
      'include-verse-numbers': 'true',
      'include-verse-spans': 'false',
    });
    const url = `${API_BASE}/bibles/${encodeURIComponent(bibleId)}/passages/${encodeURIComponent(passageId)}?${qs}`;
    const json = await this.fetchJson(url, `passage ${passageId}`);
    const data = json.data as { content?: string } | undefined;
    const content = data?.content ?? '';

    this.db
      .insert(schema.apibiblePassages)
      .values({ bibleId, passageId, contentHtml: content, fetchedAt: now })
      .onConflictDoUpdate({
        target: [schema.apibiblePassages.bibleId, schema.apibiblePassages.passageId],
        set: {
          contentHtml: sql`excluded.content_html`,
          fetchedAt: sql`excluded.fetched_at`,
        },
      })
      .run();
    return content;
  }

  private async fetchAndCacheSections(
    bibleId: string,
    bookCode: string,
    now: number,
  ): Promise<Section[]> {
    const url = `${API_BASE}/bibles/${encodeURIComponent(bibleId)}/books/${encodeURIComponent(bookCode)}/sections`;
    const json = await this.fetchJson(url, `sections ${bookCode}`);
    const sections = ((json?.data as Section[] | undefined) ?? []).map((s) => ({
      id: s.id,
      title: s.title,
      firstVerseId: s.firstVerseId,
      lastVerseId: s.lastVerseId,
    }));

    this.db
      .insert(schema.apibibleSections)
      .values({
        bibleId,
        bookCode,
        sectionsJson: JSON.stringify(sections),
        fetchedAt: now,
      })
      .onConflictDoUpdate({
        target: [schema.apibibleSections.bibleId, schema.apibibleSections.bookCode],
        set: {
          sectionsJson: sql`excluded.sections_json`,
          fetchedAt: sql`excluded.fetched_at`,
        },
      })
      .run();
    return sections;
  }

  private async fetchJson(url: string, label: string): Promise<{ data?: unknown }> {
    const res = await this.fetchImpl(url, {
      headers: { 'api-key': this.apiKey, accept: 'application/json' },
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new ApibibleError(`api.bible HTTP ${res.status} for ${label}: ${body.slice(0, 200)}`, res.status);
    }
    return (await res.json()) as { data?: unknown };
  }
}
