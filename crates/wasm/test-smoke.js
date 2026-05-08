// Smoke test for verse-vault-wasm.
// Run with: node crates/wasm/test-smoke.js

import { WasmEngine } from './pkg/verse_vault_wasm.js';

const material = {
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

const NOW = BigInt(Math.floor(Date.UTC(2026, 4, 8) / 1000));

console.log('Loading engine...');
const engine = new WasmEngine(JSON.stringify(material), '', 0.9, NOW);

const initialStates = JSON.parse(engine.export_test_states());
console.log(`Seeded ${initialStates.length} test states`);
if (initialStates.length === 0) {
  console.error('FAIL: engine seeded no test states');
  process.exit(1);
}

console.log('Stepping through reviews...');
let step = 0;
let now = NOW;
while (step < 20) {
  const cardId = engine.next_card(now);
  if (cardId === undefined) {
    console.log(`Step ${step}: next_card returned undefined; loop done`);
    break;
  }

  const wireJson = engine.replay_event(cardId, 3, now);
  const updates = JSON.parse(wireJson);
  console.log(
    `Step ${step}: cardId=${cardId} → ${updates.length} test update(s)` +
      (updates.length > 0 ? ` (${updates.map((u) => u.kind).join(',')})` : ''),
  );

  now += 86400n; // one day forward per step
  step++;
}

if (step === 0) {
  console.error('FAIL: never reviewed any card');
  process.exit(1);
}

console.log('\nExporting state...');
const finalStates = JSON.parse(engine.export_test_states());
console.log(`Final: ${finalStates.length} test states`);

const movedStates = finalStates.filter((s) => BigInt(s.last_seen_secs) > NOW);
console.log(`${movedStates.length} test states had last_seen advance`);
if (movedStates.length === 0) {
  console.error('FAIL: no test state had last_seen advance');
  process.exit(1);
}

console.log('\n✓ All smoke-test assertions passed');
