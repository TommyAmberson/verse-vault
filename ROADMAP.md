# Roadmap

Active work and planning happens in
[GitHub Issues](https://github.com/TommyAmberson/verse-vault/issues). This file records what has
shipped and points to the open work that's coming next.

## Phase 1: Core Algorithm ✅

Edge-based memory graph with FSRS integration.

* [x] Graph model (7 node types, 11 edge types, directionality)
* [x] FSRS bridge (retrievability, next_states, weighted interpolation)
* [x] Path enumeration (DFS, 5-hop, no revisits)
* [x] Anchor transfer (distance decay for reference derivation)
* [x] Credit assignment (6-step algorithm, source set expansion, fallback chain)
* [x] Scheduling (effective_R, due_date binary search, priority scoring)
* [x] Post-review cascade (edge→card mapping)
* [x] ReviewEngine facade
* [x] Session module (re-drills, progressive reveal)
* [x] Basic simulation framework

## Phase 2: Graph Builder + Content Pipeline ✅

Work with real Bible content.

* [x] Graph builder: structured verse data → Graph + edges
* [x] Card catalog builder: Graph → all card types per verse/chapter
* [x] Bible content ingestion (NKJV text with verse boundaries)
* [x] Phrase chunking (LLM-powered pipeline with typo flagging)
* [x] Club 150/300 verse list loading
* [x] Heading data loading

## Phase 3: Persistence + Server ✅

Architecture established in `docs/architecture.md`. TS server wrapping the Rust core via WASM; Node
on a VPS; Better Auth; Drizzle + SQLite; event-sourced reviews for clean offline sync.

### Phase 3A: WASM bindings ✅

* [x] New `crates/wasm/` crate with wasm-bindgen
* [x] Replace fsrs-rs with minimal FSRS-6 inference (WASM-compatible)
* [x] Serde derives on core types
* [x] Expose ReviewEngine + Session to JS
* [x] Node smoke test verifies the full session flow

### Phase 3B: Server foundation ✅

* [x] pnpm monorepo setup (`packages/api/`)
* [x] Hono server with health check
* [x] Drizzle + SQLite + migrations
* [x] Better Auth setup (email/password + Google OAuth)

### Phase 3C: Engine integration ✅

* [x] Load graph from DB, construct WASM engine
* [x] Session API endpoints (start/next/review/abort)
* [x] Review event logging
* [x] Edge/card state persistence

### Phase 3D: Sync API ✅

* [x] State download endpoint (`GET /api/sync/:materialId/state`)
* [x] Event upload + replay (`POST /api/sync/:materialId/events`)
* [x] Idempotent uploads via `client_event_id`
* [x] Stale-snapshot rejection (409)

### Phase 3E: Stats + Materials ✅

* [x] `GET /api/materials` (static manifest)
* [x] `POST /api/materials/enroll` (seeds graph + card_states)
* [x] `GET /api/materials/:id/status`
* [x] `GET /api/stats/:materialId`

## Phase 4: Frontends

Each sub-phase is its own mergeable workstream, comparable in scope to any of 3A–3E. Suggested order
— 4A unlocks real usage, 4B is a parallel-track CLI, 4C and 4D layer on top of 4A.

1. [#9 Phase 4A: Vue web app (thin client)](https://github.com/TommyAmberson/verse-vault/issues/9)
2. [#10 Phase 4B: CLI](https://github.com/TommyAmberson/verse-vault/issues/10)
3. [#11 Phase 4C: WASM offline in the web app](https://github.com/TommyAmberson/verse-vault/issues/11)
   — blocked by #9, #15, #16
4. [#12 Phase 4D: Tauri desktop](https://github.com/TommyAmberson/verse-vault/issues/12) — blocked
   by #9, #11

## Known tech debt

Deferred items from Phase 3 — none block Phase 4 on day one, but each should land before real users
exist.

* [#13 EngineStore eviction (TTL/LRU + engine.free())](https://github.com/TommyAmberson/verse-vault/issues/13)
* [#14 SessionStore eviction (idle reaper)](https://github.com/TommyAmberson/verse-vault/issues/14)
* [#15 WASM delta export for edge/card state](https://github.com/TommyAmberson/verse-vault/issues/15)
* [#16 Snapshot versioning + invalidation flow](https://github.com/TommyAmberson/verse-vault/issues/16)
* [#17 Retention tuning knob (per-user desiredRetention)](https://github.com/TommyAmberson/verse-vault/issues/17)
* [#18 Engine mutation before DB transaction in sync POST](https://github.com/TommyAmberson/verse-vault/issues/18)

## Future

Long-horizon ideas; not filed as issues yet.

* Per-user FSRS parameter optimization (from review history)
* Multiple translations (ESV, NIV — with licensing)
* Team features for QuizMeet teams
* Customizable learning flow
* Import from Anki
