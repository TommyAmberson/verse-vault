# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this
repository.

## Current phase: implementation

Building the core algorithm and simulation framework in Rust. Design docs are in `docs/`.

## Build commands

```
cargo check          # type-check
cargo test           # run all tests
cargo clippy         # lint
cargo run -p verse-vault-sim   # run simulation

# WASM (JS bindings for server + browser)
wasm-pack build crates/wasm --target nodejs --out-dir pkg
node crates/wasm/test-smoke.js  # smoke-test the WASM module
```

## Repository layout

* `crates/core/` — pure algorithm library (no I/O, no DB). Graph, credit assignment, scheduling,
  minimal FSRS-6 inference.
* `crates/sim/` — simulation binary. Uses core to validate algorithm against synthetic data.
* `crates/wasm/` — wasm-bindgen wrappers around core for JS consumers (server + browser).
* `packages/api/` (planned) — Hono + Better Auth + Drizzle + SQLite server.
* `apps/` (planned) — Vue web app, Tauri desktop, CLI.
* `tools/` — Python scripts for content pipeline (Anki parsing, verse chunking).
* `docs/` — design docs. See list below.
* `data/` — gitignored. Local content files (NKJV text, chunked JSON). Not committed.
* Other branches (`django-vue*`, `laravel*`, `express-vue`, etc.) are abandoned spikes. Do not merge
  from them.

## Design docs

* `docs/architecture.md` — system overview, crates/packages/clients, data flow
* `docs/graph.md` — memory graph: node types, edge types, directionality
* `docs/review.md` — credit assignment: 6-step algorithm, fallback chain, anchor transfer
* `docs/scheduling.md` — card DB, priority scoring, binary search due dates
* `docs/session.md` — within-session flow (re-drills, progressive reveal)
* `docs/validation.md` — proofs, simulation framework, test scenarios
* `docs/wasm-api.md` — WASM boundary: exposed functions, JSON shapes

## Pre-commit checks

Hooks are wired via `simple-git-hooks` + `lint-staged` and installed by `pnpm install` (see the
`postinstall` script in `package.json`). The `pre-commit` hook runs `lint-staged`,
`cargo fmt --check`, and `typos`; `commit-msg` runs `commitlint` against the conventional-commits
config.

Manually run the slower checks before pushing:

```
cargo clippy          # lint
cargo test            # tests
dprint check          # formatting for docs (also runs via lint-staged)
```

## Git conventions

* Commits must be atomic and single-responsibility — one logical change per commit.
* Commit as you go: after each logical chunk compiles and tests pass, commit it — don't batch at the
  end.
* Do not add `Co-Authored-By` lines.
* Work on feature branches, not directly on master.

### Merging PRs

* Always use a merge commit, never squash: `gh pr merge <N> --merge --delete-branch`. The individual
  branch commits must land on master so `git log` shows the actual progression.

### Rewriting history

* **Feature branches:** rewriting is fine and often encouraged (rebase, amend, reorder, squash
  fixups, `git push --force-with-lease`) when it produces a cleaner, more readable series _before_
  merging.
* **Master:** never rewrite history. Once a commit is on master, it stays.

### Commit message format ([Conventional Commits](https://www.conventionalcommits.org/))

```
<type>(<scope>): <short subject in lowercase>

<wrapped body explaining why, not what (the diff shows what)>
```

Types: `feat`, `fix`, `docs`, `chore`, `refactor`, `test`, `ci`, `style`, `revert`, `perf`, `build`.

Scopes: `core`, `wasm`, `sim`, `api`, `web`, `desktop`, `cli`, `tools`, `docs`. Omit the scope for
cross-cutting changes (e.g. `chore: bump version to 0.2.0`).

Subject in lowercase, no trailing period, imperative mood ("add X", not "added X"), and **≤ 50
characters** including the type/scope prefix. Body wrapped at ~72 cols, focuses on the why.

## Other conventions

* Slight preference for writing tests before features.
* Redundant inline comments are not helpful. Comments that simply say "what" is happening when the
  code is obvious should be extremely brief or omitted. Prefer comments that explain "why" or
  complex logic. Docstrings should be brief and focused on info that is not obvious from the
  signature and would be useful to consumers.
