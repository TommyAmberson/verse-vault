# Implementation Plan: Memorize by Schedule

**Branch**: `feat/memorize-by-schedule` | **Date**: 2026-09-24 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/003-memorize-by-schedule/spec.md`

## Summary

One placement pass in `crates/core/src/schedule.rs` sorts every un-memorized verse of an enabled
club into owed, ahead (by week) or unscheduled. `memorize_debt` counts the owed bucket;
`next_memorize_batch` serves owed, else ahead, else unscheduled, one kind per batch, up to a firm
`batch_size`. Cross-club gates stop filtering: `compute_eligible_clubs` is replaced by `club_ranks`,
which reuses the existing gate conditions to order clubs. Calendar cascade becomes a sort key ("this
week first") and Phase 1's overflow goes. Before the season starts nothing is owed, so the count is
zero and the queue works ahead from the first week. The simulator gains a season memorize mode, run
against the current queue first for a baseline, then against the new one. Core and wasm go to
0.12.0; api and web bump to ship them. A new `docs/memorize.md` owns the behaviour.

## Technical Context

**Language/Version**: Rust 1.75+ (core, wasm, sim); TypeScript on Node `^20.19.0 || >=22.12.0` (api,
web), touched only for version bumps and changelogs

**Primary Dependencies**: `verse-vault-core`, `verse-vault-wasm` via wasm-pack; the bundled decks
and schedules in `data/`, which the sim walks

**Storage**: None. No schema, migration or persisted-shape change; the stored `catchUp` setting
keeps its values and wire form

**Testing**: `cargo test` (core unit tests over the placement pass, ranks and ordering), the new sim
mode for Principle IV, existing api and web suites as regression

**Target Platform**: Server (Node + wasm nodejs target) and browser (wasm bundler target)

**Project Type**: Rust workspace plus pnpm workspace

**Performance Goals**: No regression on `/api/years` (which calls `memorize_debt` per enrolled year)
or on a Memorize press. The placement pass walks the schedule once per call and borrows book names,
as `memorize_debt` does today (research D9)

**Constraints**: Contract crates change behaviour, so core and wasm bump and both consumers must
ship them. No change to replay or to any wire shape

**Scale/Scope**: One core module, three wasm doc comments, a new sim mode, one new design doc

## Constitution Check

_GATE: Must pass before Phase 0 research. Re-check after Phase 1 design._

| Principle                           | Assessment                                                                                                                                                                                                                                                                                                         |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| I. Design Docs Are Source of Truth  | No doc in `docs/` owns the memorize queue (`docs/unspecced.md` lists it as the largest gap). The feature writes `docs/memorize.md` in the same PR, adds it to `CLAUDE.md`'s reference docs, and narrows the `unspecced.md` entry. The superpowers design doc is read-only history and is not edited (research D8). |
| II. Pure Core, Thin Edges           | The whole algorithm stays in `crates/core`. Wasm, api and web only pass through. The sim measures core through its public functions and holds no copy of either queue (research D7).                                                                                                                               |
| III. Contract Versions Are Promises | Core and wasm 0.12.0 (MINOR: observable order and count change, replay and wire shape do not), bumped once for the pull request in its first core commit, whose dated changelog sections later core commits extend (constitution 1.3.0). Api 0.1.43 and web 0.9.24 restate the bundled versions.                   |
| IV. Validate Before You Ship        | This is a scheduling change, so the sim must validate it. The sim cannot see the memorize queue today; a `--memorize` mode is added first, baselined against the current queue, then rerun after the change (research D7). Tests precede each core behaviour change.                                               |
| V. Atomic, Traceable History        | Commit order in the Phase 2 preview: sim mode and baseline, then core, then shipping bumps, then docs.                                                                                                                                                                                                             |
| VI. No Client Can Get Stuck         | Not engaged: no sync or client-state change.                                                                                                                                                                                                                                                                       |

**Result**: PASS. No violations; Complexity Tracking omitted.

**Spec amendments this plan needs** (wording only, recorded in research, applied to `spec.md` on
2026-09-24):

* **FR-003** lists "calendar cascade, then cross-club gate". Research D3 puts club rank first: the
  gate chooses which club to focus on, calendar cascade orders a club's own backlog. FR-003 is
  reworded to match.
* **FR-014** names the superpowers design doc, which is read-only. Research D8 moves the behaviour
  to a new `docs/memorize.md`. FR-014 is reworded to name it.

## Project Structure

### Documentation (this feature)

```text
specs/003-memorize-by-schedule/
├── spec.md              # Approved 2026-09-24
├── plan.md              # This file
├── research.md          # Phase 0 decisions D1-D9
├── data-model.md        # Placement, club rank, queue order
├── contracts/
│   └── memorize-queue.md
├── quickstart.md        # Sim baseline table and validation steps
└── checklists/
    └── requirements.md
```

### Source Code (repository root)

```text
crates/
├── core/src/schedule.rs        # placement pass, club_ranks, memorize_debt, next_memorize_batch
├── core/CHANGELOG.md, Cargo.toml
├── wasm/src/lib.rs             # doc comments on memorize_session*, memorize_debt
├── wasm/CHANGELOG.md, Cargo.toml
└── sim/src/
    ├── main.rs                 # --memorize flag dispatch
    └── memorize.rs             # season memorize mode, profiles, invariant checks

packages/api/CHANGELOG.md, package.json   # ship core/wasm 0.12.0
apps/web/CHANGELOG.md, package.json       # ship wasm 0.12.0

docs/
├── memorize.md                 # new owning doc
├── wasm-api.md                 # memorize_session_v2 / memorize_debt semantics
└── unspecced.md                # narrow the "Memorize schedules" entry
CLAUDE.md                       # reference-docs list gains memorize.md
```

**Structure Decision**: No new crate or package. The sim gains one module; core changes one module.

## Phase 2 Preview (ordering, not tasks)

1. Sim `--memorize` mode against the current queue; record the baseline in `quickstart.md`.
2. Core tests for the placement pass, ranks and order (failing), then the implementation. The first
   core commit carries the core and wasm 0.12.0 bumps. `memorize_debt`'s pre-season change rides
   with it.
3. Rerun the sim; the invariants must hold and outcomes must match or beat the baseline.
4. Api and web bumps to ship the engine.
5. `docs/memorize.md`, `docs/wasm-api.md`, `docs/unspecced.md` and `CLAUDE.md`.
