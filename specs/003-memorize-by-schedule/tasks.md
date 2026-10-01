---
description: "Task list for 003-memorize-by-schedule"
---

# Tasks: Memorize by Schedule

**Input**: Design documents from `/specs/003-memorize-by-schedule/`

**Prerequisites**: [plan.md](./plan.md), [spec.md](./spec.md), [research.md](./research.md),
[data-model.md](./data-model.md), [contracts/memorize-queue.md](./contracts/memorize-queue.md)

**Tests**: Included. Constitution principle IV requires tests before the behaviour and a simulator
run for any scheduling change.

**Organization**: Grouped by user story. All four stories change the same two functions in
`crates/core/src/schedule.rs`, so their core tasks run in sequence even where the stories are
independent to test.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: US1-US4 from spec.md

## Commit rule for this feature

Constitution III (1.3.0) bumps each contract crate once per pull request, and
`tools/check-contract-versions.sh` rejects a commit that changes `crates/core/src/` or
`crates/wasm/src/` while that crate's version still matches where the branch left master. The
first core commit (commit 1 below) carries the core and wasm 0.12.0 bumps and their dated CHANGELOG
sections (T018); later core commits on the branch extend those sections rather than bumping again.

Every commit must build, pass `cargo clippy --all-targets -- -D warnings`, and leave `cargo test`
green. So a function arrives in the same commit as its first caller and leaves in the commit that
removes its last one, and a commit that changes behaviour rewrites the existing tests that the
change breaks. Run new tests and see them fail before implementing, but never commit them failing.
The core work lands in five commits:

1. **The count** (T006, T007, T010's count tests, T011, T018): the placement pass, and
   `memorize_debt` rebuilt on it, with the 0.12.0 bumps.
2. **The owed queue** (T008, T009, T010's queue tests, T012, T016): `club_ranks`, and
   `next_memorize_batch` serving owed verses by rank.
3. **Working ahead** (T013, T014).
4. **Gates never hide work** (T015): tests, plus any fix they force.
5. **This week first** (T017).

The tests that T012, T016 and T017 name as needing rewrites are a forecast. Whichever commit
actually breaks a test rewrites it.

---

## Phase 1: Setup (simulator baseline)

**Purpose**: The simulator cannot see the memorize queue today (it graduates every card up front).
This phase gives it a season memorize mode and records the current queue's results before anything
changes (research D7).

- [X] T001 Add a `--memorize` flag to `parse_args` in `crates/sim/src/main.rs` that dispatches to
      `memorize::run` and leaves the existing review-calibration mode unchanged
- [X] T002 Create `crates/sim/src/memorize.rs`: for each bundled season (`data/1-gepc.json` with
      `data/schedules/1-gepc-2023-24.json`, NT Survey 2024-25, Corinthians 2025-26, John 2026-27),
      load the deck and schedule (through core's `Schedule` deserialisation), build an engine with
      every club's memorize enabled for each combination of gates (production John, then each of
      the five conditions on both pairs), catch-up (all sequential, all calendar cascade) and batch
      size (1, 5), and walk the season day by day from the first week's date to 14 days past the
      last. No review loop: the queue reads no memory state (research D7)
- [X] T003 In `crates/sim/src/memorize.rs`, add three learner profiles: on plan (each week's quota,
      the verses that week is the first to assign, spread exactly across the seven days from its
      date), behind (the same pace, memorizing nothing in two mid-season weeks), and ahead (twice
      the on-plan pace). No profile memorizes after the last week's seven days. Each day the
      learner presses Memorize until it has memorized its budget, memorizing served verses in
      batch order and leaving the rest of a batch for the next press
- [X] T004 In `crates/sim/src/memorize.rs`, check the spec invariants for every verse served and count
      failures. The sim holds no definition of "owed" (constitution principle II); it reads
      ownership off `memorize_debt` as the learner memorizes each served verse in batch order:
      SC-001/SC-003 (while the count is above zero the batch is non-empty; at zero, memorizing a
      served verse leaves it at zero), SC-005 (while the count is above zero, the next verse drops
      it by 1), SC-006 (batch size never exceeded), SC-002 (while the count is zero, each verse
      comes from the nearest week that still has un-memorized verses, read from
      `Schedule::week_verse_refs` as data). Report per season and learner, and per setting: verses
      memorized, mean wait from becoming owed to memorized (research D7), and failures; and mean
      time per `memorize_debt` and `next_memorize_batch` call. `--out <path>` writes every
      combination's outcome as a table and `--baseline <path>` reports the combinations that
      regressed against one
- [X] T005 Run `cargo run -p verse-vault-sim --release -- --memorize --out
      specs/003-memorize-by-schedule/sim-baseline.tsv` against the current queue and record the
      totals in the tables in `specs/003-memorize-by-schedule/quickstart.md`

**Checkpoint**: The baseline table is filled. Invariant failures against the current queue are
expected and are recorded, not fixed here.

---

## Phase 2: Foundational (placement and club ranks)

**Purpose**: The single classification every story reads (FR-001), and the ranking that replaces the
eligibility filter (FR-006).

**⚠️ CRITICAL**: Write and run this phase's tests before any story's implementation. Its code lands
with its first caller (commit rule).

- [X] T006 Write failing tests in the `tests` module of `crates/core/src/schedule.rs` for the
      placement pass, per [data-model.md](./data-model.md): a verse is `Owed` when first assigned in
      a started week, `Ahead { week }` when first assigned in a future week, `Unscheduled` when no
      week assigns it; "assigned" is the union across enabled clubs including Full's derived range;
      the first assigning week wins for a verse listed twice; no verse is `Owed` before the season's
      first week; every scheduled verse is `Owed` after the season ends; with no schedule every
      verse is `Unscheduled`; memorized verses and verses whose own club has memorize off are
      absent; an edited schedule changes the placement on the next call
- [X] T007 Implement the placement pass as a private function in `crates/core/src/schedule.rs`. Walk
      the schedule once to map `(book, chapter, verse)` to its first assigning week, borrowing book
      names (as `for_each_cumulative_ref` does), then look up each un-memorized verse of an enabled
      club by its render reference (research D1). Commit with T018's version bumps
- [X] T008 Write failing tests for `club_ranks` in `crates/core/src/schedule.rs`: every gate met gives
      every enabled club rank 0; an unmet `p150_to_300` gives Club 300 rank 1, and Full rank 1 or 2
      depending on `p300_to_full`; a club with memorize off has no rank; a gate that can never open
      (checkpoint gates with no schedule, `FullyMemorized` over an empty higher club) still yields a
      rank, never an exclusion
- [X] T009 Implement `club_ranks` in `crates/core/src/schedule.rs` over `ClubTier::ALL` using the
      existing `gate_is_open` unchanged (research D2). `compute_eligible_clubs` stays until T012
      removes its last caller

- [X] T018 Bump `crates/core/Cargo.toml` and `crates/wasm/Cargo.toml` to 0.12.0 with dated
      `## [0.12.0] - YYYY-MM-DD` sections in the two CHANGELOGs. Lands in the same commit as T007;
      later core commits add to those sections

**Checkpoint**: Placement and ranks are written and tested. Each lands with its first caller, in
commits 1 and 2 of the commit rule.

---

## Phase 3: User Story 1 - The button serves what the number counts (Priority: P1) 🎯 MVP

**Goal**: Owed verses first, in deck order, and the count is exactly the owed set.

**Independent Test**: A learner behind by two weeks gets only owed verses, in deck order, and the
count drops by each verse memorized.

- [X] T010 [US1] Write failing tests in `crates/core/src/schedule.rs`: a learner two weeks behind
      gets only owed verses; owed verses from several weeks arrive in deck order; the verse count
      drops by k after graduating k served verses; a verse its week lists out of deck order is
      served while owed, before any ahead verse; before the season `memorize_debt` is zero with a
      schedule and the whole pool without one (FR-010, FR-011)
- [X] T011 [US1] Rewrite `memorize_debt` in `crates/core/src/schedule.rs` to count the placement
      pass's `Owed` verses (and `Unscheduled` only when there is no schedule), keeping the
      `{ verses, cards }` shape, and rewrite `memorize_debt_falls_back_to_the_whole_pool` for the
      pre-season case
- [X] T012 [US1] Rewrite `next_memorize_batch` in `crates/core/src/schedule.rs` to serve `Owed`
      verses sorted by (club rank, verse id), taking at most `batch_size` (firm limit). Delete
      `compute_eligible_clubs`, which this removes the last caller of, and rewrite
      `memorize_debt_counts_every_enabled_club_whatever_the_gates` to assert on `club_ranks`. Update
      `batch_two_sequential_clubs_canonical_order` and
      `batch_no_schedule_sequential_matches_legacy_next_memorize_card` to the new rules where their
      expectations change. With no schedule, serve the whole un-memorized pool as owed, matching
      T011 (FR-001, FR-010). Calendar cascade's Phase 1 stays until T017 removes it

**Checkpoint**: Behind learners get owed verses in deck order; count and queue agree while behind.

---

## Phase 4: User Story 2 - Memorizing ahead means next week's verses (Priority: P1)

**Goal**: With nothing owed, the queue pretends the calendar has moved on, a week at a time.

**Independent Test**: A learner with nothing owed gets the nearest future week's un-memorized
verses; a batch larger than that week continues into the next.

- [X] T013 [US2] Write failing tests in `crates/core/src/schedule.rs`: nothing owed serves the
      nearest future week that still has un-memorized verses; a batch larger than that spans into
      the following week; a review week is skipped; `memorize_debt` stays zero while working
      ahead; before the season the batch comes from the first week (FR-011); after every
      scheduled verse is memorized, unscheduled verses come in deck order (FR-012)
- [X] T014 [US2] Extend `next_memorize_batch` in `crates/core/src/schedule.rs` with the `Ahead`
      bucket sorted by (week, club rank, verse id), then, with a schedule, the `Unscheduled` bucket
      sorted by (club rank, verse id), filling the batch after `Owed`. Without a schedule, T012
      already serves those verses

**Checkpoint**: Working ahead follows the schedule; the pre-season count is zero.

---

## Phase 5: User Story 3 - Cross-club settings order the work, they never hide it (Priority: P2)

**Goal**: An unmet gate orders clubs; it never leaves the queue empty while the count is above zero.

**Independent Test**: With Club 300 behind a closed gate, Club 150's owed verses come first, then
Club 300's, and the queue is never empty while the count is above zero.

- [ ] T015 [US3] Write tests in `crates/core/src/schedule.rs`: with an unmet gate the higher club's
      owed verses come first; once they are done the lower club's owed verses are served though
      the gate is still unmet; under `FullyMemorized` with an empty higher club and under
      checkpoint gates with no schedule, a positive `memorize_debt` always yields a non-empty batch;
      adjust `next_memorize_batch` if any of these fail
- [X] T016 [US3] With T012: rewrite `batch_strict_drain_keeps_lower_club_off` and
      `batch_empty_when_nothing_eligible` in `crates/core/src/schedule.rs`. They assert the old
      filter, which T012's ranking removes; they should assert ordering and non-emptiness instead

**Checkpoint**: Gates only order; SC-003 holds by test.

---

## Phase 6: User Story 4 - "This week first" keeps pace with the group (Priority: P3)

**Goal**: Calendar cascade means current-week owed verses first within that club; nothing more.

**Independent Test**: Two weeks behind with a club on calendar cascade, its current-week verses come
first; on sequential, deck order.

- [ ] T017 [US4] Write failing tests in `crates/core/src/schedule.rs`: a club on calendar cascade
      serves its current-week owed verses before its older owed verses; on sequential, deck order;
      calendar cascade never exceeds `batch_size`; when nothing is owed both settings give the same
      batch. Then add the cascade key to the `Owed` sort (club rank, cascade key, verse id), remove
      Phase 1 and its soft cap from `next_memorize_batch`, and rewrite
      `batch_calendar_cascade_picks_this_week_first`,
      `batch_calendar_cascade_soft_cap_overflows_phase1` and
      `batch_cascade_falls_through_to_lookahead_in_phase2` for the new rules

**Checkpoint**: The whole queue matches [data-model.md](./data-model.md).

---

## Phase 7: Contract, validation and shipping

- [ ] T019 Rebuild `crates/wasm/pkg`, rerun `cargo run -p verse-vault-sim --release -- --memorize
      --baseline specs/003-memorize-by-schedule/sim-baseline.tsv`, and record the results beside
      the baseline in `specs/003-memorize-by-schedule/quickstart.md`. Zero invariant failures and
      zero regressed combinations (SC-001 to SC-006). The mean time per `memorize_debt` and
      `next_memorize_batch` call stays within 10% of the baseline's (plan Performance Goals). Then
      run the quickstart's regression checks
- [ ] T020 [P] Bump `packages/api/package.json` to 0.1.43 with a dated `packages/api/CHANGELOG.md`
      section restating core and wasm 0.12.0. Note that until a client loads web 0.9.24, its queue
      runs the old engine while Home's count comes from this api, so the two can disagree for one
      page load
- [ ] T021 [P] Bump `apps/web/package.json` to 0.9.24 with a dated `apps/web/CHANGELOG.md` section
      restating core and wasm 0.12.0. The PR bumps package versions, so rebase it onto master
      before merging (constitution, Development Workflow)

---

## Phase 8: Polish & Cross-Cutting

- [ ] T022 [P] Write `docs/memorize.md`: owed, ahead and unscheduled; the queue order; gates as
      ranking; calendar cascade; the firm batch size; the no-schedule, pre-season and post-season
      cases; how the count relates to the queue, including the brief rollout window where a
      client on an older web build counts and serves under different engines (FR-014, research D8)
- [ ] T023 [P] Update the `memorize_session_v2`, `memorize_session` and `memorize_debt` descriptions
      in `docs/wasm-api.md`, and their doc comments in `crates/wasm/src/lib.rs`, per
      [contracts/memorize-queue.md](./contracts/memorize-queue.md)
- [ ] T024 [P] Add `docs/memorize.md` to the reference-docs list in `CLAUDE.md`, and narrow the
      "Memorize schedules" entry in `docs/unspecced.md` to what stays undocumented (the schedule
      data model and editor)
- [ ] T025 After deploy, run [quickstart.md](./quickstart.md) §3 on the John account: served verses
      are owed, the count drops as they are memorized, and working ahead serves the nearest future
      week's list. Check the empty Memorize page and the gate labels in settings still read true

---

## Dependencies & Execution Order

- **Setup (T001-T005)**: no dependencies. Must finish before T011, so the baseline measures the
  current queue
- **Foundational (T006-T009, T018)**: needs nothing from Setup to write, but blocks every story.
  T006, T007 and T018 land with T011; T008 and T009 with T012 (commit rule)
- **T016** lands with T012, because the ranking is what breaks the tests it rewrites
- **US1 (T010-T012)**, **US2 (T013-T014)**, **US3 (T015-T016)**, **US4 (T017)**: in that order, since
  each rewrites `next_memorize_batch` in `crates/core/src/schedule.rs`. Each is independently testable
  once landed
- **T019** needs every story; **T020-T021** need T019
- **Polish (T022-T025)**: T022-T024 after the stories; T025 after deploy

### Parallel opportunities

- T022, T023 and T024 together (three different files)
- T020 and T021 together
- The Setup phase can be written while Foundational tests are drafted, as long as T005 runs before
  T011 lands

---

## Implementation Strategy

**MVP**: Setup, Foundational, US1 and US2 (both P1). At that point the count and the queue agree for
learners behind and ahead, which is the whole visible problem. Validate with T019 before shipping.

**Then US3 and US4**, which only matter for non-default gates and for learners on calendar cascade.

## Notes

- Verify each test fails before implementing against it
- Commit per task or logical group (constitution principle V), honouring the commit rule above
