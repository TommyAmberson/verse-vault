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
* `docs/path-posterior-memory-model.md` — **canonical memory model** (HSRS-state architecture);
  defer to this for memory-model details
* `docs/graph.md` — verse element index: `VerseIndex`, `ElementId`, bindings
* `docs/review.md` — review pipeline: direct + propagated FSRS updates driven by `Card::tests`
* `docs/scheduling.md` — per-test FSRS scheduling, `next_card`, sibling cooldown
* `docs/session.md` — within-session flow (re-drills, progressive reveal)
* `docs/validation.md` — proofs, simulation framework, test scenarios
* `docs/wasm-api.md` — WASM boundary: exposed functions, JSON shapes
* `docs/server-api.md` — HTTP API contract: routes, payloads, status codes
* `docs/persistence.md` — database schema + event sourcing
* `docs/deployment.md` — production deployment topology (CF edge + Tunnel + VPS)
* `docs/archive/` — historical audits (FSRS-6 + per-deck keyword-markup snapshots)

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
* Merge-commit subjects follow conventional-commits, same as regular commits — typically
  `chore: merge <branch-name>`. For local merges, set this via `git merge --no-ff -m "..."`. For
  PRs, pass `--subject "chore: merge <branch>"` to `gh pr merge` (or edit before confirming) —
  GitHub's default `Merge pull request #N from …` template doesn't conform.

### Rewriting history

* **Feature branches:** rewriting is fine and often encouraged (rebase, amend, reorder, squash
  fixups, `git push --force-with-lease`) when it produces a cleaner, more readable series _before_
  merging.
* **Master:** never rewrite history. Once a commit is on master, it stays.
* **What to squash:** "changed my mind from X to Y" iterations where the intermediate state never
  ships. Keep small atomic commits that each did meaningful incremental work — the goal is that
  `git blame` on any given line lands on a commit whose message explains the change.
* **`git rebase -i` is unavailable in Claude Code** (no interactive input). For targeted squashes,
  `git cherry-pick --no-commit <a> <b> <c>` followed by a single `git commit` collapses a contiguous
  group; for wider restructures, `git reset --soft <base>` then re-stage and re-commit in groups.

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
  code is obvious should be brief or perhaps even omitted. Prefer comments that explain "why" or
  clarify complex logic. Docstrings should be brief and focused on info that is not obvious from the
  signature and would be useful to consumers. (but don't be too picky about removing comments)
