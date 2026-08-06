# Contributing

This file is the source of truth for verse-vault's git conventions and local development setup.
`CLAUDE.md` (and the other agent rule files) point here rather than restating it, so change this
file when a convention changes.

The repository is small and mostly single-maintainer, but the conventions below are machine-enforced
by git hooks and CI — they are not stylistic suggestions. A commit that ignores them gets rejected
locally, and a pull request that ignores them cannot merge.

## Getting set up

### Prerequisites

* **Rust** (stable) with `rustfmt` and `clippy` components — `rustup component add rustfmt clippy`.
* **Node** `^20.19.0 || >=22.12.0`.
* **pnpm** 10.7 — the repo pins it via `packageManager`, so `corepack enable` is enough.
* **wasm-pack** — needed to build the JS bindings the API and web app import.
* **typos** (`cargo install typos-cli`, or your distro's package) — the pre-commit hook invokes the
  bare `typos` binary, so it has to be on `PATH` or every commit fails.
* **Python 3** — only for the content pipeline in `tools/`. Not needed to build or test the app.

`dprint` comes from the workspace's dev dependencies; no separate install.

### Install

```
pnpm install
```

This does two things that matter: it installs the workspace dependencies, and its `postinstall`
script runs `simple-git-hooks`, which writes the `pre-commit` and `commit-msg` hooks into
`.git/hooks/`. **Without that step your commits skip every local check** and the first feedback you
get is a failing CI run.

The web app depends on the WASM bundler build and the API on the WASM nodejs build. Generate them
before a fresh `pnpm install` if it errors with `ERR_PNPM_WORKSPACE_PKG_NOT_FOUND`:

```
wasm-pack build crates/wasm --target nodejs --out-dir pkg   # consumed by packages/api
bash tools/build-wasm-web.sh                                # consumed by apps/web
```

Both output directories are gitignored. `apps/web`'s `predev` hook rebuilds the bundler target
automatically, gated by a stamp file — set `WASM_REBUILD=1` to force it.

## Build and test

```
cargo check                     # type-check the Rust workspace
cargo test                      # Rust tests
cargo clippy --all-targets      # lint (CI runs this with -D warnings)
cargo run -p verse-vault-sim    # simulation binary

pnpm test                       # TypeScript suites (api + web)
pnpm type-check                 # TypeScript type-check
pnpm dev:all                    # API + web dev servers together

dprint check                    # markdown/TOML formatting
typos                           # spell-check
```

## Before you push

CI runs four required checks — `rust`, `typos`, `dprint`, and `ts` — and master is branch-protected
on all four. Run their local equivalents first; the pre-commit hook only covers the fast subset.

```
cargo fmt --check
cargo clippy --all-targets -- -D warnings
cargo test --all
dprint check
typos
pnpm test
```

## Hooks

Installed by `pnpm install` via `simple-git-hooks`:

* **`pre-commit`** — `lint-staged` (runs `dprint fmt` on staged markdown/TOML/Dockerfiles), then
  `cargo fmt --check`, `typos`, and `tools/check-contract-versions.sh`.
* **`commit-msg`** — `commitlint` against the conventional-commits config in `commitlint.config.js`.

`git commit --no-verify` bypasses both. Legitimate uses are narrow: a pure refactor of
`crates/{core,wasm}/src/` with no observable behaviour change, so no contract version bump is
warranted. Do not reach for it to skip a failing test.

## Git conventions

### Branches

Work on feature branches; never commit directly to master. Branch names use a `type/short-slug`
shape matching the commit type — `feat/canonicalise-schedule-v2`, `fix/empty-passage-blocks`,
`test/web-vitest`, `docs/roadmap-anki-import`.

The `django-vue*`, `laravel*`, and `express-vue` branches are abandoned spikes. Treat them as
read-only history; never merge from them.

### Commit message format

[Conventional Commits](https://www.conventionalcommits.org/):

```
<type>(<scope>): <short subject in lowercase>

<wrapped body explaining why, not what (the diff shows what)>
```

**Types:** `feat`, `fix`, `docs`, `chore`, `refactor`, `test`, `ci`, `style`, `revert`, `perf`,
`build`.

**Scopes:** `core`, `wasm`, `sim`, `api`, `web`, `desktop`, `cli`, `tools`, `docs`, `ci`, `deploy`.
Each corresponds to a top-level workspace member or root directory (`crates/<scope>`,
`packages/<scope>`, `apps/<scope>`, plus `docs/`, `.github/workflows/` → `ci`, `deploy/` →
`deploy`). Omit the scope for cross-cutting changes, e.g. `chore: bump version to 0.2.0`. Use bare
`docs:` for doc-only edits — sub-scoping by doc area (`docs(arch)`, `docs(server-api)`) sprawls fast
and isn't enforced.

**Subject:** lowercase, imperative mood, no trailing period, and **≤ 50 characters** including the
`type(scope):` prefix. `commitlint` enforces the length as an error. Apply the "if applied, this
commit will \_\_" test — `simplify cleanup pass` and `heading split + passage card render` both fail
it, because they name the change as a noun rather than the action it performs.

**Body:** wrapped at ~72 columns (a warning, not an error — quoted URLs and stack traces are fair
exceptions), and focused on _why_.

### Commits are atomic

One logical change per commit, and each commit should build on its own. Commit as you go: once a
chunk compiles and its tests pass, commit it rather than batching everything at the end. The target
is that `git blame` on any line lands on a commit whose message explains that line.

### Pull requests

PRs are feature-sized and carry several logical commits. A substantive change shouldn't arrive as a
single commit, and a one-line change usually doesn't need its own PR — fold it into the related
work.

### Merging

* **Always merge, never squash:** `gh pr merge <N> --merge --delete-branch`. The individual branch
  commits must land on master so `git log` shows the real progression.
* **Merge-commit subjects follow conventional-commits too** — typically
  `chore: merge <branch-name>`. GitHub's default `Merge pull request #N from …` template doesn't
  conform, so pass `--subject "chore: merge <branch>"` to `gh pr merge`, or
  `git merge --no-ff -m "..."` for a local merge.
* **master is branch-protected.** GitHub blocks the merge until `rust`, `typos`, `dprint`, and `ts`
  pass on the PR head. The net effect is that a merge commit's content is always equivalent to a SHA
  CI already validated, so the deploy workflows that fire on master push can't race a broken merge.
  The owner can bypass with `gh pr merge <N> --admin --merge ...` for a true hotfix — a conscious
  decision, not a default.
* **Rebase onto current master only for version-bump PRs.** A PR that bumps a package version
  (`crates/{core,wasm}/Cargo.toml`, `packages/api/package.json`, `apps/web/package.json`,
  `deploy/vv-router/package.json`) needs its branch current, because the deploy-time
  `tools/check-contract-versions.sh --ci` check runs against master rather than the PR head. Other
  PRs merge fine when master has advanced — skip the pre-emptive rebase.

### Rewriting history

**Feature branches:** rewriting is encouraged. Rebase, amend, reorder, and squash fixups
(`git push --force-with-lease`) whenever it produces a cleaner series _before_ merging.

**Master:** never. Once a commit is on master it stays.

**What to squash:** "changed my mind from X to Y" iterations whose intermediate state never ships.
Keep the small atomic commits that each did real incremental work.

**Fixup + autosquash.** When a later commit corrects something an earlier commit on the same branch
got wrong — a typo, a missed branch, a review reply — prefer `git commit --fixup=<orig-sha>` over a
fresh `fix(...)` commit. Collapse before merging:

```
git -c sequence.editor=: rebase -i --autosquash master
```

`-i` is required (autosquash only activates in interactive mode); the no-op sequence editor accepts
the auto-prepared todo list, and `fixup!` commits discard their own message, so no editor opens. The
result is that `git blame` lands on the original commit — whose message explains the change — rather
than a follow-up that restates the same scope.

Two caveats. On a long-lived branch with interleaved refactors touching the same lines, autosquash
will conflict; keep the plain `fix(...)` commit instead. And check whether the fixup changes what
the target's subject claims: a typo fix slots in invisibly, but a fixup that expands scope or
reverses a stated intent leaves the subject lying about the squashed commit. In that case use
`git commit --fixup=amend:<orig-sha>`, which prompts for a new subject when collapsing.

## Contract crate versioning

`crates/core` (algorithm and state semantics) and `crates/wasm` (the JS↔Rust wire format) are
contracts shared across consumers — the API today, browser/Tauri/CLI fat clients later. The version
in their `Cargo.toml` _is_ the contract version: the same number across two consumers means the same
observable behaviour, and a mismatch at sync time is a real compatibility signal.

When you change either crate:

1. Bump the version in the matching `Cargo.toml`. Semver here means: MAJOR for a breaking state/wire
   change (event replay would produce different state, or the wire shape changed incompatibly),
   MINOR for additive features, PATCH for pure implementation fixes.
2. Add an entry under `## [Unreleased]` in that crate's `CHANGELOG.md`.
3. When releasing a consumer (bumping its `package.json`), promote the contract crate's
   `[Unreleased]` entries to a dated version section, and update the consumer's
   `### Bundled algorithm contract` subsection with the new versions.

`tools/check-contract-versions.sh` enforces this in two places:

* **Pre-commit.** Blocks a commit that touches `crates/{core,wasm}/src/` without bumping the
  matching `Cargo.toml` version, and blocks a commit that bumps _any_ package's version without a
  matching dated `## [X.Y.Z]` section in that package's `CHANGELOG.md`. Promote `[Unreleased]` in
  the same commit.
* **CI** (`--ci <target>`, run by each consumer's deploy workflow, where target is `api`, `web`, or
  `vv-router`). Blocks the deploy when the consumer's CHANGELOG has no dated section for the version
  being deployed. For `api` and `web` it additionally requires that section to reference the current
  `verse-vault-core` and `verse-vault-wasm` versions — which catches "bumped the contract crate but
  forgot to update the consumer's bundled-contract subsection".

## Changelogs

Every shipping package keeps its own changelog: `apps/web/CHANGELOG.md`,
`packages/api/CHANGELOG.md`, `deploy/vv-router/CHANGELOG.md`, plus the contract crates
`crates/core/CHANGELOG.md` and `crates/wasm/CHANGELOG.md`. They record _why_ a release shipped. Read
the latest entry for the package you're touching before making a non-trivial change, and add an
`[Unreleased]` entry as part of the change rather than at release time.

The top-level `CHANGELOG.md` describes the contract model and indexes the per-package changelogs.

## Design docs

`docs/` holds the design docs, and for the areas they cover they are the source of truth rather than
the code. Read the relevant one before changing that area — `docs/architecture.md` for the system
overview, `docs/path-posterior-memory-model.md` for the canonical memory model, and so on. The full
index lives in `CLAUDE.md`.
