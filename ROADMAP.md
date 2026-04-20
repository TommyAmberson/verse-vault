# Roadmap

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

## Phase 3: Persistence + Server + Clients

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

### Phase 3E: Stats + Materials

* [ ] Material enrollment
* [ ] Progress stats

### Phase 3F: Frontends

* [ ] Vue web app
* [ ] Tauri desktop app
* [ ] CLI for terminal review

## Future

* [ ] Per-user FSRS parameter optimization (from review history)
* [ ] Multiple translations (ESV, NIV — with licensing)
* [ ] Team features for QuizMeet teams
* [ ] Customizable learning flow
* [ ] Import from Anki
