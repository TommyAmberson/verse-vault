# Persistence

How user progress is stored, updated, and recomputed. The server is authoritative for the event log;
materialised state is a cache that can be rebuilt by replay at any time.

## Storage layer

SQLite via [Drizzle](https://orm.drizzle.team) + `better-sqlite3`. Schema lives in
`packages/api/src/db/schema.ts`. WAL mode is on; foreign keys are enforced. The DB file path is
configurable via `DATABASE_PATH` (defaults to `packages/api/data/verse-vault.db` in dev).

## Tables

### Auth (Better Auth)

`user`, `session`, `account`, `verification` are owned by Better Auth. They live in the Drizzle
schema so FK constraints from domain tables can reference `user.id`. Regenerate via
`pnpm dlx @better-auth/cli generate` if the upstream shape changes.

### `user_materials`

Which materials a user has enrolled in. Primary key `(user_id, material_id)`. `club_tier` is
`150 | 300 | null` (null = full material).

### `user_year_settings`

Per-(user, material) material-picker toggles that drive the engine's `MaterialConfig` at
construction time:

| column               | notes                                                                    |
| -------------------- | ------------------------------------------------------------------------ |
| `headings`           | boolean — include heading bindings                                       |
| `ftv`                | boolean — include FTV cards                                              |
| `new_scope`          | `off` \| `up150` \| `up300` \| `all` — which tiers introduce new verses  |
| `review_scope`       | same domain — which tiers receive review-only treatment                  |
| `club_card_scope`    | same domain — which tiers get the per-verse "Which club?" card           |
| `chapter_list_scope` | `off` \| `up150` \| `up300` (no `all` — Full never emits a chapter-list) |
| `lesson_batch_size`  | integer — memorize-session batch size                                    |

Per-tier effective status is derived: a tier covered by `new_scope` is Active; covered only by
`review_scope` is Maintenance; covered by neither is Paused. Settings changes invalidate the
in-memory engine for the key (`EngineStore.invalidate`).

### `graph_snapshots`

The bundled `MaterialData` blob the engine builds from, keyed by `(user_id, material_id, version)`.
Stored as a UTF-8 JSON buffer. Versioned so existing events can be replayed against a known-good
snapshot even after the content pipeline reissues the bundled material.

A unique index on `(user_id, material_id, version)` prevents two concurrent `EngineStore.load`
callers from racing each other into duplicate version rows. `EngineStore.load` compares the bundled
JSON SHA against the stored snapshot on every call; a mismatch bumps the version and drops the
cached engine.

### `review_events` — source of truth

Append-only log. Every grade write (online via `/api/cards/review`, offline-batched via
`/api/sync/:materialId/events`) appends one row. Reading cards are no-ops in the engine and are
intentionally not logged.

| column             | notes                                                                                                        |
| ------------------ | ------------------------------------------------------------------------------------------------------------ |
| `id`               | server-generated UUID; stable row identity                                                                   |
| `client_event_id`  | idempotency key; server generates a UUID for online reviews, the client supplies its own for offline batches |
| `snapshot_version` | which `graph_snapshots` version this event applies to                                                        |
| `timestamp_secs`   | when the user submitted the grade                                                                            |
| `card_id`          | which card was graded                                                                                        |
| `grade`            | `1=Again, 2=Hard, 3=Good, 4=Easy` — one grade per event                                                      |

Two indexes:

* `(user_id, material_id, timestamp_secs)` — replay is always filtered by user+material and sorted
  by time.
* Unique on `(user_id, material_id, client_event_id)` — re-uploading the same batch must not
  double-apply events.

There is no `shown` / `hidden` / multi-grade payload here. One card = one grade; the engine
decomposes that single grade across the card's contained tests internally via Bayesian-share
([`path-posterior-memory-model.md`](path-posterior-memory-model.md)).

### `test_states` — materialised

Per-test FSRS state, fully recomputable by replaying `review_events` through a fresh engine. Primary
key `(user_id, material_id, test_kind, element)`.

| column            | notes                                                                                                            |
| ----------------- | ---------------------------------------------------------------------------------------------------------------- |
| `test_kind`       | one of `PhraseFromContext`, `VerseRefPosition`, `VerseChapter`, `VerseBook`, `VerseHeading`, `VerseClub`         |
| `element`         | serde-tagged JSON form of `core::ElementId`; opaque to the API, round-tripped verbatim through the WASM boundary |
| `stability`       | `f32` — FSRS stability                                                                                           |
| `difficulty`      | `f32` — FSRS difficulty                                                                                          |
| `last_seen_secs`  | bumped on every update (root or sub)                                                                             |
| `last_base_secs`  | anchor for the forgetting curve; sub-updates interpolate this toward `now`                                       |
| `last_root_secs`  | only advances on a root update from an atomic-card review                                                        |
| `pending_relearn` | integer (0/1) — sticky after an Again grade; cleared on any non-Again                                            |

This replaces the older split between `edge_states` and `card_states` from the pre-HSRS edge-based
model. With per-test FSRS state on per-verse atomic bindings, card "state" is fully derived from the
contained tests' states at scheduling time — there's no separate `card_states` table.

### `graduated_verses`

Per-user verse-graduation log. Cards built from MaterialData start in `CardState::New`; on engine
load, `EngineStore.load` calls `engine.graduate_verse(verseId)` for every row in this table to flip
the cards into `Active`. Primary key `(user_id, material_id, verse_id)`.

### `apibible_passages` + `apibible_sections`

Cached api.bible content. Per the
[API.Bible Acceptable Use](https://api.bible/terms-and-conditions#acceptable_use) clause, cached
entries must be refreshed within 30 days of fetch and may not be used for AI/LLM training,
derivative format conversion, or systematic bulk extraction. `ApibibleCache` enforces the TTL via
TTL-on-read and prune-on-load; the bulk-extraction clause is why `/sync/state` does not ship a bulk
`renders` field (the opt-in `/api/materials/:id/renders` endpoint is the only path that delivers
more than one composed card per request, and it fires only at explicit user request via the per-deck
"Available offline" toggle).

* `apibible_passages` — chapter HTML, one row per `(bibleId, "{USX}.{ch}")`.
* `apibible_sections` — per-book section list as a JSON string, one row per
  `(bibleId, USX bookCode)`.

Indexed on `fetched_at` so the prune-on-load sweep can find expired rows cheaply.

## Write path

`persistEngineState` (`packages/api/src/lib/review-log.ts`) runs the per-event write under a single
transaction:

1. Append the events to `review_events` (dedup on `client_event_id` is enforced by the unique
   index).
2. Upsert the changed `test_states` rows — the engine reports which keys it touched via the
   `TestUpdateWire[]` return of `WasmEngine.replay_event`; the API filters
   `WasmEngine.export_test_states()` down to that set before writing.

Either everything lands or nothing does, so the log and the materialised cache never drift apart.

## Read path

`EngineStore.load` (`packages/api/src/lib/engine.ts`) builds a `WasmEngine` from:

1. The latest `graph_snapshots` row for `(user, material)`. If the bundled JSON has changed since
   that row was written, a new version row is inserted and the cached engine is invalidated.
2. The full set of `test_states` rows for `(user, material)`, passed to the constructor as
   `persisted_states_json`. Legacy positional `Phrase` elements are translated to the range form on
   the fly (`adaptElement` in `engine.ts`); rows whose position no longer maps to a valid range are
   dropped.
3. The `user_year_settings` row, serialised as the `MaterialConfig` JSON the constructor takes.
4. Every `graduated_verses` row for `(user, material)`, applied via
   `engine.graduate_verse(verseId)`.

Engines are cached in-process keyed by `(user_id, material_id)` — the Node process is long-running,
so reloading per request would be wasteful. The cache is invalidated on snapshot bumps and on
material-picker writes (`invalidate(key)`).

## Replay and sync

Credit assignment and FSRS updates are pure functions of
`(current_state, card_id, grade, timestamp)`, so the materialised state is recomputable.
`/api/sync/:materialId/events` exposes this as a fat-client upload endpoint:

### Upload flow — `POST /api/sync/:materialId/events`

1. Client sends a batch of events, each keyed by a client-generated `clientEventId` (UUID).
2. Server rejects the batch (409) if any event's `snapshotVersion` doesn't match the current
   snapshot — the client must re-pull `/state` before syncing.
3. Server filters out events whose `clientEventId` already exists for this `(user, material)`.
   Remaining events are sorted by `(timestampSecs, clientEventId)` for stable ordering.
4. For each fresh event the server calls `WasmEngine.replay_event(cardId, grade, timestampSecs)` —
   the same call the thin-client `/api/cards/review` route uses, just batched.
5. In a single transaction the server appends the new events and upserts the touched `test_states`
   rows.
6. The response returns the full set of test states plus the new `lastEventId` so the client can
   replace its local cache in one shot.

### Determinism contract

Replaying a sequence of events through a fresh engine yields the same materialised state as applying
them one-by-one through online reviews. The sync test (`packages/api/src/routes/sync.test.ts`)
asserts parity between the online and sync paths on an identical event.

### Known limitations

* **Live engine, not fresh replay.** Offline events are applied to the in-process cached engine, so
  test state reflects "server state before + offline events in timestamp order within the batch."
  This is correct for single-device offline usage; truly concurrent multi-device edits with
  overlapping timelines are out of scope.
* **Reading cards aren't logged.** A client that lost its progressive-reveal progress will start
  from the beginning on reconnect; only drill grades are preserved.
* **Element-shape drift on snapshot bumps.** Legacy positional `Phrase` rows are translated to the
  range form on load, but a `phraseWordCounts` change that _shifts_ a phrase's boundaries (rather
  than just renumbering) drops the old row's FSRS state — the phrase becomes a different element and
  seeds fresh.
