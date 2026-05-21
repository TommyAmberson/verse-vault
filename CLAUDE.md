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

## Reference Docs

When working on a specific area, read the relevant design doc first — they're the source of truth,
not the code.

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

Per-package CHANGELOGs (`apps/web/CHANGELOG.md`, `packages/api/CHANGELOG.md`,
`deploy/vv-router/CHANGELOG.md`) plus contract crate CHANGELOGs (`crates/core/CHANGELOG.md`,
`crates/wasm/CHANGELOG.md`) document why each release shipped. Read the latest entry of the package
you're touching before making non-trivial changes.

## Pre-commit checks

Hooks are wired via `simple-git-hooks` + `lint-staged` and installed by `pnpm install` (see the
`postinstall` script in `package.json`). The `pre-commit` hook runs `lint-staged`,
`cargo fmt --check`, `typos`, and `tools/check-contract-versions.sh` (blocks commits that touch
`crates/{core,wasm}/src/` without a matching `Cargo.toml` version bump — bypass with `--no-verify`
for refactors that don't change observable behaviour). `commit-msg` runs `commitlint` against the
conventional-commits config.

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
* **master is branch-protected.** GitHub blocks merge until: (a) the three required CI checks
  (`rust`, `typos`, `dprint`) pass on the PR head, and (b) the PR branch is up-to-date with master
  (forces a refresh-from-master when something else lands between PR open + merge). Net effect: the
  merge commit's content is always equivalent to a SHA that CI already validated, so the deploy
  workflows that fire on master push can't race a broken merge. Owner can `--admin` bypass
  (`gh pr merge <N> --admin --merge ...`) for true hotfixes; do that consciously, not by default.

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

Scopes: `core`, `wasm`, `sim`, `api`, `web`, `desktop`, `cli`, `tools`, `docs`, `ci`, `deploy`. Each
corresponds to a top-level workspace member or root-level directory (`crates/<scope>`,
`packages/<scope>`, `apps/<scope>`, plus `docs/`, `.github/workflows/` → `ci`, `deploy/` →
`deploy`). Omit the scope for cross-cutting changes (e.g. `chore: bump version to 0.2.0`). Use bare
`docs:` (no sub-scope) for doc-only edits — sub-scoping by doc-area (`docs(arch)`,
`docs(server-api)`, etc.) sprawls fast and isn't enforced.

Subject in lowercase, no trailing period, imperative mood ("add X", not "added X"), and **≤ 50
characters** including the type/scope prefix. Body wrapped at ~72 cols, focuses on the why.

## Contract crate versioning

`crates/core` (algorithm + state semantics) and `crates/wasm` (JS↔Rust wire format) are contracts
across consumers: the API today, future browser/Tauri/CLI fat clients. Their `Cargo.toml` version is
the contract version — same number across consumers means same observable behaviour. A mismatch at
sync time (eventually enforceable in the sync API) is a real compat signal, not informational.

Discipline when changing them:

1. Bump the package version in the matching `Cargo.toml`. Semver semantics: MAJOR for breaking
   state/wire changes (event replay would produce different state, or wire shape changed
   incompatibly), MINOR for additive features, PATCH for pure implementation fixes.
2. Add an entry under `## [Unreleased]` in the crate's `CHANGELOG.md`.
3. When releasing a consumer (bumping its `package.json`), promote the contract crate's
   `[Unreleased]` entries to a real version section and update the consumer's
   `### Bundled algorithm contract` subsection with the new versions.

Enforcement:

* **Pre-commit** (`tools/check-contract-versions.sh`): blocks commits where
  `crates/<core|wasm>/src/` changed but the version didn't. Bypass with `git commit --no-verify` for
  refactors with no observable effect.
* **CI** (`.github/workflows/deploy-api.yml`, run on API deploys): blocks deploys when
  `packages/api/CHANGELOG.md`'s entry for the version being deployed doesn't reference the current
  contract crate versions. Catches "bumped core but forgot to update the API changelog."

See top-level `CHANGELOG.md` for the contract model and per-package changelog index.

## Other conventions

* Slight preference for writing tests before features.
* Redundant inline comments are not helpful. Comments that simply say "what" is happening when the
  code is obvious should be brief or perhaps even omitted. Prefer comments that explain "why" or
  clarify complex logic. Docstrings should be brief and focused on info that is not obvious from the
  signature and would be useful to consumers. (but don't be too picky about removing comments)

## Gotchas

Footguns and non-obvious wiring. Add to this list when you trip over something that wasn't obvious
from the code or design docs.

* **`crates/wasm/pkg/` is gitignored.** Regenerate with
  `wasm-pack build crates/wasm --target nodejs --out-dir pkg` before running anything that imports
  it (the API tests, `apps/web` in WASM mode). The deploy workflow rebuilds it from scratch on every
  API deploy.
* **Better Auth `baseURL` rejects relative paths.** `createAuthClient({ baseURL: '/vv' })` throws
  `Invalid base URL: /vv` because Better Auth runs it through `new URL(...)`. Resolve against
  `window.location.origin` first. See the `apps/web/CHANGELOG.md` [0.1.5] entry for the original
  incident.
* **Better Auth client `withPath` skips the `/api/auth` auto-append when the baseURL has any path
  component.** With baseURL `/vv`, route calls land at `/vv/sign-up/email` (405) instead of
  `/vv/api/auth/sign-up/email`. Add `/api/auth` to `baseURL` explicitly when constructing the
  client. See `apps/web/CHANGELOG.md` [0.1.6].
* **`VITE_API_BASE` is the subpath prefix only** (`/vv` in production), not including `/api`. The
  api client adds `/api/...` itself; doubling it produces `/vv/api/api/...` 404s. Same applies to
  the CORS/origin comparison on the server — strip the path from `WEB_BASE_URL` before comparing
  against the browser's `Origin` header (always scheme+host+port only).
* **Deck JSONs live at repo root `/data/`, not under `packages/api/`.** `pnpm deploy` only bundles
  files under the API workspace, so the deploy workflow has to copy `/data/*.json` into the bundle
  separately. `materials.ts` searches bundle-local first with a repo-root fallback so dev keeps
  working.
* **Abandoned branches.** `django-vue*`, `laravel*`, `express-vue`, and similar are spike
  experiments that were superseded. Don't merge from them; treat as read-only history.
