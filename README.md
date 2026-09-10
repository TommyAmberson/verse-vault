# verse-vault

A Bible memorization app built for [QuizMeet](https://quizmeet.com) competitors and anyone who wants
to memorize scripture.

## What makes it different

Ordinary spaced repetition schedules a card. Verse-vault schedules a **test** — one specific thing
you can be asked about one specific piece of a verse — and lets a single answer inform its
neighbours. Every memory state is grounded in a card that tests it directly, and a review propagates
partial credit to the tests that answer implicates:

* **Phrases within a verse** carry their own state, so the app knows which part you struggle with
* **A reference has several recall paths** — a verse's position, chapter, book and heading are
  separate tests, so knowing where a verse sits helps you recall it
* **Cards are dynamically selected** from whichever tests are closest to being forgotten
* **Club 150/300/Full verse lists** are first-class, with their own scheduling and membership drills

Scheduling is FSRS-6, extended HSRS-style: a propagated update refreshes a test's memory state but
never its direct-review timestamp, so soft evidence can't masquerade as a real answer. The FSRS math
is implemented in `crates/core` rather than pulled from a crate — see
[`docs/path-posterior-memory-model.md`](./docs/path-posterior-memory-model.md) for the model and
[`docs/scheduling.md`](./docs/scheduling.md) for how due dates fall out of it.

## Status

Live at `www.versevault.ca/vv`. The Vue SPA runs the Rust engine as WASM in the browser and syncs
review events to a Hono API on a small VPS; the simulation crate stays around for validating
scheduling changes against synthetic learners before they ship. See
[`docs/deployment.md`](./docs/deployment.md) for the topology and
[`docs/architecture.md`](./docs/architecture.md) for how the pieces fit.

## Structure

```
crates/
  core/     Rust library — verse graph, FSRS-6, credit assignment, scheduling (no I/O)
  wasm/     wasm-bindgen wrappers; nodejs target for the API, bundler for the web
  sim/      Simulation binary — validates the algorithm against synthetic data
packages/
  api/      Hono + Better Auth + Drizzle + better-sqlite3 server (Node 22)
apps/
  web/      Vue 3 + Vite SPA running the WASM engine in-browser (fat client); `src-tauri/` wraps the same bundle as a native desktop app (Tauri v2)
data/       Structural deck JSONs and season schedules (committed) + gitignored content + caches
deploy/     systemd unit, provision script, vv-router worker, tunnel config, Litestream backups
docs/       Design docs — architecture, memory model, persistence, deployment
tools/      Python content pipeline + the wasm-pack bundler build script
```

## Build

```
cargo test                     # Rust tests
cargo run -p verse-vault-sim   # run the simulation

pnpm install                   # also installs the git hooks
pnpm dev:all                   # API + web dev servers
pnpm test                      # TypeScript suites (api + web)
```

## Contributing

See [`CONTRIBUTING.md`](./CONTRIBUTING.md) for the full toolchain setup and the git conventions
(conventional commits, branch and merge policy, contract-crate versioning) — all of which are
enforced by git hooks and CI.

## Third-party content

The `LICENSE` file (MIT) covers source code only. The NKJV scripture text the app displays is
delivered through [API.Bible](https://api.bible) and is subject to separate copyright and terms. See
[`NOTICE.md`](./NOTICE.md) for the citation and the
[API.Bible Acceptable Use](https://api.bible/terms-and-conditions#acceptable_use) constraints
verse-vault honours (30-day cache TTL, no AI/LLM training, no derivative format conversion, no
systematic bulk extraction).
