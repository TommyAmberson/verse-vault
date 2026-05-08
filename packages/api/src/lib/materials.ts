/**
 * Material catalog. Today this is a static manifest with bundled JSON
 * fixtures; once the content pipeline lands, the JSON will come from the
 * pipeline's output and this file will read them off disk or a shared
 * store. Kept inline so tests don't need to wire up a data directory.
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
    description:
      'Placeholder sample material — a single verse stand-in until the content pipeline produces a full graph.',
  },
];

export function getMaterial(id: string): Material | undefined {
  return MATERIALS.find((m) => m.id === id);
}

/** Stand-in MaterialData for `nkjv-1cor` — one verse from John 3:16, sized
 *  to round-trip through the WASM engine in tests. Mirrors the fixture in
 *  `crates/wasm/test-smoke.js`. The content pipeline will replace this with
 *  the real Corinthians dataset when it lands. */
const NKJV_1COR_FIXTURE = {
  year: 3,
  books: ['John'],
  chapters: [{ book: 'John', number: 3, start_verse: 16, end_verse: 16 }],
  verses: [
    {
      book: 'John',
      chapter: 3,
      verse: 16,
      text: 'For God so loved the world that he gave',
      phrases: ['For God', 'so loved', 'the world', 'that he gave'],
      ftv: 'For God',
      clubs: [],
    },
  ],
  headings: [],
};

const MATERIAL_DATA: Record<string, unknown> = {
  'nkjv-1cor': NKJV_1COR_FIXTURE,
};

/**
 * Bundled `MaterialData` JSON for a material id. Returns the JSON string
 * — the WASM constructor parses it server-side. Throws if the id is
 * unknown.
 */
export function getMaterialJson(id: string): string {
  const data = MATERIAL_DATA[id];
  if (data === undefined) throw new Error(`Unknown material: ${id}`);
  return JSON.stringify(data);
}
