# Architecture

> **Memory model:** the canonical reference for the memory model is
> [`docs/path-posterior-memory-model.md`](./path-posterior-memory-model.md), which describes the
> active HSRS-state architecture: per-test FSRS state on per-verse atomic bindings, atomic +
> composite cards driven by `Card::tests()` routing, HSRS-style propagation between related tests.
> The descriptions below of the core crate's responsibilities (graph, credit assignment, etc.)
> reflect the prior edge-FSRS implementation and are being migrated; treat the HSRS memory-model doc
> as authoritative for what the core builds.

## System overview

verse-vault is structured as:

* **Rust core (`crates/core/`)** — pure algorithm: per-test FSRS state, atomic + composite cards,
  HSRS-style propagation, scheduling, sessions. No I/O, no async. Runs the same way on any target
  (native, WASM, mobile).
* **WASM bindings (`crates/wasm/`)** — wraps the core for JavaScript consumers via `wasm-bindgen`.
  Used by the TypeScript server and the browser frontend.
* **Simulation binary (`crates/sim/`)** — offline validation tool. Runs a synthetic learner against
  the core to benchmark behavior.
* **Server (`packages/api/`, TBD)** — Hono + Better Auth + Drizzle. Hosts the engine, handles
  persistence, auth, and multi-user state.
* **Clients (`apps/`, TBD)** — Vue web app, Tauri desktop, CLI.

The core is the single source of truth for memory modeling. Every platform (server, browser,
desktop) runs the same compiled Rust.

## Data flow

```
┌──────────────┐                    ┌──────────────────┐
│  Client UI   │  HTTP (auth/api)   │  TypeScript API  │
│  Vue / Tauri │ ─────────────────► │  Hono + Better   │
│              │                    │  Auth + Drizzle  │
└──────┬───────┘                    └────────┬─────────┘
       │                                     │
       │ (offline, same WASM module)         │ (server-side engine)
       ▼                                     ▼
┌──────────────────────────────────────────────────────┐
│           verse-vault-wasm (WASM module)             │
│  WasmEngine: load → session → review → export        │
└──────────────────────┬───────────────────────────────┘
                       │ (pure Rust)
                       ▼
┌──────────────────────────────────────────────────────┐
│            verse-vault-core (crates/core)            │
│  TestState, ReviewEngine, Session, FSRS, propagate   │
└──────────────────────────────────────────────────────┘
```

## Client modes

* **Thin client**: UI asks the server for the next card and submits grades. Server runs the WASM
  engine, holds state in memory, persists to SQLite.
* **Fat client**: UI downloads graph + event log, runs the WASM engine locally for offline reviews,
  uploads new events when back online.

Both modes use the same WASM module. The server's event log is the source of truth; a client that
goes offline and submits events later has its events merged by timestamp and the state recomputed.

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
* `docs/graph.md` — memory graph model (legacy edge-FSRS; being migrated)
* `docs/review.md` — credit assignment (legacy; subsumed by HSRS direct-grade model)
* `docs/scheduling.md` — card DB + priority (being migrated to per-test scheduling)
* `docs/session.md` — within-session flow
* `docs/wasm-api.md` — WASM boundary contract
* `docs/persistence.md` — database schema + event sourcing
