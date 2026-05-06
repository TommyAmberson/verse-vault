# WASM API

The `verse-vault-wasm` crate exposes the HSRS engine to JavaScript. The boundary stays small: load,
review, export. Data crosses as JSON strings — debuggable, version-tolerant, and free of
`wasm-bindgen` value-conversion gotchas.

The active memory model is documented in
[`path-posterior-memory-model.md`](./path-posterior-memory-model.md); this doc only describes the
wire shapes a JS caller sees.

## Building

```
wasm-pack build crates/wasm --target nodejs --out-dir pkg
```

For the browser: `--target web`.

The crate is also a plain `rlib`, so `cargo test -p verse-vault-wasm` runs the wire-format unit
tests and the `roundtrip` integration smoke without needing `wasm-pack`.

## `class WasmEngine`

### Constructor

```ts
new WasmEngine(
  material_json: string,         // MaterialData JSON
  persisted_states_json: string, // '' or '[]' for fresh state
  desired_retention: number,     // e.g. 0.9
  now_secs: bigint,              // unix seconds; seeds unseen TestStates
)
```

The constructor parses `material_json` into `MaterialData`, calls `build` to derive the cards and
seeded `TestState` table, then overlays any persisted entries (so the JS layer can resume a user's
progress from the database).

`now_secs` is used to seed every fresh `TestState::new_unseen` — the seeded states have
`last_base_secs = now_secs - 365 days`, which puts them well below the target retention so the
scheduler will treat them as immediately due.

Throws a JS `Error` (mapped from `JsError`) on malformed JSON.

### Reviewing a card

```ts
replay_event(card_id: number, grades_json: string, now_secs: bigint): string
```

Applies a card review. `grades_json` is a JSON array of one entry per test the card grades:

```json
[
  { "key": { "kind": "PhraseFromChain", "element": { "kind": "Phrase", "verse_id": 0, "position": 1 } }, "grade": "Good" },
  ...
]
```

`Grade` is one of `"Again" | "Hard" | "Good" | "Easy"`. The set of `key`s must match
`card.tests(atoms)` exactly — the engine asserts on mismatch.

Returns a JSON array of `TestUpdateWire` — one entry per state transition produced by the review,
including both directly graded tests and propagated neighbours:

```json
[
  {
    "key": { "kind": "PhraseFromChain", "element": { "kind": "Phrase", "verse_id": 0, "position": 1 } },
    "kind": "Direct",
    "before": { "stability": 1.0, "difficulty": 5.0, "last_seen_secs": ..., "last_base_secs": ..., "last_root_secs": ... },
    "after":  { ... }
  },
  ...
]
```

`kind` is `"Direct"` for the tests the card grades directly and `"Propagated"` for neighbours
touched via the static propagation table. `before` / `after` are full `TestState` snapshots — the
schema mirrors `verse_vault_core::test_state::TestState`.

### Picking the next card

```ts
next_card(now_secs: bigint): number | undefined
```

Returns the `card_id` of the card whose weakest test is furthest below the target retention, or
`undefined` if every card is currently above target. Cards whose tests were touched within the
sibling-cooldown window are skipped.

### Exporting state for persistence

```ts
export_test_states(): string
```

Returns a JSON array of `TestStateEntry` — one entry per known `(TestKind, ElementId)` pair:

```json
[
  {
    "element": { "kind": "Phrase", "verse_id": 0, "position": 1 },
    "test_kind": "PhraseFromChain",
    "stability": 12.3,
    "difficulty": 5.5,
    "last_seen_secs": 1700000000,
    "last_base_secs": 1699000000,
    "last_root_secs": 1690000000
  },
  ...
]
```

Persist this array between sessions and feed it back to the constructor as `persisted_states_json`
to resume.

## JSON shapes

### `TestKey`

```json
{
  "kind": "PhraseFromChain" | "PhraseFromContext" | "VerseRefPosition" | "VerseChapter"
        | "VerseBook" | "VerseHeading" | "VerseClub",
  "element": { "kind": "<ElementKind>", ... }
}
```

### `ElementId` (tagged on `kind`)

```json
{ "kind": "Phrase", "verse_id": <u32>, "position": <u16> }
{ "kind": "VerseRefPosition", "verse_id": <u32> }
{ "kind": "VerseChapterBinding", "verse_id": <u32> }
{ "kind": "VerseBookBinding", "verse_id": <u32> }
{ "kind": "VerseHeadingBinding", "verse_id": <u32>, "heading_idx": <u16> }
{ "kind": "VerseClubBinding", "verse_id": <u32>, "tier": "Club150" | "Club300" }
```

### `Grade`

```json
"Again" | "Hard" | "Good" | "Easy"
```

### `TestState`

```json
{
  "stability": <f32>,
  "difficulty": <f32>,
  "last_seen_secs": <i64>,
  "last_base_secs": <i64>,
  "last_root_secs": <i64>
}
```

`last_seen_secs` is bumped on every update (direct or propagated). `last_base_secs` is the anchor
point for the forgetting curve — propagation interpolates it rather than resetting it.
`last_root_secs` only advances on direct grades; the scheduler uses it to bias toward stale roots.

## Timestamps

All timestamps are Unix seconds, passed as `bigint` (JS `number` can't safely represent `i64`).
Convert with `BigInt(Math.floor(Date.now() / 1000))`.

## Errors

The constructor and `replay_event` throw a JS `Error` (mapped from `JsError`) on bad JSON or
parse-time failures. `next_card` and `export_test_states` are infallible.
