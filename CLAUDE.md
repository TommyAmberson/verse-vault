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
`crates/{core,wasm}/src/` without a matching `Cargo.toml` version bump, and commits that bump any
package's version without a matching `## [X.Y.Z]` section in its `CHANGELOG.md` — bypass with
`--no-verify` for refactors that don't change observable behaviour). `commit-msg` runs `commitlint`
against the conventional-commits config.

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
* **master is branch-protected.** GitHub blocks merge until the three required CI checks (`rust`,
  `typos`, `dprint`) pass on the PR head. Net effect: the merge commit's content is always
  equivalent to a SHA that CI already validated, so the deploy workflows that fire on master push
  can't race a broken merge. Owner can `--admin` bypass (`gh pr merge <N> --admin --merge ...`) for
  true hotfixes; do that consciously, not by default.
* **Rebase onto current master only for version-bump PRs.** PRs that bump a package version
  (`crates/{core,wasm}/Cargo.toml`, `packages/api/package.json`, `apps/web/package.json`,
  `deploy/vv-router/package.json`) need their branch up-to-date with master so the deploy-time
  `tools/check-contract-versions.sh --ci` check (run against master, not the PR head) stays
  consistent with the version being shipped. Non-version PRs merge fine even when master has
  advanced — skip the pre-emptive rebase.

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
* **Fixup + autosquash for review fixes.** When a later commit corrects something an earlier commit
  on the same branch got wrong (typo, missed branch, /simplify finding, code-review reply), consider
  `git commit --fixup=<orig-sha>` instead of a fresh `fix(...): ...` commit. That produces a commit
  named `fixup! <orig-subject>` paired with the target. Before merging, collapse with
  `git -c sequence.editor=: rebase -i --autosquash master` — `-i` is required (autosquash only
  activates in interactive mode) and the no-op sequence editor accepts the auto-prepared todo list.
  Fixup-marked commits discard their own message and keep the original's verbatim, so no editor
  prompts fire. End state: `git blame` lands on the original commit (whose message explains the
  change), not a follow-up "fix" commit that re-states the same scope. Works best when the target is
  recent and no intermediate commits touch the same lines — long-lived branches with interleaved
  refactors will produce conflicts on autosquash, in which case keep the fresh `fix(...)` commit.
  Before squashing, check whether the fixup's content changes what the target commit's subject
  claims: a typo or off-by-one fix slots in invisibly, but a fixup that meaningfully expands scope
  or reverses a stated intent leaves the original subject misleading. In that case, use
  `git commit --fixup=amend:<orig-sha>` instead — autosquash will prompt for a new subject when
  collapsing — or just `git commit --amend` directly if the target is HEAD. Otherwise the squashed
  commit will lie about what it does.

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

Subject in lowercase, no trailing period, imperative mood, and **≤ 50 characters** including the
type/scope prefix. Apply the "if applied, this commit will <subject>" test — `simplify cleanup pass`
and `heading split + passage card render` fail it because they describe the commit or the change as
a noun rather than the action. Body wrapped at ~72 cols, focuses on the why.

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

* **Pre-commit** (`tools/check-contract-versions.sh`): two checks.
  * Blocks commits where `crates/<core|wasm>/src/` changed but the matching `Cargo.toml` `version`
    didn't. Bypass with `git commit --no-verify` for refactors with no observable effect.
  * Blocks commits that bump any package's version (`crates/<core|wasm>/Cargo.toml`,
    `packages/api/package.json`, `apps/web/package.json`, `deploy/vv-router/package.json`) without a
    matching `## [X.Y.Z]` (non-Unreleased) section in the same package's `CHANGELOG.md`. Promote
    `[Unreleased]` to `[X.Y.Z] — YYYY-MM-DD` in the same commit.
* **CI** (`tools/check-contract-versions.sh --ci <target>`, run by each consumer's deploy workflow).
  Targets are `api` (`deploy-api.yml`), `web` (`deploy-web.yml`), and `vv-router`
  (`deploy-vv-router.yml`). Each blocks the deploy when the consumer's CHANGELOG doesn't have a
  dated section for the version being deployed; `api` and `web` additionally require that section to
  reference the current `verse-vault-core` and `verse-vault-wasm` versions (catches "bumped the
  contract crate but forgot to update the consumer's `Bundled algorithm contract` subsection").

See top-level `CHANGELOG.md` for the contract model and per-package changelog index.

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
