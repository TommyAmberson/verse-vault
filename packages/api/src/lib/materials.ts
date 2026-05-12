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
    id: 'nkjv-gepc',
    title: 'Galatians–Colossians (NKJV)',
    description: 'Year 1: Galatians, Ephesians, Philippians, Colossians.',
  },
  {
    id: 'nkjv-nt-survey',
    title: 'NT Survey (NKJV)',
    description:
      'Year 2: selected passages from Matthew, Acts, 1 Thessalonians, 1–2 Timothy, Titus, 1 John, Revelation.',
  },
  {
    id: 'nkjv-1cor',
    title: '1 Corinthians (NKJV)',
    description: 'Year 3: 1 & 2 Corinthians with phrase chunking and FTV prompts.',
  },
  {
    id: 'nkjv-john',
    title: 'John (NKJV)',
    description: 'Year 4: Gospel of John with phrase chunking and FTV prompts.',
  },
  {
    id: 'nkjv-hp',
    title: 'Hebrews & 1–2 Peter (NKJV)',
    description: 'Year 5: Hebrews, 1 Peter, 2 Peter (currently the Club150 cut only).',
  },
  {
    id: 'nkjv-ot-survey',
    title: 'OT Survey (NKJV)',
    description:
      'Year 6: curated passages across Genesis through the Minor Prophets (Club150 cut only).',
  },
  {
    id: 'nkjv-rj',
    title: 'Romans & James (NKJV)',
    description: 'Year 7: Romans and James (currently the Club150 cut only).',
  },
  {
    id: 'nkjv-luke',
    title: 'Luke (NKJV)',
    description: 'Year 8: Gospel of Luke (chapters 4–8, 12, 20 and Luke 3:23–38 are not covered).',
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
  'nkjv-gepc': 'data/1-gepc.json',
  'nkjv-nt-survey': 'data/2-nt-survey.json',
  'nkjv-1cor': 'data/3-corinthians.json',
  'nkjv-john': 'data/4-john.json',
  'nkjv-hp': 'data/5-hp.json',
  'nkjv-ot-survey': 'data/6-ot-survey.json',
  'nkjv-rj': 'data/7-rj.json',
  'nkjv-luke': 'data/8-luke.json',
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
