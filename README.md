# verse-vault

A Bible memorization app built for [QuizMeet](https://quizmeet.com) competitors and anyone who wants
to memorize scripture.

## What makes it different

Verse-vault uses an **edge-based memory graph** instead of traditional per-card spaced repetition.
Memory is modeled as transitions between pieces of information — not isolated facts. This means:

* **Phrases within a verse** are tracked separately, so the app knows which part you struggle with
* **Multiple recall paths** are recognized — if you know nearby verses, that helps you recall
  references
* **Cards are dynamically selected** based on which edges need the most efficient reinforcement
* **Club 150/300 verse lists** are first-class, with their own scheduling and membership drills

Built on [FSRS](https://github.com/open-spaced-repetition/fsrs-rs) (Free Spaced Repetition
Scheduler) with extensions for graph-based credit assignment and anchor transfer.

## Status

Core algorithm and simulation framework in development. See `docs/` for the full design.

## Structure

```
crates/
  core/     Rust library — graph, FSRS, credit assignment, scheduling (no I/O)
  wasm/     wasm-bindgen wrappers; nodejs target for the API, bundler for the web
  sim/      Simulation binary — validates algorithm against synthetic data
packages/
  api/      Hono + Better Auth + Drizzle + better-sqlite3 server (Node 22)
apps/
  web/      Vue 3 + Vite SPA running the WASM engine in-browser (fat client).
            `src-tauri/` wraps the same bundle as a native desktop app via
            Tauri v2 — see `apps/web/src-tauri/`.
data/       Structural deck JSONs (committed) + gitignored content + caches
deploy/     systemd unit, provision script, vv-router worker, tunnel config
docs/       Design docs — architecture, memory model, persistence, deployment
tools/      Python content pipeline + the wasm-pack bundler build script
```

## Build

```
cargo test             # run all tests
cargo run -p verse-vault-sim   # run simulation
```

## Third-party content

The `LICENSE` file (MIT) covers source code only. The NKJV scripture text the app displays is
delivered through [API.Bible](https://api.bible) and is subject to separate copyright and terms. See
[`NOTICE.md`](./NOTICE.md) for the citation and the
[API.Bible Acceptable Use](https://api.bible/terms-and-conditions#acceptable_use) constraints
verse-vault honours (30-day cache TTL, no AI/LLM training, no derivative format conversion, no
systematic bulk extraction).
