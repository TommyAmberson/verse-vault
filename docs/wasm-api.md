# WASM API

The `verse-vault-wasm` crate exposes the HSRS engine to JavaScript. The boundary stays small: load,
review, export. Data crosses as JSON strings — debuggable, version-tolerant, and free of
`wasm-bindgen` value-conversion gotchas.

The active memory model is documented in
[`path-posterior-memory-model.md`](./path-posterior-memory-model.md); this doc only describes the
wire shapes a JS caller sees.

## Building

Two targets ship from the same Rust source:

```
# Server (Node 22). Consumed by `@verse-vault/api` as the
# `verse-vault-wasm` workspace package.
wasm-pack build crates/wasm --target nodejs --out-dir pkg

# Browser bundle. Consumed by `apps/web` via `vite-plugin-wasm`
# as the `verse-vault-wasm-web` workspace package; the wrapper
# script renames the generated package.json so both outputs can
# coexist in pnpm-workspace.yaml.
bash tools/build-wasm-web.sh    # wasm-pack build --target bundler --out-dir pkg-web
```

`--target web` was the original plan for the browser side but `--target bundler` is what we actually
ship — Vite handles the init / .wasm-asset wiring through `vite-plugin-wasm`, so the `bundler` shape
integrates cleaner than the standalone `web` target's manual `init()` call would.

The crate is also a plain `rlib`, so `cargo test -p verse-vault-wasm` runs the wire-format unit
tests and the `roundtrip` integration smoke without needing `wasm-pack`.

## `class WasmEngine`

### Constructor

```ts
new WasmEngine(
  material_json: string,           // MaterialData JSON
  material_config_json: string,    // MaterialConfig JSON; '' for defaults
  persisted_states_json: string,   // '' or '[]' for fresh state
  desired_retention: number,       // e.g. 0.9
  now_secs: bigint,                // unix seconds; seeds unseen TestStates
)
```

The constructor parses `material_json` into `MaterialData`, calls `build` to derive the cards and
seeded `TestState` table, then overlays any persisted entries (so the JS layer can resume a user's
progress from the database). `material_config_json` controls per-user scope toggles (headings, FTV,
new/review/club/chapter-list scopes); pass `''` to use `MaterialConfig::default()`.

`now_secs` is used to seed every fresh `TestState::new_unseen` — the seeded states have
`last_base_secs = now_secs - 365 days`, which puts them well below the target retention so the
scheduler will treat them as immediately due.

Throws a JS `Error` (mapped from `JsError`) on malformed JSON.

### Reviewing a card

```ts
replay_event(card_id: number, grade: number, now_secs: bigint): string
```

Applies a card review. `grade` is the FSRS-style integer rating:

| value | meaning |
| ----- | ------- |
| 1     | Again   |
| 2     | Hard    |
| 3     | Good    |
| 4     | Easy    |

The engine routes the grade through `Card::tests(atoms)`:

* **Atomic cards** (one contained test, e.g. `PhraseFill`, `VerseInChapter`) take a full FSRS step
  on that test — equivalent to vanilla FSRS.
* **Composite cards** (`Recitation`, `Citation`, `Ftv`) decompose the single grade across their
  contained tests via HSRS's Bayesian-share weight `(1 − p_i) / (1 − p_total)`. Tests whose pass was
  most surprising absorb the largest share; tests already certain to pass absorb a vanishing share.
* **Reading** cards have no contained tests and are a no-op.

Returns a JSON array of `TestUpdateWire` — one entry per state transition produced by the review:

```json
[
  {
    "key": { "kind": "PhraseFromContext", "element": { "kind": "Phrase", "verse_id": 0, "start_word": 3, "end_word": 6 } },
    "kind": "Sub",
    "before": { "stability": 1.0, "difficulty": 5.0, "last_seen_secs": ..., "last_base_secs": ..., "last_root_secs": ... },
    "after":  { ... }
  },
  ...
]
```

`kind` is `"Root"` for an atomic card's single full FSRS update (advances `last_root_secs`) and
`"Sub"` for each contained test of a composite card (interpolates `last_base_secs` toward `now`,
leaves `last_root_secs` untouched). `before` / `after` are full `TestState` snapshots — the schema
mirrors `verse_vault_core::test_state::TestState`.

Throws a JS `Error` if the card id is unknown or `grade` is outside `1..=4`.

### Picking the next card

```ts
next_review_card(now_secs: bigint): number | undefined
next_memorize_card(now_secs: bigint): number | undefined
```

`next_review_card` returns the `card_id` of the card whose weakest test is furthest below the target
retention, or `undefined` if every card is currently above target. Cards whose tests were touched
within the sibling-cooldown window are skipped.

`next_memorize_card` picks the next card from the new-verse memorize pool (graduated verses are
excluded). Used by the memorize flow; the review flow uses `next_review_card`.

### Rendering a card

```ts
get_card_render(card_id: number): string
```

Returns the JSON the frontend needs to render a card prompt and its expected answer:

```json
{
  "cardId": 42,
  "verseId": 0,
  "kind": { "kind": "PhraseFill", "position": 1 },
  "verse": {
    "book": "1 Corinthians",
    "chapter": 13,
    "verse": 4,
    "phraseWordCounts": [3, 3, ...],
    "annotations": [{ "wordIndex": 5, "kind": "bold" }],
    "ftvWordCount": 3,
    "headings": [{ "headingIdx": 0, "startChapter": 13, "startVerse": 1, "endChapter": 13, "endVerse": 13 }],
    "clubs": ["Club150"]
  }
}
```

`kind` is the card kind tagged with any kind-specific fields (`position`, `headingIdx`, `tier`,
`withCitation`). `verse` is the verse's structural render payload — no NKJV text crosses the wire;
the API server composes the visible HTML from this structural data plus the canonical text fetched
from api.bible. `phraseWordCounts` gives the word count of each phrase, `annotations` carries the
user's keyword markup as zero-based word indices, `ftvWordCount` is the prefix length, and
`headings` / `clubs` describe membership for this verse. Throws if the card id is unknown or the
verse has no render data.

### Exporting state for persistence

```ts
export_test_states(): string
```

Returns a JSON array of `TestStateEntry` — one entry per known `(TestKind, ElementId)` pair:

```json
[
  {
    "element": { "kind": "Phrase", "verse_id": 0, "start_word": 3, "end_word": 6 },
    "test_kind": "PhraseFromContext",
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
  "kind": "PhraseFromContext" | "VerseRefPosition" | "VerseChapter"
        | "VerseBook" | "VerseHeading" | "VerseClub",
  "element": { "kind": "<ElementKind>", ... }
}
```

### `ElementId` (tagged on `kind`)

```json
{ "kind": "Phrase", "verse_id": <u32>, "start_word": <u16>, "end_word": <u16> }
{ "kind": "VerseRefPosition", "verse_id": <u32> }
{ "kind": "VerseChapterBinding", "verse_id": <u32> }
{ "kind": "VerseBookBinding", "verse_id": <u32> }
{ "kind": "VerseHeadingBinding", "verse_id": <u32>, "heading_idx": <u16> }
{ "kind": "VerseClubBinding", "verse_id": <u32>, "tier": "Club150" | "Club300" }
```

### `Grade`

`replay_event` takes the FSRS-style integer rating directly (1=Again, 2=Hard, 3=Good, 4=Easy); no
string form crosses the WASM boundary.

### `CardKind`

Returned by `get_card_render` under `card.kind`. Serialised with internal tagging on `kind`:

```json
{ "kind": "PhraseFill", "position": <u16> }
{ "kind": "VerseAtVerseRef" }
{ "kind": "VerseInChapter" }
{ "kind": "VerseInBook" }
{ "kind": "VerseInHeading", "headingIdx": <u16> }
{ "kind": "VerseInClub", "tier": "Club150" | "Club300" }
{ "kind": "Recitation" }
{ "kind": "Citation" }
{ "kind": "Ftv", "withCitation": <bool> }
{ "kind": "Reading" }
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

`last_seen_secs` is bumped on every update — root or sub. `last_base_secs` is the anchor point for
the forgetting curve; sub-updates interpolate it linearly toward `now` proportional to the
Bayesian-share weight rather than resetting it. `last_root_secs` only advances on a root update from
an atomic-card review; the scheduler uses it to bias toward stale roots.

## Timestamps

All timestamps are Unix seconds, passed as `bigint` (JS `number` can't safely represent `i64`).
Convert with `BigInt(Math.floor(Date.now() / 1000))`.

## Errors

The constructor throws a JS `Error` (mapped from `JsError`) on malformed JSON. `replay_event` and
`get_card_render` throw on unknown card ids; `replay_event` additionally rejects grades outside
`1..=4`. `next_review_card`, `next_memorize_card`, and `export_test_states` are infallible.
