# Architecture

> **Memory model:** the canonical reference is
> [`docs/path-posterior-memory-model.md`](./path-posterior-memory-model.md). It describes the active
> HSRS-state architecture: per-test FSRS state on per-verse atomic bindings, atomic + composite
> cards driven by `Card::tests()` routing, and HSRS-style Bayesian-share decomposition of a single
> card grade across the card's contained tests. The sibling docs ([`graph.md`](./graph.md),
> [`review.md`](./review.md), [`scheduling.md`](./scheduling.md)) cover their own subtopics — the
> verse element index, the single-grade review pipeline, and the per-test scheduler — and defer to
> the canonical spec for memory-model details.

## System overview

verse-vault is structured as:

* **Rust core (`crates/core/`)** — pure algorithm: per-test FSRS state, atomic + composite cards,
  HSRS-style Bayesian-share decomposition, scheduling, sessions. No I/O, no async. Runs the same way
  on any target (native, WASM, mobile).
* **WASM bindings (`crates/wasm/`)** — wraps the core for JavaScript consumers via `wasm-bindgen`.
  Used by the TypeScript server and the browser frontend.
* **Simulation binary (`crates/sim/`)** — offline validation tool. Runs a synthetic learner against
  the core to benchmark behavior.
* **Server (`packages/api/`)** — Hono + Better Auth + Drizzle + better-sqlite3. Hosts the engine,
  handles persistence, auth, and multi-user state. Five route groups under `/api/`: `cards`, `sync`,
  `materials`, `years`, `stats`.
* **Web client (`apps/web/`)** — Vue 3 + Vite SPA running the WASM engine in-browser. Each grade
  replays locally; an IndexedDB-backed event queue ships batches to `/api/sync/*` on a 5 s
  debounce + on tab hide. Ships as a fat client today; the thin `/api/cards/*` surface is kept for
  tests + transitional callers.
* **Desktop / CLI** — planned, not yet started.

The core is the single source of truth for memory modeling. Every platform (server, browser,
desktop) runs the same compiled Rust.

## Data flow

```
┌────────────────────────────┐  HTTP (auth/sync)   ┌──────────────────┐
│  Vue web SPA               │ ──────────────────► │  TypeScript API  │
│  + verse-vault-wasm-web    │                     │  Hono + Better   │
│    (WasmEngine in-browser) │                     │  Auth + Drizzle  │
│  + IndexedDB queue/cache   │                     └────────┬─────────┘
└────────────────────────────┘                              │
   (Tauri shell: same Vue + WASM bundle)                    ▼
                                          ┌──────────────────────────────────┐
                                          │    verse-vault-wasm (nodejs)     │
                                          │  WasmEngine: load → next_card    │
                                          │            → replay_event        │
                                          │            → export_test_states  │
                                          └──────────────┬───────────────────┘
                                                         │ (pure Rust)
                                                         ▼
                                          ┌──────────────────────────────────┐
                                          │     verse-vault-core (crates)    │
                                          │  TestState, ReviewEngine, …      │
                                          └──────────────────────────────────┘
```

## Client modes

The server exposes two parallel route surfaces over the same engine + event log; both paths go
through the same per-(user, material) lock and share the `review_events` audit trail.

* **Fat client** (`/api/sync/*`): UI downloads the latest snapshot + test states from `/state`, runs
  the WASM engine locally, queues grades + graduations in IndexedDB, and POSTs batches to `/events`
  (with a `snapshotVersion` gate + `clientEventId` dedup). _Drives the Vue web app today._
  Out-of-order arrivals trigger a full-log rebuild via `EngineStore.rebuildFromEvents`; batches
  older than `STALE_MERGE_THRESHOLD` recent server events return a `needsConfirm` envelope so the
  user can review before merging.
* **Thin client** (`/api/cards/*`): legacy per-grade round-trip surface. UI asks the server for the
  next card and submits one grade at a time. _Kept for tests + ad-hoc tooling; no view uses it now._

Both modes use the same compiled core. The server's event log is the source of truth; a client that
goes offline and submits events later has its events merged by timestamp (or replayed from baseline
when ordering drifts) and the state recomputed.

## Why a TypeScript server?

* The project already shares patterns with `qzr-sheet` (Hono, Better Auth, Drizzle).
* Better Auth has no Rust equivalent for passkeys, OAuth providers, magic links.
* The algorithm complexity lives in Rust (via WASM), not in the server glue. The server is auth,
  persistence, and an HTTP shell around the engine.

## Deployment

Node process on a VPS (not Cloudflare Workers — the engine's path enumeration exceeds Workers' CPU
limits for larger verse sets). See `docs/deployment.md`.

## See also

* `docs/path-posterior-memory-model.md` — **canonical memory model** (HSRS-state architecture)
* `docs/graph.md` — verse element index (`VerseIndex`, `ElementId`, bindings)
* `docs/review.md` — review pipeline: single-grade decomposition into root/sub FSRS updates
* `docs/scheduling.md` — per-test FSRS scheduling and sibling cooldown
* `docs/session.md` — within-session flow
* `docs/wasm-api.md` — WASM boundary contract
* `docs/server-api.md` — HTTP API contract (routes, payloads, status codes)
* `docs/persistence.md` — database schema + event sourcing
* `docs/deployment.md` — production deployment topology (CF edge + Tunnel + VPS)
* `docs/archive/audit-fsrs6-2026-04-28.md` — historical audit notes folded into the HSRS migration
