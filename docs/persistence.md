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

Append-only log. Every drill review (online or uploaded offline) writes one row. Progressive-reveal
reading cards are intentionally skipped — they don't change engine state, so logging them would make
replay non-deterministic.

| column             | notes                                                                 |
| ------------------ | --------------------------------------------------------------------- |
| `id`               | server-generated UUID, stable row identity                            |
| `client_event_id`  | idempotency key; server-generated UUID for online, client for offline |
| `snapshot_version` | which graph snapshot this event applies to                            |
| `card_id`          | source card, or null for re-drill                                     |
| `shown` / `hidden` | node IDs of the card as served to the user                            |
| `grades`           | `[{ node_id, grade }]` — 1=Again, 2=Hard, 3=Good, 4=Easy              |

Two indexes:

* `(user_id, material_id, timestamp_secs)` — replay is always filtered by user+material and sorted
  by time.
* Unique on `(user_id, material_id, client_event_id)` — re-uploading the same batch must not
  double-apply events.

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

## Replay and sync

Credit assignment and FSRS updates are pure functions of `(current_state, grades, timestamp)`, so
the materialized state is recomputable. Phase 3D exposes this as a sync API for fat clients (Tauri,
offline web):

### Upload flow — `POST /api/sync/:materialId/events`

1. Client sends a batch of events, each keyed by a client-generated `clientEventId` (UUID).
2. Server rejects the batch (409) if any event's `snapshotVersion` doesn't match the current
   snapshot — the client must re-pull `/state` before syncing.
3. Server drops events whose `clientEventId` already exists for this (user, material). Remaining
   events are sorted by `(timestampSecs, clientEventId)` for stable ordering.
4. For each fresh event, the server calls `WasmEngine.replay_event(shown, hidden, grades, ts)` which
   invokes the core's `review_transient` — same credit assignment + FSRS path as the online
   `session_review`, but session-independent.
5. In a single transaction the server appends the new events, upserts the union of changed edges,
   and upserts `card_states` from the engine's full export.
6. Response returns the engine's full edge/card state plus the new `lastEventId`, so the client can
   replace its local cache in one shot.

### Determinism contract

Replaying a sequence of events through a fresh engine yields the same materialized state as applying
them one-by-one through live sessions. The sync test `sync.test.ts` asserts parity between the
online path and the sync path on an identical event.

### Known limitations (Phase 3D)

* **No snapshot-to-snapshot migration.** `graph_snapshots.version` is wired but nothing increments
  it; when the content pipeline reissues a material we'll need to re-build edge/card state and
  decide what to do with events tied to the old version.
* **Live engine, not fresh replay.** Offline events are applied to the in-process cached engine, so
  edge state reflects "server state before + offline events in timestamp order within the batch."
  This is correct for single-device offline usage; truly concurrent multi-device edits are out of
  scope.
* **Reading cards aren't logged.** A client that lost its progressive-reveal progress will start
  from the beginning on reconnect; only drill grades are preserved.
