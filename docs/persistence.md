# Persistence

How user progress is stored, updated, and recomputed. The server is authoritative for the event log;
materialized state is a cache that can be rebuilt at any time.

## Storage layer

SQLite via [Drizzle](https://orm.drizzle.team) + `better-sqlite3`. Schema lives in
`packages/api/src/db/schema.ts`. WAL mode is on; foreign keys are enforced.

## Tables

### Auth (Better Auth)

`user`, `session`, `account`, `verification` are owned by Better Auth. We keep them in the Drizzle
schema so FK constraints from domain tables can reference `user.id`.

### `user_materials`

Which materials a user has enrolled in. `club_tier` is `150 | 300 | null` (null = full material).

### `graph_snapshots`

The memory graph plus card catalog for a (user, material, version) triple. Stored as JSON blobs
matching the [WASM wire format](wasm-api.md). Versioned so existing events can be replayed against a
known-good snapshot even after the content pipeline regenerates the graph.

### `review_events` — source of truth

Append-only log. Every call to `POST /api/sessions/:id/review` writes one row:

| column             | notes                                                                 |
| ------------------ | --------------------------------------------------------------------- |
| `id`               | UUID, server-generated today; client-generated later for offline sync |
| `snapshot_version` | which graph snapshot this event applies to                            |
| `card_id`          | source card, or null for re-drill / new-verse (progressive reveal)    |
| `shown` / `hidden` | node IDs of the card as served to the user                            |
| `grades`           | `[{ node_id, grade }]` — 1=Again, 2=Hard, 3=Good, 4=Easy              |

Indexed by `(user_id, material_id, timestamp_secs)` because replay is always filtered by
user+material and sorted by time.

### `edge_states` — materialized

Per-edge FSRS state: `stability`, `difficulty`, `last_review_secs`. Primary key is
`(user_id, material_id, edge_id)`. Recomputable from `review_events` by replaying the engine.

### `card_states` — materialized

Per-card state machine + schedule: `state`, `due_r`, `due_date_secs`, `priority`. Same primary key
shape. Also recomputable.

## Write path

`recordReview` (`packages/api/src/lib/review-log.ts`) runs in a single transaction:

1. Append the event to `review_events`.
2. Upsert the edges returned in `ReviewOutcome.edge_updates`.
3. Upsert every card from `engine.export_card_states()` — cheap and avoids having to track which
   cards moved.

Either everything lands or nothing does, so the log and the cache never drift.

## Read path

The engine loader (`EngineStore`, `packages/api/src/lib/engine.ts`) builds a `WasmEngine` from:

1. The latest `graph_snapshots` row for (user, material).
2. All `edge_states` rows for (user, material).
3. All `card_states` rows for (user, material).

Engines are cached in-process keyed by `(user_id, material_id)` — the Node process is long-running,
so reloading per request would be wasteful.

## Replay

Because the core algorithm is deterministic in `(current_state, grades, timestamp)`, any
materialized state can be rebuilt by:

1. Starting a fresh `WasmEngine` from the snapshot (no edge/card overrides).
2. Feeding `review_events` in timestamp order.
3. Exporting the final `edge_states` + `card_states`.

This makes `edge_states` / `card_states` a cache, not a source of truth, and unlocks the Phase 3D
sync flow: a fat client uploads offline events, the server merges by timestamp, replays, and returns
the authoritative materialized state.
