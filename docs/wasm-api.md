# WASM API

The `verse-vault-wasm` crate exposes the core engine to JavaScript. The
API is intentionally small: load, session, export. Data crosses the
boundary as JSON strings (easy to debug, forward-compatible).

## Building

```
wasm-pack build crates/wasm --target nodejs --out-dir pkg
```

For the browser: `--target web`.

## `class WasmEngine`

### Constructor

```ts
new WasmEngine(
  graph_json: string,
  cards_json: string,
  edge_states_json: string,   // '' or '[]' for fresh state
  card_states_json: string,   // '' or '[]' for fresh state
  desired_retention: number,  // e.g. 0.9
)
```

Loads the graph and card catalog. If edge/card states are provided,
they override the initial state built from the graph (this is how you
resume a user's progress from the database).

### Session lifecycle

```ts
start_session(now_secs: bigint, new_verses_json: string, params_json: string): void
session_next(): string | undefined  // JSON SessionCard, or undefined if done
session_review(grades_json: string, now_secs: bigint): string  // JSON ReviewOutcome
session_abort(): void
session_is_done(): boolean
session_remaining(): number
```

`start_session` transitions any `New` cards for the provided verses to
`Learning` (progressive reveal). Calling `session_abort` rolls them
back to `New`.

### Direct engine access (no session)

```ts
next_due_card(now_secs: bigint): number | undefined  // card_id of highest-priority due card
```

### Export for persistence

```ts
export_edge_states(): string   // JSON: EdgeStateEntry[]
export_card_states(): string   // JSON: CardStateEntry[]
```

Call these after each review (or batched) to persist to the database.

## JSON shapes

### Graph

The `Graph` type serializes as:

```json
{
  "nodes": { "<NodeId>": { "id": <NodeId>, "kind": <NodeKind> }, ... },
  "edges": { "<EdgeId>": { "id": <EdgeId>, "kind": "<EdgeKind>", "source": <NodeId>, "target": <NodeId>, "state": {...} | null }, ... },
  "outgoing": { "<NodeId>": [<EdgeId>, ...], ... },
  "incoming": { "<NodeId>": [<EdgeId>, ...], ... },
  "next_node_id": <u32>,
  "next_edge_id": <u32>
}
```

Note that HashMap keys in JSON are always strings, even though the
underlying NodeId/EdgeId are `u32` newtypes. NodeIds appearing as
values (not keys) serialize as plain numbers.

### Card

```json
{ "id": <u32>, "shown": [<NodeId>, ...], "hidden": [<NodeId>, ...], "state": "New" | "Learning" | "Review" | "Relearning" }
```

### NewVerseInfo (input to `start_session`)

```json
[{ "verse_ref": <u32>, "verse_phrases": [<u32>, ...] }, ...]
```

### SessionCard (returned by `session_next`)

```json
{
  "shown": [<u32>, ...],
  "hidden": [<u32>, ...],
  "is_reading": <bool>,
  "source_kind": "scheduled" | "redrill" | "new_verse",
  "source_card_id": <u32> | null
}
```

### Grades (input to `session_review`)

```json
[{ "node_id": <u32>, "grade": 1 | 2 | 3 | 4 }, ...]
// 1=Again, 2=Hard, 3=Good, 4=Easy
```

For reading-stage cards, pass `[]`.

### ReviewOutcome (returned by `session_review`)

```json
{
  "edge_updates": [{ "edge_id": <u32>, "grade": <1-4>, "weight": <f32> }, ...],
  "redrills_inserted": <usize>
}
```

### EdgeStateEntry (export / resume)

```json
{ "edge_id": <u32>, "stability": <f32>, "difficulty": <f32>, "last_review_secs": <i64> }
```

### CardStateEntry (export / resume)

```json
{
  "card_id": <u32>,
  "state": "new" | "learning" | "review" | "relearning",
  "due_r": <f32> | null,
  "due_date_secs": <i64> | null,
  "priority": <f32> | null
}
```

## Timestamps

All timestamps are Unix seconds, passed as `bigint` (JavaScript can't
represent `i64` as a regular number). Convert with `BigInt(Math.floor(Date.now() / 1000))`.

## Errors

Constructor and methods that parse JSON will throw JS `Error` on bad
input (mapped from Rust `JsError`).
