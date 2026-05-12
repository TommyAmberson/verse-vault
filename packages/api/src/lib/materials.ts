import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Material catalog. The static manifest below is the source of truth for
 * what the catalog endpoint returns; the actual content (`MaterialData`
 * JSON) is the structural form — phrase word counts, user-annotation
 * indices, FTV word count, heading verse-ranges. No NKJV verse text.
 *
 * Structural deck files live in `/data/<year>-<book>.json` — one per
 * year of the 8-year quizzing cycle (`3-corinthians.json`,
 * `4-john.json`, …). An inline stand-in serves test environments that
 * haven't provisioned the data directory.
 */

export interface Material {
  id: string;
  title: string;
  description: string;
}

export const MATERIALS: readonly Material[] = [
  {
    id: 'nkjv-1cor',
    title: '1 Corinthians (NKJV)',
    description: '1 & 2 Corinthians with phrase chunking and FTV prompts.',
  },
];

export function getMaterial(id: string): Material | undefined {
  return MATERIALS.find((m) => m.id === id);
}

/** packages/api/src/lib/materials.ts -> repo root. */
const REPO_ROOT = resolve(import.meta.dirname, '../../../..');

/** Per-material override: relative path under the repo root for the
 *  structural MaterialData JSON. Missing on disk → inline fallback. */
const DATA_FILES: Record<string, string> = {
  'nkjv-1cor': 'data/3-corinthians.json',
};

/** Inline structural stand-in MaterialData per id, kept tiny so tests
 *  don't churn the WASM engine. Mirrors `crates/wasm/test-smoke.js`. */
const INLINE_FIXTURES: Record<string, unknown> = {
  'nkjv-1cor': {
    year: 3,
    books: ['John'],
    chapters: [{ book: 'John', number: 3, start_verse: 16, end_verse: 16 }],
    verses: [
      {
        book: 'John',
        chapter: 3,
        verse: 16,
        phraseWordCounts: [2, 2, 2, 3],
        annotations: [],
        ftvWordCount: 2,
        clubs: [],
      },
    ],
    headings: [],
  },
};

const cache = new Map<string, string>();

/** Bundled `MaterialData` JSON for a material id. Returns the JSON string
 *  — the WASM constructor parses it server-side. Throws if the id is
 *  unknown. Reads from disk on first call, then caches in process. */
export function getMaterialJson(id: string): string {
  const cached = cache.get(id);
  if (cached !== undefined) return cached;

  const rel = DATA_FILES[id];
  if (rel !== undefined) {
    const full = resolve(REPO_ROOT, rel);
    if (existsSync(full)) {
      const json = readFileSync(full, 'utf8');
      cache.set(id, json);
      return json;
    }
  }

  const fallback = INLINE_FIXTURES[id];
  if (fallback === undefined) throw new Error(`Unknown material: ${id}`);
  // Don't cache the fallback: if a dev process started before the pipeline
  // wrote data/3-corinthians.json, we want the next request to re-check disk
  // and pick up the real file instead of being stuck on the inline stub.
  return JSON.stringify(fallback);
}
