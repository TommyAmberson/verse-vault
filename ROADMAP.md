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

### Future client targets

The Vue SPA in `apps/web/` is structured to ship to three surfaces from the same bundle:

* **web** (shipping now, thin client) — `VITE_BASE_PATH=/vv/`, no service worker
* **PWA** (post-launch, not yet an issue) — same source as web + `vite-plugin-pwa` registers a
  service worker; `apps/web/public/_redirects` already provides the SPA fallback PWAs need.
  Mobile-installable.
* **Tauri desktop** (#12) — `VITE_BASE_PATH=/`, absolute API URL, SW skipped via `__TAURI__` guard

All three share the same Better Auth login flow; cross-origin variants (Tauri, and the web client
once the subdomain cutover happens) will need a Better Auth cookie strategy decision —
`SameSite=None` cookies vs bearer tokens. The natural moment to decide is when the subdomain cutover
happens (see `docs/deployment.md` "Future: cutting over to subdomains").

## Phase 3 tech debt ✅

All six items deferred from Phase 3 have shipped. Listed for context — none are open.

* [#13 EngineStore eviction (TTL/LRU + engine.free())](https://github.com/TommyAmberson/verse-vault/issues/13)
  — shipped in api 0.1.20.
* [#14 SessionStore eviction (idle reaper)](https://github.com/TommyAmberson/verse-vault/issues/14)
  — closed as stale; `SessionStore` was absorbed into `EngineStore` + per-request `withLock`.
* [#15 WASM delta export for edge/card state](https://github.com/TommyAmberson/verse-vault/issues/15)
  — shipped in api 0.1.21. Turned out to be a pure TS-side fix: `replay_event`'s wire already
  carried the data; the route handlers just weren't reading it.
* [#16 Snapshot versioning + invalidation flow](https://github.com/TommyAmberson/verse-vault/issues/16)
  — shipped in api 0.1.22. Auto-bumps via SHA comparison; `material_data` BLOB dropped from
  `graph_snapshots` (loaded from disk on every engine build).
* [#17 Retention tuning knob (per-user desiredRetention)](https://github.com/TommyAmberson/verse-vault/issues/17)
  — shipped in api 0.1.19.
* [#18 Engine mutation before DB transaction in sync POST](https://github.com/TommyAmberson/verse-vault/issues/18)
  — shipped.

## Before public launch

Near-term operational work for the run-up to real users. Not filed as issues — promote when a phase
picks them up.

* ✅ **Observability** — structured JSON request log + `X-Request-Id` correlation. Shipped in api
  0.1.24.
* ✅ **Rate limiting + abuse controls** — per-IP token-bucket with two tiers (120 req/min general,
  10 req/min for `/api/auth/*`). Shipped in api 0.1.24.
* ✅ **Database backups + migration testing** — Litestream → Backblaze B2 (provisioned via
  `deploy/provision.sh` phase 7). `deploy/restore-drill.sh` proves the chain restores end-to-end
  with `PRAGMA integrity_check` + row-count diff vs live; `deploy/litestream-health.sh` reports
  daemon liveness + last successful WAL ship. Migration rehearsal is implicit — every drill
  exercises the same SQL the next deploy will run, against real-shape production data.
* ⏸ **Content pipeline integration** — wire the `tools/` Python scripts (Anki parsing, verse
  chunking) into material enrollment so a new material produces a `graph_snapshots` row end-to-end.
  Currently `data/<materialId>.json` is hand-edited; we want a reproducible build.

## Future

Long-horizon ideas; not filed as issues yet.

* HSRS-aware FSRS parameter optimizer (from verse-vault review history). Standard FSRS optimizers
  (Anki, fsrs-rs) assume each review is an independent observation under a single-card FSRS step;
  feeding their fits into verse-vault's HSRS engine double-counts the cross-reinforcement that
  composite cards already model via Bayesian decomposition, producing biased predictions either way
  (params absorb cross-reinforcement when fit on Anki-style histories; standard fits over-attribute
  partial-weight updates as full FSRS steps when fit on HSRS-style histories). Need a custom
  optimizer whose forward pass is `engine.review` (the HSRS-style decomposed step), then fit `w` via
  gradient descent or grid search against actual user review history. The probabilistic-learner sim
  (`crates/sim/`) is most of the infrastructure; swap synthetic outcomes for real history to make it
  a fitter. Until this exists, defaults are a better starting point than imported Anki params.
* Multiple translations (ESV, NIV — with licensing)
* Team features for QuizMeet teams
* Customizable learning flow
* Import from Anki
