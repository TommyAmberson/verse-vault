/**
 * Material catalog. Today this is a static manifest; once the content
 * pipeline lands, the templates will come from the pipeline's output and
 * this file will read them off disk or a shared store.
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
      'Placeholder sample material — a single verse of 1 Corinthians until the content pipeline produces a full graph.',
  },
];

export function getMaterial(id: string): Material | undefined {
  return MATERIALS.find((m) => m.id === id);
}

export interface MaterialGraph {
  nodes: Record<string, { id: number; kind: unknown }>;
  edges: Record<string, MaterialEdge>;
  outgoing: Record<string, number[]>;
  incoming: Record<string, number[]>;
  next_node_id: number;
  next_edge_id: number;
}

interface MaterialEdge {
  id: number;
  kind: string;
  source: number;
  target: number;
  state: { stability: number; difficulty: number; last_review_secs: number };
}

export interface MaterialCard {
  id: number;
  shown: number[];
  hidden: number[];
  state: 'New' | 'Learning' | 'Review' | 'Relearning';
}

export interface MaterialTemplate {
  graph: MaterialGraph;
  cards: MaterialCard[];
}

export function buildMaterialTemplate(id: string): MaterialTemplate {
  if (id === 'nkjv-1cor') return buildSingleVerseTemplate();
  throw new Error(`Unknown material: ${id}`);
}

/** Mirrors `crates/wasm/test-smoke.js` — minimum graph the engine accepts. */
function buildSingleVerseTemplate(): MaterialTemplate {
  const edgeState = { stability: 5.0, difficulty: 5.0, last_review_secs: 0 };
  const graph: MaterialGraph = {
    nodes: {
      '0': { id: 0, kind: { VerseRef: { chapter: 3, verse: 16 } } },
      '1': { id: 1, kind: { VerseGist: { chapter: 3, verse: 16 } } },
      '2': { id: 2, kind: { Phrase: { text: 'phrase one', verse_id: 0, position: 0 } } },
      '3': { id: 3, kind: { Phrase: { text: 'phrase two', verse_id: 0, position: 1 } } },
      '4': { id: 4, kind: { Phrase: { text: 'phrase three', verse_id: 0, position: 2 } } },
    },
    edges: {},
    outgoing: { '0': [], '1': [], '2': [], '3': [], '4': [] },
    incoming: { '0': [], '1': [], '2': [], '3': [], '4': [] },
    next_node_id: 5,
    next_edge_id: 0,
  };

  const addBi = (kind: string, a: number, b: number) => {
    const fwd = graph.next_edge_id++;
    const bwd = graph.next_edge_id++;
    graph.edges[String(fwd)] = { id: fwd, kind, source: a, target: b, state: edgeState };
    graph.edges[String(bwd)] = { id: bwd, kind, source: b, target: a, state: edgeState };
    graph.outgoing[String(a)]!.push(fwd);
    graph.incoming[String(b)]!.push(fwd);
    graph.outgoing[String(b)]!.push(bwd);
    graph.incoming[String(a)]!.push(bwd);
  };

  addBi('VerseGistVerseRef', 1, 0);
  addBi('PhraseVerseGist', 2, 1);
  addBi('PhraseVerseGist', 3, 1);
  addBi('PhraseVerseGist', 4, 1);
  addBi('PhrasePhrase', 2, 3);
  addBi('PhrasePhrase', 3, 4);

  const cards: MaterialCard[] = [{ id: 0, shown: [0], hidden: [2, 3, 4], state: 'New' }];

  return { graph, cards };
}
