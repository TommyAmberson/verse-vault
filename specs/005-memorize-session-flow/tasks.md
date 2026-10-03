---
description: "Task list for 005-memorize-session-flow"
---

# Tasks: Memorize Session Flow

**Input**: Design documents from `/specs/005-memorize-session-flow/`

**Prerequisites**: [plan.md](./plan.md), [spec.md](./spec.md), [research.md](./research.md),
[data-model.md](./data-model.md), [contracts/memorize-session.md](./contracts/memorize-session.md),
[contracts/drill.md](./contracts/drill.md), [quickstart.md](./quickstart.md)

**Tests**: Included. Constitution principle IV wants tests before the behaviour they cover. No
simulator run: nothing here changes scheduling or the memory model (research D8).

**Organization**: Grouped by user story. US1 and US2 both change `memorize_session_v2` in
`crates/wasm/src/lib.rs`, so their wasm tasks run in sequence; US2's web tasks are independent of
US1.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: US1-US4 from spec.md

<!--
  ============================================================================
  TASK WRITING RULES (project override; constitution principle VII)
  These rules and the constitution override the speckit-tasks skill's
  defaults: tests are not optional where the testing principle calls for
  them, and stories are not ordered Models -> Services -> Endpoints.
  Keep this comment in the generated tasks.md, so commands that add tasks
  later (/speckit-converge) see the same rules.

  - Describe the behaviour, and the test that proves it where the testing
    principle calls for one, not the code. Name a function, signature, option,
    or literal only when the task changes an existing one or the spec,
    data-model.md, or contracts/ already fixes it. Let implementation choose new names; naming the file a change
    lands in is fine.
  - Every decision or write path the feature adds has one owner, named in
    plan.md's "Reuse and Ownership" table. A task that touches it points at that
    owner; never split one rule's implementation across several tasks or files.
  - Reuse first. A task that adds a helper, module, type, or test fixture names
    the existing code it checked and why that doesn't fit. Test tasks extend
    existing fixtures and stubs rather than copying them.
  - No speculative surface: every new production export has a caller the
    constitution accepts, and no task adds an option, reason code, or counter
    that only a test reads.
  - Don't specify framework or library defaults; plan.md records what the
    platform already provides.
  - Name the packages a release bumps and the semver level of each, never the
    resulting version number. The number is set when the bump commit is
    written, from master at that time, and a hotfix landing first takes it.
  - Prefer one task per coherent change over one task per layer (model, then
    service, then endpoint). Split only where tasks can genuinely run or be
    reviewed apart.
  ============================================================================
-->

## Commit rule for this feature

Constitution III bumps each contract crate once per pull request, in the first commit that changes
its `src/`, under a dated `## [X.Y.Z] - YYYY-MM-DD` CHANGELOG section that later commits extend.
Here that is wasm MINOR in commit 1 and core MINOR in commit 3.

Every commit must build, pass `cargo clippy --all-targets -- -D warnings`, and leave `cargo test`
and `pnpm test` green. Run new tests and see them fail before implementing, but never commit them
failing; a commit that changes behaviour rewrites the existing tests it breaks. Planned commits:

1. **Extras budgets** (T002, T003), wasm MINOR.
2. **Drill picker** (T004, T006, T007, and T010's check).
3. **Single-book drill** (T005, T008, T009), core MINOR.
4. **Retire the progression** (T011).
5. **Docs** (T012, T013).
6. **Releases**: api (T014), then web (T015), one commit each.

---

## Phase 1: Setup

**Purpose**: The single-book work builds on core 0.13.0 (plan.md "Depends on").

- [X] T001 Once `feat/single-book-ref` (core 0.13.0) has merged, rebase `feat/memorize-session-flow`
      onto master and confirm `crates/core/Cargo.toml` reads 0.13.0 and its seeding of single-book
      book tests is present in `crates/core/src/builder.rs`. Commits 1 and 2 may land before this;
      T005, T008, T009 wait for it. Done: rebased onto master `4e9ca4c`

---

## Phase 2: Foundational

None. The stories touch separate owners (plan.md "Reuse and Ownership"), and nothing all of them
need is missing. FR-001 (per-year batches), FR-008 (attach points) and FR-009 (summary) ship today
and don't change; existing tests and the quickstart manual run cover them.

---

## Phase 3: User Story 1 - A session stays about its verses (Priority: P1) 🎯 MVP

**Goal**: Per year, at most the batch size of heading and chapter-list cards together (own before
catch-ups, strict cap) and at most the batch size of orphans together.

**Independent Test**: The roundtrip tests of T002 pass; the bounds in
[contracts/memorize-session.md](./contracts/memorize-session.md) hold.

### Tests for User Story 1

- [X] T002 [US1] In `crates/wasm/tests/roundtrip.rs`, add cap tests next to the existing
      `memorize_session_*` tests, extending `MATERIAL_HP_CCL_JSON` and the config JSON they use
      (or a larger inline material of the same shape when that one has too few headings, chapters
      or optional cards to exceed a small `limit`). With `limit` below the outstanding counts,
      assert: heading and chapter-list cards, attached plus in `orphans`, number at most `limit`
      together; the session's own (attached by FR-008) are kept over catch-ups; when own cards
      alone exceed `limit`, those later in session order are left out and, after the session's
      verses are graduated, return as catch-ups; conditional orphans (`Ftv`, `VerseInHeading`,
      `VerseInClub`) number at most `limit` together; a session with no verses obeys both bounds;
      and repeated sessions that graduate what they serve eventually offer every outstanding extra
      (SC-002). Rewrite any existing test that asserted per-kind caps;
      `memorize_session_attaches_hp_and_ccl_by_session_order` (FR-008) must stay green unchanged

### Implementation for User Story 1

- [X] T003 [US1] Replace the per-kind caps in `memorize_session_v2` in `crates/wasm/src/lib.rs`
      with the two shared budgets of contracts/memorize-session.md rules 1-5, reusing its attach
      pass, pending pools and orphan loop; own heading and chapter-list cards fill their budget
      before catch-ups. Update the doc comments on the function and its `orphans` field ("Per-kind
      cap = `limit`" and the "each capped at `limit`" block). Bump wasm MINOR with a dated section in
      `crates/wasm/CHANGELOG.md` and `crates/wasm/Cargo.toml`; covered by T002

**Checkpoint**: Sessions respect both budgets per year; the web and api pick it up unchanged.

---

## Phase 4: User Story 2 - The drill builds a verse up before asking for all of it (Priority: P1)

**Goal**: The random pick-and-swap drill of research D2 with no-echo, and no which-book card in the
drill of a single-book year.

**Independent Test**: The seeded property tests of T004 and the roundtrip tests of T005 pass;
quickstart.md manual step 2 behaves as described.

### Tests for User Story 2

- [X] T004 [P] [US2] In `apps/web/src/lib/drillOrder.test.ts`, replace the `orderDrill` and
      `requeueMissed` suites with property tests of the pick rule in
      [contracts/drill.md](./contracts/drill.md), reusing the file's `seeded` random source and card
      builder. Drive at least 1,000 seeded drills over pools mixing several verses, location cards
      and extras, answering Again and Good from a seeded source, and assert on every run: each
      verse's blanks are first shown in ascending phrase position; its whole-verse cards come only
      after all its blanks are Good; no two consecutive picks share a verse while another card
      remains; the drill ends. Assert the "every blank shown, some missed" swap is exercised and
      picks among several missed blanks. Cover the spec's edge cases: a verse with no blanks, a
      verse with no whole-verse cards, one verse left, and two orphans of one memorized verse kept
      apart (research D3). Keep the `drillStage` suite
- [X] T005 [US2] In `crates/wasm/tests/roundtrip.rs`, add a test that in a single-book deck no
      verse's `cardIds` from `memorize_session_v2` hold its `VerseInBook` card and `graduate_verse`
      still makes that card Active, and that a deck drawing from two books keeps it in `cardIds`.
      The existing `MATERIAL_JSON` fixtures are John-only; add a two-book inline material shaped
      like them (as `material_two_verses` does in `crates/core/src/builder.rs` tests). Needs T001

### Implementation for User Story 2

- [X] T006 [US2] In `apps/web/src/lib/drillOrder.ts`, replace `orderDrill` and `requeueMissed` with
      the pick rule of research D2 and contracts/drill.md: draw uniformly from cards not yet Good,
      leaving out the last-shown verse's cards while others remain, then swap by the D2 table. A
      drill card carries the data-model.md fields (item, verse, stage, phrase, shown), extending
      `DrillCard`; keep `drillStage`. Good removes the shown card, Again keeps it and a blank stays
      shown. Randomness stays injectable for tests; covered by T004
- [X] T007 [US2] Wire the picker into the memorize view. Extend `cardKind` (now `cardDrillInfo`) in
      `apps/web/src/lib/engine/engineStore.ts` (and its `useEngine.ts` pass-through) to return the
      blank's phrase `position` and the card's `verseId` from the `get_card_render` JSON it already
      parses (research D3, D4). In `apps/web/src/views/MemorizeView.vue`, build drill cards with
      the verse key "material + verse id", ask the picker for each next card on Good and Again,
      keep the `submitting` guard, let `graduateItem` drop the item's cards, drive "N of M" from a
      done-count against the total at drill start, and update the phase and `buildSession` comments
      that describe the old ordering; covered by T004 and quickstart.md manual step 2
- [X] T008 [US2] Expose, from `crates/core`, whether a card asks only given tests (the book of a
      verse in a single-book deck), from one rule shared with core 0.13.0's seeding in
      `crates/core/src/builder.rs`, so the seeding and the session builder can't disagree (research
      D9). Extend the single-book and multi-book builder tests there to assert which cards are a
      given. Bump core MINOR with a dated section in `crates/core/CHANGELOG.md` and
      `crates/core/Cargo.toml`. Needs T001
- [X] T009 [US2] In `memorize_session_v2` in `crates/wasm/src/lib.rs`, leave a verse's
      `VerseInBook` card out of its `cardIds` when T008's predicate says the card is a given
      (contracts/memorize-session.md rule 6); `graduate_verse` is unchanged. Update the `card_ids`
      field comment, and extend the wasm CHANGELOG section from T003; covered by T005

**Checkpoint**: The drill meets SC-003 and SC-006; single-book years skip the which-book card.

---

## Phase 5: User Story 3 - The learner decides what is memorized (Priority: P2)

**Goal**: Today's "Already memorized" and "Not yet" behaviour holds with the new picker.

**Independent Test**: The spec's US3 scenarios, run by hand as in quickstart.md manual step 3.

- [X] T010 [US3] Check, in `apps/web/src/views/MemorizeView.vue` after T007, that marking an item
      "Already memorized" in the read phase removes its cards before the drill starts, that a
      session where every item was marked ends without a drill, and that "Not yet" at the closing
      read leaves the item unmemorized. Fix any break T007 introduced in the same commit as T007;
      covered by the US3 acceptance scenarios run through quickstart.md

---

## Phase 6: User Story 4 - One documented flow (Priority: P3)

**Goal**: The core progressive reveal is retired and `docs/memorize.md` owns the session flow.

**Independent Test**: quickstart.md "Docs" checks pass; `grep -rn new_verse_progression crates docs`
finds nothing.

- [X] T011 [US4] Remove `Session::new_verse_progression` and its test from
      `crates/core/src/session.rs`, and the module comment's progressive-reveal clause. Reword the
      comments that cite it: `next_memorize_card` in `crates/core/src/schedule.rs`, `CardKind::Reading`
      in `crates/core/src/card.rs` (nothing emits it now), and `next_memorize_card` in
      `crates/wasm/src/lib.rs`. Record the removal in the core CHANGELOG section from T008 (research
      D6); covered by `cargo test` still passing
- [X] T012 [P] [US4] Add the session flow to `docs/memorize.md` (research D7): items and the two
      extras budgets per year, own before catch-ups, the which-book card left out of single-book
      years' drills, the read phase with "Already memorized", the drill's pick-and-swap rule and
      no-echo (research D2, D3), Good and Again, the closing read with Graduate and Not yet, and the
      summary. Point its opening at the new section instead of at `docs/session.md`
- [X] T013 [P] [US4] In `docs/session.md`, drop the "Progressive reveal (new verses)" and "Memorize
      drill in the web client" sections and the progressive-reveal mention in its opening, pointing
      memorize readers at `docs/memorize.md`. In `docs/wasm-api.md`, state the shared budgets and
      the single-book `cardIds` for `memorize_session_v2`. In `docs/unspecced.md`, drop the claim
      that `docs/session.md` covers progressive reveal. In `CLAUDE.md`, update the reference-doc
      descriptions of `docs/memorize.md` and `docs/session.md`

**Checkpoint**: One doc describes the flow the app runs (SC-005).

---

## Phase 7: Polish & Cross-Cutting Concerns

- [ ] T014 Release api PATCH to ship the wasm and core changes: `packages/api/package.json`, and in
      `packages/api/CHANGELOG.md` promote `[Unreleased]` to the dated version section in the same
      commit, restating the bundled core and wasm versions under `### Bundled algorithm contract`
- [ ] T015 Release web PATCH the same way in `apps/web/package.json` and `apps/web/CHANGELOG.md`,
      also recording the drill picker
- [ ] T016 Run quickstart.md: the automated block (`cargo test`, `cargo clippy --all-targets -- -D
      warnings`, `pnpm test`, `dprint check`, `typos`) and the manual web check, on an account with
      owed verses and outstanding extras
- [ ] T017 With the user's go-ahead, file the follow-up issue plan.md's Complexity Tracking
      proposes: move the session builder from `crates/wasm/src/lib.rs` into core. Mention
      `CardKind::Reading` and the uncalled core `Session` type (research D6) in it or a sibling
      issue, as the user prefers

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (T001)**: blocks only T005, T008, T009.
- **US1 (T002, T003)**: no dependencies.
- **US2**: web (T004, T006, T007) has no dependencies; single-book (T005, T008, T009) needs T001, and T009 needs
  T003 because both edit `memorize_session_v2`.
- **US3 (T010)**: needs T007.
- **US4**: T011 needs T008 (the core CHANGELOG section); T012 and T013 can start any time but
  should describe the code as merged.
- **Polish**: T014 and T015 after every code change; T016 last; T017 any time once the user agrees.

### Within Each User Story

- A new test is written, and seen to fail, before the implementation it covers.
- T008 (the single-book answer's owner) before T009, which reads it.

### Parallel Opportunities

- T004 (web tests) runs alongside T002 (wasm tests).
- T012 and T013 touch different docs.
- The web picker (T004, T006, T007) and the wasm budgets (T002-T003) can proceed side by side.

---

## Parallel Example: User Story 2

```bash
Task: "Property tests for the pick rule in apps/web/src/lib/drillOrder.test.ts"   # T004
Task: "Single-book cardIds roundtrip test in crates/wasm/tests/roundtrip.rs"      # T005, after T001
```

---

## Implementation Strategy

### MVP First

US1 (T002, T003) alone shrinks oversized sessions and ships through api and web bumps.

### Incremental Delivery

1. US1: extras budgets.
2. US2: the drill picker (web), then the single-book omission once core 0.13.0 is on master.
3. US3: confirm the learner's choices still hold.
4. US4: retire the progression, write the docs.
5. Release api and web.

---

## Notes

- [P] tasks touch different files with no dependency on an incomplete task.
- Commit after each planned commit above; fold later fixes in with `--fixup`.
