// Smoke test for verse-vault-wasm.
// Run with: node crates/wasm/test-smoke.js

import { WasmEngine } from './pkg/verse_vault_wasm.js';

const edgeState = { stability: 5.0, difficulty: 5.0, last_review_secs: 0 };

function makeEdge(id, kind, source, target) {
  return { id, kind, source, target, state: edgeState };
}

const graph = {
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

function addBi(kind, a, b) {
  const fwd = graph.next_edge_id++;
  const bwd = graph.next_edge_id++;
  graph.edges[String(fwd)] = makeEdge(fwd, kind, a, b);
  graph.edges[String(bwd)] = makeEdge(bwd, kind, b, a);
  graph.outgoing[String(a)].push(fwd);
  graph.incoming[String(b)].push(fwd);
  graph.outgoing[String(b)].push(bwd);
  graph.incoming[String(a)].push(bwd);
}

addBi('VerseGistVerseRef', 1, 0);
addBi('PhraseVerseGist', 2, 1);
addBi('PhraseVerseGist', 3, 1);
addBi('PhraseVerseGist', 4, 1);
addBi('PhrasePhrase', 2, 3);
addBi('PhrasePhrase', 3, 4);

const cards = [
  {
    id: 0,
    shown: [0],
    hidden: [2, 3, 4],
    state: 'New',
  },
];

console.log('Loading engine...');
const engine = new WasmEngine(
  JSON.stringify(graph),
  JSON.stringify(cards),
  '',
  '',
  0.9,
);

console.log('Starting session with the new verse...');
const newVerses = [
  { verse_ref: 0, verse_phrases: [2, 3, 4] },
];
engine.start_session(0n, JSON.stringify(newVerses), '');

console.log('Session remaining:', engine.session_remaining());

let step = 0;
while (!engine.session_is_done()) {
  const cardJson = engine.session_next();
  if (!cardJson) break;
  const card = JSON.parse(cardJson);
  console.log(`Step ${step}: source=${card.source_kind} reading=${card.is_reading} shown=${card.shown.length} hidden=${card.hidden.length}`);

  const grades = card.is_reading
    ? []
    : card.hidden.map((node_id) => ({ node_id, grade: 3 /* Good */ }));

  const outcomeJson = engine.session_review(
    JSON.stringify(grades),
    BigInt(step * 86400), // one day apart
  );
  const outcome = JSON.parse(outcomeJson);
  console.log(`  → edges updated: ${outcome.edge_updates.length}, redrills: ${outcome.redrills_inserted}`);

  step++;
  if (step > 20) {
    console.error('Infinite loop guard tripped');
    process.exit(1);
  }
}

console.log('Session done after', step, 'steps');

console.log('\nExporting state...');
const edgeStates = JSON.parse(engine.export_edge_states());
const cardStates = JSON.parse(engine.export_card_states());
console.log(`Edge states: ${edgeStates.length} edges`);
console.log(`Card states: ${cardStates.length} cards`);
console.log(`Card 0 state: ${cardStates[0].state}, due_date=${cardStates[0].due_date_secs}`);

if (cardStates[0].state !== 'review') {
  console.error(`FAIL: expected card state 'review', got '${cardStates[0].state}'`);
  process.exit(1);
}

const updatedEdges = edgeStates.filter((e) => Math.abs(e.stability - 5.0) > 0.001);
console.log('Sample edge stabilities:', edgeStates.slice(0, 4).map((e) => e.stability.toFixed(3)));
if (updatedEdges.length === 0) {
  console.error('FAIL: no edges were updated');
  process.exit(1);
}
console.log(`${updatedEdges.length} edges changed stability (of ${edgeStates.length})`);

console.log('\n✓ All smoke-test assertions passed');
