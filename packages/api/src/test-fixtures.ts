import { randomUUID } from 'node:crypto';

import type { DB } from './db/client.js';
import * as schema from './db/schema.js';

/** Minimal graph shape matching the WASM wire format. */
export interface FixtureGraph {
  nodes: Record<string, { id: number; kind: unknown }>;
  edges: Record<string, FixtureEdge>;
  outgoing: Record<string, number[]>;
  incoming: Record<string, number[]>;
  next_node_id: number;
  next_edge_id: number;
}

interface FixtureEdge {
  id: number;
  kind: string;
  source: number;
  target: number;
  state: { stability: number; difficulty: number; last_review_secs: number };
}

export interface FixtureCard {
  id: number;
  shown: number[];
  hidden: number[];
  state: 'New' | 'Learning' | 'Review' | 'Relearning';
}

/**
 * Builds a minimal three-phrase verse graph: one verse reference, one gist, three phrases.
 * Matches the shape used in `crates/wasm/test-smoke.js` so the engine will accept it.
 */
export function buildSingleVerseFixture(): { graph: FixtureGraph; cards: FixtureCard[] } {
  const edgeState = { stability: 5.0, difficulty: 5.0, last_review_secs: 0 };
  const graph: FixtureGraph = {
    nodes: {
      '0': { id: 0, kind: { Reference: { chapter: 3, verse: 16 } } },
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

  addBi('VerseGistReference', 1, 0);
  addBi('PhraseVerseGist', 2, 1);
  addBi('PhraseVerseGist', 3, 1);
  addBi('PhraseVerseGist', 4, 1);
  addBi('PhrasePhrase', 2, 3);
  addBi('PhrasePhrase', 3, 4);

  const cards: FixtureCard[] = [{ id: 0, shown: [0], hidden: [2, 3, 4], state: 'New' }];

  return { graph, cards };
}

export interface SeedOptions {
  db: DB;
  userId: string;
  materialId: string;
  version?: number;
}

/** Inserts a user, enrollment, and graph snapshot — enough to load an engine. */
export function seedUserWithFixture(opts: SeedOptions): { snapshotId: string; version: number } {
  const { db, userId, materialId } = opts;
  const version = opts.version ?? 1;
  const { graph, cards } = buildSingleVerseFixture();
  const now = Math.floor(Date.now() / 1000);

  db.insert(schema.user)
    .values({
      id: userId,
      email: `${userId}@example.com`,
      name: userId,
      emailVerified: false,
      createdAt: new Date(now * 1000),
      updatedAt: new Date(now * 1000),
    })
    .run();
  db.insert(schema.userMaterials)
    .values({ userId, materialId, clubTier: null, createdAt: now })
    .run();
  const snapshotId = randomUUID();
  db.insert(schema.graphSnapshots)
    .values({
      id: snapshotId,
      userId,
      materialId,
      version,
      graphData: Buffer.from(JSON.stringify(graph), 'utf8'),
      cardsData: Buffer.from(JSON.stringify(cards), 'utf8'),
      createdAt: now,
    })
    .run();

  return { snapshotId, version };
}
