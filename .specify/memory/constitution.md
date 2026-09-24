# verse-vault Constitution

## Core Principles

### I. Design Docs Are Source of Truth

For every area they cover, the documents in `docs/` outrank the code. Read the relevant doc before
changing that area; `docs/path-posterior-memory-model.md` is canonical for the memory model and the
sibling docs defer to it. A change that alters documented behaviour MUST update the doc in the same
pull request, and a change that contradicts a doc MUST either be revised or arrive with the doc
amendment that justifies it.

Rationale: the algorithm's correctness lives in a model that is easier to reason about on paper than
in code. When the two disagree the doc is the specification and the code is the bug.

### II. Pure Core, Thin Edges

`crates/core` MUST remain free of I/O, async, and platform assumptions. Memory modelling, credit
assignment, and scheduling live there and nowhere else. `crates/wasm` wraps core without adding
behaviour; `packages/api`, `apps/web`, and `crates/sim` consume it and MUST NOT reimplement,
approximate, or work around algorithm semantics on their side of the boundary.

Rationale: every platform runs the same compiled Rust. The moment a consumer reproduces engine logic
locally, server and client can disagree about a learner's state, and no changelog will say so.

### III. Contract Versions Are Promises

The versions in `crates/core/Cargo.toml` and `crates/wasm/Cargo.toml` _are_ the contract: equal
versions across two consumers MUST mean identical observable behaviour. Any change to either crate's
`src/` MUST bump that crate's version and record it in that crate's CHANGELOG under a dated
`## [X.Y.Z]` section in the same commit — `tools/check-contract-versions.sh` rejects a version bump
whose changelog still leaves the entry under `## [Unreleased]`. Semver is read strictly — MAJOR when
event replay would produce different state or the wire shape changed incompatibly, MINOR for
additive features, PATCH for implementation fixes with no observable change. Releasing a consumer
MUST promote the contract crate's `[Unreleased]` entries to a dated section and restate the bundled
contract versions.

Rationale: a version mismatch between what a client ships and what the server runs is the only
compatibility signal available at sync time. It is worthless if the number can drift from the
behaviour.

### IV. Validate Before You Ship

Tests SHOULD be written before the feature they cover. Changes to scheduling or algorithm behaviour
MUST be validated against `crates/sim` with synthetic learners before shipping, not only against
unit tests. `cargo test`, `cargo clippy --all-targets -- -D warnings`, `cargo fmt --check`,
`pnpm test`, `dprint check`, and `typos` MUST all pass locally before a push; CI enforces `rust`,
`typos`, `dprint`, and `ts` on every pull request. `--no-verify` is reserved for the narrow case of
a pure refactor of `crates/{core,wasm}/src/` with no observable behaviour change; it MUST NOT be
used to move past a failing test.

Rationale: a scheduling regression is invisible in the short term and corrupts months of a user's
review history before anyone notices.

### V. Atomic, Traceable History

One logical change per commit, and each commit MUST build on its own. Commit as work completes
rather than batching at the end. Subjects follow Conventional Commits — lowercase, imperative, no
trailing period, at most 50 characters including the `type(scope):` prefix — and bodies explain
_why_. Work happens on `type/short-slug` feature branches, never directly on master. Pull requests
are feature-sized and carry several commits; they merge with a merge commit and MUST NOT be
squashed. Feature branches may be rewritten freely before merging; master MUST NOT be rewritten
after a commit lands on it.

Rationale: the target is that `git blame` on any line lands on a commit whose message explains that
line. Squashing and batching both destroy that.

### VI. No Client Can Get Stuck

A client MUST always have a path back to a working state using only what the server tells it. A user
MUST NOT have to clear site data, open a console, or reinstall to resume syncing, and a support path
that requires any of those is a defect in the protocol, not a runbook entry.

Three obligations follow, and each MUST hold independently:

* **Anything useful can be uploaded.** A client's durable state MUST be uploadable in full. The
  server MUST NOT be able to refuse a meaningful record forever, so where it cannot apply one yet it
  stores it and says so. Data waiting for a decision rests on the server, which is backed up,
  inspectable, and reachable by a migration; it MUST NOT be parked in browser storage, where it is
  invisible, unbacked, and one cleared cache from gone.
* **Load and replay are total.** Reading persisted state MUST NOT be able to throw on a row that
  state already contains. An unresolvable row degrades (skipped, logged loudly) and never bricks the
  path that reads it. Anything else turns one bad row into permanent, silent data loss.
* **Identifier changes carry a migration.** Changing an id space MUST come with a translation or
  invalidation path for state already held by clients, not only for rows held server-side. State in
  a browser outlives any deploy.

A client holds two kinds of thing and MUST NOT invent a third: caches, which are rebuildable from
the server and therefore disposable, and an outbox of records not yet delivered, which is the only
client state that is precious. An outbox entry MUST NOT depend on a cache to stay meaningful, and
"delivered" is the only end state it may have.

The check is blunt: **a client with a working connection MUST be wipeable without loss.** An outbox
is for being offline, so once a client is online it drains to empty and everything left is a cache.
If clearing a connected client's storage can lose a user's work, one of the obligations above is
being broken, and the store holding that work is the evidence.

Rationale: a stuck client is invisible from both ends. The server sees a 4xx it does not record, the
user sees "it just doesn't save", and the gap between the two is measured in weeks of lost work. On
2026-09-23 one account had synced nothing from one browser since 2026-09-09 because eight queued
events carried ids from a retired space; the same account synced normally in another browser, and
diagnosis required reading a response body out of devtools. Every individual decision in that chain
was defensible. The system still ate a fortnight of reviews.

## Technology and Content Constraints

The stack is fixed by the architecture and MUST NOT be forked casually: a Rust workspace
(`crates/{core,wasm,sim}`) compiled to native and WASM via `wasm-pack`, a pnpm workspace on Node
`^20.19.0 || >=22.12.0` holding `packages/api` (Hono + Better Auth + Drizzle + better-sqlite3) and
`apps/web` (Vue 3 + Vite, with `src-tauri/` wrapping the same bundle).

Scripture text is third-party content, not project content. The NKJV text is delivered through
API.Bible under separate terms that verse-vault MUST honour: a 30-day cache TTL, no use for AI or
LLM training, no derivative format conversion, and no systematic bulk extraction. The MIT `LICENSE`
covers source code only; see `NOTICE.md`.

Source data is transcribed, never corrected to fit. Content extracted from upstream sources ships
verbatim; where an extraction looks wrong, the anomaly MUST be raised as a question rather than
hand-edited into agreement with the model. Gitignored content under `data/` MUST NOT be committed.

## Development Workflow

`pnpm install` is mandatory setup, not a convenience: its `postinstall` writes the `pre-commit` and
`commit-msg` hooks that enforce formatting, spell-check, contract versions, and commit-message
shape. A checkout without those hooks silently skips every local gate.

Master is branch-protected on the four required CI checks and stays that way; the `--admin` bypass
is a conscious hotfix decision, not a fallback. A pull request that bumps any package version MUST
be rebased onto current master, because the deploy-time contract check runs against master rather
than the pull-request head; other pull requests MUST NOT be rebased pre-emptively.

Every shipping package keeps its own changelog and records _why_ a release shipped. Add the
`[Unreleased]` entry as part of the change, not at release time.

The `django-vue*`, `laravel*`, and `express-vue` branches are abandoned spikes. They are read-only
history and MUST NOT be merged from.

## Governance

This constitution states the principles; `CONTRIBUTING.md` holds the enforceable mechanics and
`CLAUDE.md` holds the runtime guidance for agents. Where they disagree, this document decides the
principle and the divergence MUST be fixed in the operational file rather than tolerated. Where this
document is silent, `CONTRIBUTING.md` governs.

Amendments arrive as a pull request that changes this file, bumps the version below by semver (MAJOR
for a removed or redefined principle, MINOR for a new or materially expanded one, PATCH for
clarification), and updates the amendment date. Every pull request review verifies compliance with
the principles above. Added complexity — a new crate, a new package, an exception to a principle —
MUST carry its justification in the pull request body, and an exception that outlives its
justification is a defect to be removed.

**Version**: 1.1.0 | **Ratified**: 2026-09-10 | **Last Amended**: 2026-09-23
