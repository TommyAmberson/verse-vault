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

Hooks are wired via `simple-git-hooks` + `lint-staged` and installed by `pnpm install`. `pre-commit`
runs `lint-staged`, `cargo fmt --check`, `typos`, and `tools/check-contract-versions.sh`;
`commit-msg` runs `commitlint`. Bypass with `--no-verify` only for refactors that don't change
observable behaviour. See [CONTRIBUTING.md](./CONTRIBUTING.md) for what each check enforces.

Manually run the slower checks before pushing:

```
cargo clippy          # lint
cargo test            # tests
pnpm test             # TypeScript suites (api + web)
dprint check          # formatting for docs (also runs via lint-staged)
```

## Git conventions

Full detail — branch naming, commit format, PR/merge policy, history rewriting, contract-crate
versioning — lives in [CONTRIBUTING.md](./CONTRIBUTING.md). Read it before committing. The
essentials and the Claude-Code-specific caveats:

* Commits are atomic and single-responsibility. Commit as you go; don't batch at the end.
* Work on feature branches (`type/short-slug`), never directly on master.
* Conventional-commits subject, lowercase, imperative, **≤ 50 chars** including the `type(scope):`
  prefix. Body wrapped at ~72 cols, explaining why.
* Merge PRs with a merge commit, never squash:
  `gh pr merge <N> --merge --delete-branch --subject "chore: merge <branch>"`.
* master is branch-protected behind the `rust`, `typos`, `dprint`, and `ts` checks.
* Never rewrite master. Feature branches are fair game before merging.

**`git rebase -i` is unavailable in Claude Code** (no interactive input). Workarounds:

* Contiguous squash: `git cherry-pick --no-commit <a> <b> <c>` then a single `git commit`.
* Wider restructure: `git reset --soft <base>`, then re-stage and re-commit in groups.
* Autosquash still works non-interactively —
  `git -c sequence.editor=: rebase -i --autosquash master` — because `fixup!` commits discard their
  own message, so no editor opens. Before using `--fixup=<sha>`, check whether the fix changes what
  the target's subject claims; if it does, use `--fixup=amend:<sha>` so the squash prompts for a new
  subject instead of shipping a misleading one.

## Contract crate versioning

`crates/core` and `crates/wasm` are versioned contracts: bumping their `Cargo.toml` version and
adding a `CHANGELOG.md` entry is mandatory when their `src/` changes, and
`tools/check-contract-versions.sh` enforces it at pre-commit and at deploy time. See
[CONTRIBUTING.md](./CONTRIBUTING.md#contract-crate-versioning) for the semver rules and the release
promotion steps.

## Other conventions

* Slight preference for writing tests before features.
* Comments are part of the code: update them when surrounding code changes — stale comments are
  bugs. Use correct grammar and spelling.
* Comments explain **why**, sometimes **how at a high level**, never **how at a low level** (don't
  restate what well-named code already says). Prefer line comments on the previous line over block
  or trailing comments. Docstrings on functions — especially public APIs — stay brief and focus on
  what isn't obvious from the signature.

## Gotchas

Footguns and non-obvious wiring. Add to this list when you trip over something that wasn't obvious
from the code or design docs.

* **`crates/wasm/pkg/` (nodejs target) and `crates/wasm/pkg-web/` (bundler target) are both
  gitignored.** `pkg/` is consumed by `packages/api`; `pkg-web/` by `apps/web`. Regenerate the
  nodejs build with `wasm-pack build crates/wasm --target nodejs --out-dir pkg`; the bundler build
  runs automatically via `apps/web`'s `predev` hook (`tools/build-wasm-web.sh`, gated by a
  stamp-file check against the watched src — set `WASM_REBUILD=1` to force). Deploy workflows
  rebuild both from scratch. A stale `pkg-web/` surfaces as misleading downstream symptoms
  (engine-init failures cascading into "no session for <materialId>"), so when Rust changes don't
  appear in the web dev server, suspect this first.
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
* **Drizzle migrations need `--> statement-breakpoint` between statements.** better-sqlite3 only
  accepts one statement per `prepare()`, so multi-statement `.sql` migrations fail at apply-time
  with `The supplied SQL string contains more than one statement` unless each `;` is followed by
  `--> statement-breakpoint` on its own line. See `migrations/0013_relearn_and_wipe.sql` for the
  shape.
* **Abandoned branches.** `django-vue*`, `laravel*`, `express-vue`, and similar are spike
  experiments that were superseded. Don't merge from them; treat as read-only history.
