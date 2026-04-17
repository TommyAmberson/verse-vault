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
```

## Repository layout

* `crates/core/` — pure algorithm library (no I/O, no DB). Graph, FSRS, credit assignment,
  scheduling. Depends on `fsrs = "5"`.
* `crates/sim/` — simulation binary. Uses core to validate algorithm against synthetic data.
* `docs/` — design docs: graph.md, review.md, scheduling.md, validation.md
* `backend/` and `src/` — legacy empty stubs from earlier exploration. Ignore.
* Other branches (`django-vue*`, `laravel*`, `express-vue`, etc.) are abandoned spikes.
  Do not merge from them.

## Design docs

The algorithm is fully specified in:
* `docs/graph.md` — memory graph: 7 node types, 11 edge types, directionality
* `docs/review.md` — credit assignment: 6-step algorithm, fallback chain, anchor transfer
* `docs/scheduling.md` — card DB, priority scoring, binary search due dates
* `docs/validation.md` — proofs, simulation framework, test scenarios

Implementation should follow these docs. The FSRS retrievability formula in the docs is a
simplification — use fsrs-rs's actual `current_retrievability()` function.

## Git conventions

* Commits must be atomic and single-responsibility — one logical change per commit.
* Do not add `Co-Authored-By` lines.
* Work on feature branches, not directly on master. Merge when ready.
