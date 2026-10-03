# Implementation Plan: Memorize Session Flow

**Branch**: `feat/memorize-session-flow` | **Date**: 2026-10-02 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `specs/005-memorize-session-flow/spec.md`

## Summary

Most of the flow already ships (read, drill, closing read, "Already memorized", multi-year serving,
HP/CCL attach points). Three things change. The wasm session builder trades its per-kind extras caps
for two shared budgets: heading and chapter-list cards together, own before catch-ups, and orphans
together, each at most the batch size per year. The web drill stops pre-ordering a queue and picks
each card at random, swapping a pick the verse is not ready for with the card it is ready for, and
never showing the same verse twice in a row while others remain. The unused core progressive reveal
is retired, and `docs/memorize.md` takes ownership of the session flow. In a year whose deck draws
every verse from one book, the builder also leaves the which-book card out of the drill.

## Technical Context

**Language/Version**: Rust (core, wasm); TypeScript and Vue 3 (web); TypeScript (api, version bump
only)

**Primary Dependencies**: `verse-vault-core`, `verse-vault-wasm` via wasm-pack; vitest for the web
picker tests

**Storage**: None. No schema, event or persisted-shape change; the session JSON keeps its shape

**Testing**: `crates/wasm/tests/roundtrip.rs` for the caps; `apps/web/src/lib/drillOrder.test.ts`
for the picker, seeded property tests over many drills; existing suites as regression

**Target Platform**: Browser (wasm bundler target) and server (wasm nodejs target, which also calls
`memorize_session_v2` from `packages/api/src/routes/cards.ts`)

**Project Type**: Rust workspace plus pnpm workspace

**Performance Goals**: No noticeable change. A pick scans the session's remaining cards (tens), and
the builder's budgets replace counters it already keeps

**Constraints**: Wire shape unchanged; the drill stays unrecorded; contract bumps once per PR

**Scale/Scope**: One wasm function, one web module and its view, one core function removed and a
core `is_given` predicate added, three docs

**Depends on**: core 0.13.0 (`feat/single-book-ref`, merged in `4e9ca4c`), which decides single-book
decks (research D9)

## Constitution Check

_GATE: Must pass before Phase 0 research. Re-check after Phase 1 design._

| Principle                           | Assessment                                                                                                                                                                                                                                                                                                                                        |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| I. Design Docs Are Source of Truth  | `docs/memorize.md` gains the session flow; `docs/session.md` drops the progression it documents but no client runs; `docs/wasm-api.md` states the new caps and the single-book `cardIds`. All in this PR (research D7).                                                                                                                           |
| II. Pure Core, Thin Edges           | The drill is unrecorded presentation and stays in web (research D1). The caps change and the single-book omission edit behaviour that already lives in `crates/wasm`, which this principle says wasm should not hold; whether a deck is single-book stays decided in core (research D9); justified under Complexity Tracking, follow-up recorded. |
| III. Contract Versions Are Promises | wasm MINOR (session contents change, wire shape does not); core MINOR (`ReviewEngine::is_given` is added; an uncalled public function is removed). Bumped once in the first commit touching each crate. api and web restate the bundled versions.                                                                                                 |
| IV. Validate Before You Ship        | No scheduling or memory-model change, so no sim run (research D8). Tests are written before each change: wasm roundtrip for the caps and the single-book omission, seeded vitest properties for the picker.                                                                                                                                       |
| V. Atomic, Traceable History        | One commit per change below; the plan and tasks land as their own docs commits.                                                                                                                                                                                                                                                                   |
| VI. No Client Can Get Stuck         | Not engaged: no sync, outbox or id change. A session left mid-way loses nothing, as today.                                                                                                                                                                                                                                                        |
| VII. Simplest Design That Works     | No new module or type: the picker replaces the two functions in `drillOrder.ts`, the caps reuse the builder's loops, the doc extends an existing one. Removing `new_verse_progression` clears an export with no caller. See Reuse and Ownership.                                                                                                  |

**Result**: PASS with one justified exception (Principle II, below).

## Project Structure

### Documentation (this feature)

```text
specs/005-memorize-session-flow/
├── spec.md              # clarified 2026-10-02
├── plan.md              # this file
├── research.md          # decisions D1-D9
├── data-model.md        # session bounds, drill card states
├── contracts/
│   ├── memorize-session.md   # wasm caps
│   └── drill.md              # web pick rule
├── quickstart.md
└── checklists/requirements.md
```

### Source Code (repository root)

```text
crates/
├── wasm/src/lib.rs             # memorize_session_v2 budgets and single-book cardIds; doc comment no longer cites the progression
├── wasm/tests/roundtrip.rs     # cap and single-book tests
├── wasm/CHANGELOG.md, Cargo.toml
├── core/src/builder.rs, engine.rs  # which tests are a given (shared with seeding); is_given(&Card)
├── core/src/session.rs         # new_verse_progression removed
├── core/src/schedule.rs, card.rs   # doc comments no longer cite it
└── core/CHANGELOG.md, Cargo.toml

apps/web/src/
├── lib/drillOrder.ts           # the pick rule
├── lib/drillOrder.test.ts      # seeded property tests
├── lib/engine/engineStore.ts   # card classification gains phrase position and verse id
└── views/MemorizeView.vue      # asks the picker for each card
apps/web/CHANGELOG.md, package.json
packages/api/CHANGELOG.md, package.json   # ship the wasm change

docs/memorize.md, docs/session.md, docs/wasm-api.md
CLAUDE.md                       # reference-doc descriptions for memorize.md and session.md
```

**Structure Decision**: No new crate, package, module or doc.

## Reuse and Ownership

| Decision or write path                 | Owner                                                                                | Existing code reused                                                                  |
| -------------------------------------- | ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------- |
| Which extras a year's session carries  | `memorize_session_v2` in `crates/wasm/src/lib.rs`                                    | its attach pass, pending pool and orphan loop; budgets replace the per-kind counters  |
| Which cards a verse's drill holds      | `memorize_session_v2` (its verse `cardIds`)                                          | core's given-test rule, shared with 0.13.0's book-test seeding, via `is_given(&Card)` |
| Which card the drill shows next        | `apps/web/src/lib/drillOrder.ts`                                                     | `drillStage`, the `DrillCard` shape and the seeded random helper in its test          |
| A drill card's stage, phrase and verse | `cardDrillInfo` (was `cardKind`) in `apps/web/src/lib/engine/engineStore.ts`         | the `get_card_render` JSON it already parses (`kind`, `position`, `verseId`)          |
| Drill answers and the three phases     | `apps/web/src/views/MemorizeView.vue`                                                | its phase machine, `graduateItem`, `submitting` guard, anchor prefetch                |
| Per-year serving                       | `MemorizeView.vue` `buildSession` and `packages/api/src/routes/cards.ts` (unchanged) | one `memorize_session_v2` call per year with its `lessonBatchSize`                    |
| How the session flow is documented     | `docs/memorize.md`                                                                   | its existing queue sections; `docs/session.md` links to it                            |

**Platform already provides**: `apps/web`'s predev hook rebuilds the wasm bundle; vitest is wired in
`apps/web`; per-year sessions come from calling the builder once per year, so no cap code needs to
know about years.

**Releases**: wasm MINOR and core MINOR (`is_given` is added; the progression goes), then api PATCH
and web PATCH to ship them (web also ships the picker). Version numbers are set when each bump
commit is written.

## Complexity Tracking

| Violation                                                                                      | Why Needed                                                                                                            | Simpler Alternative Rejected Because                                                                                                   |
| ---------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| Extras caps and the single-book omission change inside `crates/wasm` (Principle II, thin edge) | The session builder already lives in `memorize_session_v2`; the caps are its loops' budgets and `cardIds` is its list | Moving the builder into core first is a ~350-line refactor with no behaviour change, doubling this diff; proposed as a follow-up issue |

## Phase 2 Preview (ordering, not tasks)

1. Wasm cap tests (failing), then the budgets; the first wasm commit bumps wasm.
2. Core exposes `is_given` (bumping core); a wasm test for a single-book deck (failing), then the
   session builder leaves given cards out of `cardIds`.
3. Picker property tests (failing), then the picker and the view wired to it.
4. Core: remove the progression and its references.
5. Docs: `docs/memorize.md`, `docs/session.md`, `docs/wasm-api.md`, `CLAUDE.md`.
6. api and web bumps restating the bundled contract versions.
