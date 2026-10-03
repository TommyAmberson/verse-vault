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
* `packages/api/` — Hono + Better Auth + Drizzle + better-sqlite3 server.
* `apps/web/` — Vue 3 + Vite SPA running the WASM engine in-browser; `src-tauri/` wraps the same
  bundle as a Tauri v2 desktop app. A CLI is planned, not started.
* `tools/` — Python scripts for content pipeline (Anki parsing, verse chunking).
* `docs/` — design docs. See list below.
* `docs/superpowers/` — read-only history. Specs and plans from the superseded superpowers workflow.
  Source comments and changelog entries still cite these paths, so they stay put; new spec work goes
  in `specs/`.
* `specs/` — spec-driven development artefacts, one `NNN-slug/` directory per feature holding
  `spec.md`, `plan.md`, and `tasks.md`.
* `.specify/` — Spec Kit scaffolding: templates, shell helpers, and the project constitution.
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
* `docs/memorize.md`: the memorize queue and count (owed, ahead and unscheduled verses, gates as
  ranking, calendar cascade) and the memorize session (its extras, read, drill, read again)
* `docs/session.md` — within-session review flow (re-drills, FTV queue)
* `docs/validation.md` — proofs, simulation framework, test scenarios
* `docs/wasm-api.md` — WASM boundary: exposed functions, JSON shapes
* `docs/server-api.md` — HTTP API contract: routes, payloads, status codes
* `docs/persistence.md` — database schema + event sourcing
* `docs/deployment.md` — production deployment topology (CF edge + Tunnel + VPS)
* `docs/decks.md` — deck inventory + phrase-split provenance, one row per `data/<N>-*.json`
* `docs/web-nav.md` — web client information architecture and route inventory
* `docs/type-to-recite.md` - typed answers on Recitation, FTV, and club-list cards: comparison and
  the proofread view
* `docs/test-scenarios.md` — manual smoke checklist for sync + offline behaviours
* `docs/unspecced.md` — shipped features with no design doc yet; the documentation backlog
* `docs/archive/` — historical audits (FSRS-6 + per-deck keyword-markup snapshots)
* `.specify/memory/constitution.md` — project constitution: the principles the `speckit-*` commands
  gate against

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

## Contract crate versioning

`crates/core` and `crates/wasm` are versioned contracts: a PR that changes their `src/` must bump
their `Cargo.toml` version once and add a dated `CHANGELOG.md` section, which later commits on the
branch extend. `tools/check-contract-versions.sh` enforces it at pre-commit, in PR CI, and at deploy
time. See [CONTRIBUTING.md](./CONTRIBUTING.md#contract-crate-versioning) for the semver rules and
the release promotion steps.

<!-- BEGIN shared agent workflow: keep identical in qzr-sheet and verse-vault -->

## Git workflow

[CONTRIBUTING.md](./CONTRIBUTING.md) holds the mechanics: hooks, branches, commit format, PRs,
merging, history rewriting, versioning, and releasing. Read it before committing; its rules aren't
repeated here. On top of it:

* Commit as you go on a `type/short-slug` branch, without waiting to be asked.
* Ask before opening, closing, or splitting a PR.
* `git rebase -i` is unavailable in Claude Code (no interactive input). For a contiguous squash,
  `git cherry-pick --no-commit <a> <b> <c>`, then a single `git commit`. For a wider restructure,
  `git reset --soft <base>`, then re-stage and re-commit in groups. Autosquash still works
  non-interactively, `git -c sequence.editor=: rebase -i --autosquash master`, because `fixup!`
  commits discard their own message, so no editor opens; see CONTRIBUTING "Rewriting history".

## Scope discipline

When you notice something nearby that's bad, awkward, or wrong while working on a feature, **stop
and check with the user before acting**. Offer to either:

* fix it now as a separate commit before continuing the feature, or
* record it (TODO comment, issue, or ROADMAP entry) and carry on.

Don't fold it silently into the current change: it muddies the diff, and the user may have context
(a deliberate choice, planned rework) you don't. Don't ignore it either.

## Spec-driven development

Feature-sized work runs through the `speckit-*` skills (`/speckit-specify`, `/speckit-plan`,
`/speckit-tasks`, `/speckit-implement`), writing into `specs/<NNN-slug>/`. `/speckit-clarify` before
planning de-risks an ambiguous spec, and `/speckit-analyze` cross-checks the three artifacts before
implementation starts. Run `/speckit-analyze` before every `/speckit-implement`, even when asked to
just "continue", unless the user says it already ran or to skip it. Small fixes and one-commit
changes skip the pipeline.

Those commands gate against `.specify/memory/constitution.md`. It states principles;
[CONTRIBUTING.md](./CONTRIBUTING.md) holds the mechanics they compile down to, and this file the
runtime guidance for agents. Where they disagree, fix the operational file rather than working
around it.

Spec Kit is branch-agnostic: `create-new-feature.sh` invokes git nowhere, and its `NNN-slug` string
names the `specs/` directory rather than a branch. Keep using `type/short-slug` branches. Commit
each artifact as it lands (`docs: spec <feature>`, `docs: plan <feature>`,
`docs: break <feature> into tasks`), and fold later refinements into that commit with `--fixup` (see
CONTRIBUTING, "What to squash").

`.specify/` is vendored by the Specify CLI, which rewrites `scripts/` and `templates/*.md` on every
refresh. Customize through `.specify/templates/overrides/<name>.md` rather than editing them in
place.

Spec Kit gotchas:

* **A fresh clone cannot resume a committed feature.** `.specify/feature.json` is the only
  feature-context source the scripts accept, and Spec Kit gitignores it as machine-local state.
  Every speckit command fails with "Feature directory not found" until you
  `export SPECIFY_FEATURE_DIRECTORY=specs/<NNN-slug>` or re-run `/speckit-specify`. Set the env var
  when picking up a feature started elsewhere, including in another worktree.
* **dprint rewrites Spec Kit's checkboxes, so `specs/**/tasks.md`, `specs/**/checklists/`, and the
  tasks-template override are excluded.** `unorderedListKind: "asterisks"` turns `- [ ]` into
  `* [ ]`, and `/speckit-implement` and `/speckit-converge` read task state from the hyphen form.
  The rewrite is silent and still renders fine, so the damage only shows when a speckit command
  finds no tasks. Prose artifacts in `specs/` carry no checkboxes and stay linted.
* **Vendored Spec Kit files are exempt from dprint and typos, narrowly.** `dprint` skips
  `.specify/templates/*.md` and `.claude/skills/speckit-*/`; `typos` skips `.specify/scripts/`,
  `.specify/templates/*.md`, and `.claude/skills/speckit-*`. The Specify CLI rewrites all of them on
  refresh, so any fix would be undone. `.specify/memory/constitution.md` and
  `.specify/templates/overrides/` are project-authored and stay linted, apart from dprint skipping
  the tasks-template override above. Don't widen either exclusion to `.specify/**`. `typos.toml`
  sets `ignore-hidden = false`, because typos otherwise skips dot-directories such as `.specify/`,
  `.claude/`, and `.github/` entirely.

## Code style

* Slight preference for writing tests before features.
* Write prose (docs, comments, commit messages) in Canadian spelling: colour, centre, -ize
  (organize, memorize), labelled. Identifiers and wire names keep their spelling.
* Comments are part of the code: update them when the surrounding code changes, since stale comments
  are bugs. Use correct grammar and spelling.
* Comments explain **why**, sometimes **how at a high level**, never **how at a low level** (don't
  restate what well-named code already says). Prefer line comments on the previous line over block
  or trailing comments. Docstrings stay brief and focus on what isn't obvious from the signature.
  Don't be too picky about removing existing comments.

<!-- END shared agent workflow -->

## Source data

* **Ask before correcting extracted source data.** When extractor output (a schedule from
  `tools/extract_pdf_schedule.py`, a deck, a club list) looks wrong against the app's model, such as
  a club verse outside its block's passage or a date off the meeting day, ship it verbatim and list
  each anomaly as a question in the commit or PR. Hand-edit only after the user confirms: the
  printed schedules sometimes break the pattern on purpose, e.g. to balance weekly memorization
  load.

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
* **`VITE_API_BASE` is the API's origin or a subpath prefix, never including `/api`**
  (`https://www.versevault.ca` in production; it was `/vv` before the move to the root). The api
  client adds `/api/...` itself; doubling it produces `.../api/api/...` 404s. Don't set it to an
  empty string: the auth client reads that as unset and falls back to localhost. Same applies to the
  CORS/origin comparison on the server — strip the path from `WEB_BASE_URL` before comparing against
  the browser's `Origin` header (always scheme+host+port only).
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
