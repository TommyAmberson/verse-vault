---

description: "Task list for the proofread recitation diff"
---

# Tasks: Proofread Recitation Diff

**Input**: Design documents from `/specs/004-proofread-recitation-diff/`

**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/card-back-markup.md, quickstart.md

**Tests**: Follow the constitution's testing principle. Where it calls for a test, the implementation task names the test task or existing test that covers it. The `wordDiff` tie-break and the edit logic are pure and get vitest coverage written first; rendering has no component-test setup (plan.md, Testing), so rendering tasks are covered by the quickstart's hand checks.

**Organization**: Tasks are grouped by user story to enable independent implementation and testing of each story.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (e.g., US1, US2, US3)
- Include exact file paths in descriptions

## Path Conventions

- Client-only change in `apps/web/`; docs in `docs/` and `CLAUDE.md` at the repository root.
- "The edit module" below means the new pure module in `apps/web/src/lib/diff/` that plan.md's Reuse and Ownership table makes the owner of grouping, merging, and the fallback decision. Its file name is the implementation's choice; its tests sit beside it, as `clubList.test.ts` sits beside `clubList.ts`.

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

## Phase 1: Setup (Shared Infrastructure)

None. The worktree is installed and the WASM builds exist; the feature adds no dependencies or tooling.

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Fix the one comparison defect the proofread view would otherwise make conspicuous (spec FR-014, research R11). Every prose story's reference cases run through `wordDiff`, so this lands first, as its own commit.

- [X] T001 Write `apps/web/src/lib/diff/wordDiff.test.ts`, the first tests for `wordDiff`: John 1:10 typed in full followed by John 1:11 yields all of 1:10 matched, including its final "Him.", followed by every word of 1:11 as extra, with no extra inside 1:10; typing only "was" against John 1:1 still matches the first "was" (the `b434286` case, guarding the existing expected-side preference); an exact answer yields matches only.
- [X] T002 Add the typed-side tie-break to `wordDiff`'s traceback in `apps/web/src/lib/diff/wordDiff.ts`: when the current expected and typed tokens are equal and skipping the expected token would shorten the match but skipping the typed token would not, take the typed token as extra, so the earliest typed occurrence wins (research R11). Update the traceback's comment to describe both preferences. Add a Fixed line to the `[Unreleased]` entry in `apps/web/CHANGELOG.md`. Covered by T001.

**Checkpoint**: `wordDiff` prefers the earliest occurrence on both sides; today's red diff already shows the run-together case correctly.

---

## Phase 3: User Story 1 - Reader sees their attempt corrected like a proofread page (Priority: P1) 🎯 MVP

**Goal**: A typed Recitation or FTV answer renders as the reader's own words in typed order, matched words in the verse colour, every replacement and skip as the verse's words in a label above the reader's struck words or a caret, and additions struck.

**Independent Test**: Quickstart reference cases 1 (FTV John 1:11) and 2 (John 1:1), plus Scenarios 1, 2, 3, and 5.

### Tests for User Story 1

> **NOTE: Where a task adds a new test, write it first and see it fail.**

- [X] T003 [US1] Write the edit module's tests in a new test file in `apps/web/src/lib/diff/`, feeding real `wordDiff` output (no hand-built diff fixtures): the FTV John 1:11 case yields one `replace` edit, typed "do" against expected "to", with every other word matched; the John 1:1 case yields one `replace` ("the Lord," against "God,") and does not flag the missing comma; typed words with no counterpart at a point where nothing is missing yield an `add` edit with no expected words; expected words left out mid-verse yield a `skip` edit with no typed words; matched tokens keep the expected text's form (data-model.md, Diff item: "for `match`, the expected side's token"); the answer reads as alternating match runs and edits in typed order.

### Implementation for User Story 1

- [X] T004 [US1] Create the edit module in `apps/web/src/lib/diff/`, owner of "grouping diff items into replace / add / skip edits" (plan.md), reusing the `DiffItem` type from `wordDiff.ts`: group each maximal run of consecutive non-match items into one edit, `replace` when it has both typed and expected words, `add` for typed only, `skip` for expected only (data-model.md, Edit). Checked `wordDiff.ts` and `clubList.ts` first: `wordDiff` decides matches and is also the club-list engine (research R1), and `clubList.ts` owns club-list normalization only. Covered by T003.
- [X] T005 [US1] Render prose edits in the `diffHtml` computed in `apps/web/src/components/CardPrompt.vue` per `contracts/card-back-markup.md` (Prose cards): matched words as escaped plain text inheriting the verse colour; every `replace` as a stacked mark with the expected words in an `<ins>` label on top and the typed words in `<del>` below; every `skip` as the same stack with a caret below; every `add` as `<del>` with no label; a `title` on each mark naming both sides as the contract's examples show. Marks are in-flow stacks as research R4 describes: as wide as the wider of label and typed words up to the line width, the label wrapping when wider, the bottom row on the sentence's baseline, the same form for every length and position (FR-006). Apply the contract's diff type size, label style, 1px strike, and 16% tint to the proofread body that `diffHtml` emits rather than to the shared `verse-text diff` container, so a body without marks keeps ordinary spacing and later bodies can keep the normal size (research R2, R6). Add a line-and-caret colour token to `apps/web/src/assets/colors.css` with the contract's light and dark values (dark in the existing dark media block). Keep the club-list branch of `diffHtml` and the `.diff-missing`/`.diff-extra` rules it uses until T015. Extend the `[Unreleased]` entry in `apps/web/CHANGELOG.md` describing the new view. Covered by T003 for edit content and by quickstart reference cases 1 and 2 and Scenarios 1, 2, 3, and 5 for presentation.

**Checkpoint**: Near-miss recitations render as proofread pages, at any length.

---

## Phase 4: User Story 2 - Reader who recited the wrong verse sees the right one plainly (Priority: P2)

**Goal**: When the reader matched under half the verse and under half of what they typed is in the verse, the back shows the verse unmarked, at its normal size, with their answer below.

**Independent Test**: Quickstart reference case 7 (John 1:15 typed on a John 1:10 card), Scenario 2 step 4, and cases 5 and 6 still showing the proofread view.

### Tests for User Story 2

- [X] T006 [US2] Extend the edit module's tests from T003: the John 1:15-on-1:10 case reports 2 of 19 expected words matched and selects the fallback; "He was in the" on John 1:10 (recall 21%, precision 100%) and John 1:10 followed by John 1:11 (recall 100%) do not; boundaries with recall and precision each just under and exactly at one half, confirming the fallback needs both under (data-model.md, Match measures: "wrong-verse fallback when recall < 0.5 AND precision < 0.5").

### Implementation for User Story 2

- [X] T007 [US2] Add the match measures and the fallback decision to the edit module, owner of "whether the wrong-verse fallback applies (FR-011), and N of M" (plan.md): recall is matched over expected words, precision is matched over typed words, both counted on the diff before any merging (data-model.md), with the one-half threshold as a named value commented with FR-011 (research R8). Covered by T006.
- [X] T008 [US2] Render the fallback body from the `diffHtml` computed in `apps/web/src/components/CardPrompt.vue` per `contracts/card-back-markup.md` (Wrong-verse fallback): reuse `verseHtml` for the expected text at today's `.verse-text` size, not the diff type size, then, in muted text, the label "You typed (N of M words match)" and the typed answer escaped as entered, with no marks. Extend the `[Unreleased]` entry in `apps/web/CHANGELOG.md`. Covered by T006 for the decision and by quickstart reference cases 5, 6, and 7 and Scenario 2 step 4.

**Checkpoint**: Wrong verses fall back at normal size; partial and run-on recitations do not.

---

## Phase 5: User Story 3 - Reader who stopped early sees the rest of the verse in place (Priority: P3)

**Goal**: A long or trailing skip, like any long correction, keeps the same stacked form, its label wrapping within the card.

**Independent Test**: Quickstart reference cases 3 (John 1:3) and 5 ("He was in the" on John 1:10), and Scenario 2.

US3 adds no rule: FR-006 gives every edit one form, and T005's in-flow stack already wraps. Its tasks pin the behaviour down so a later change can't reintroduce a special case.

### Tests for User Story 3

- [X] T009 [US3] Extend the edit module's tests: "He was in the" on John 1:10 yields four matched words then a single trailing `skip` of the remaining fifteen expected words; the John 1:3 case yields a `replace` ("by" against "through") and a trailing `skip` ("that was made."); neither edit carries any length- or position-dependent marking (data-model.md, Edit: a `skip` is shown as "caret, expected words in a label above").

### Implementation for User Story 3

- [ ] T010 [US3] Check T005's rendering against quickstart reference cases 3 and 5 and Scenario 2 at 360px, in light and dark: the fifteen-word label wraps within the card above its caret, its mark starts on a new line, the caret sits on the sentence's baseline, and no label overlaps or crosses the card edge. Any fix lands in T005's owner, the `diffHtml` markup and its styles in `apps/web/src/components/CardPrompt.vue`, not in a new rule. Covered by T009 and the quickstart.

**Checkpoint**: Stopping early shows the rest of the verse above a caret, wrapped; no label overflows.

---

## Phase 6: User Story 4 - Reader who reworded a phrase sees one correction, not a scatter (Priority: P4)

**Goal**: Edits separated only by a short glue run merge into one `replace`.

**Independent Test**: Quickstart reference case 4 (John 1:14 paraphrase).

### Tests for User Story 4

- [X] T011 [US4] Extend the edit module's tests: the John 1:14 paraphrase yields one `replace` with expected "as of the only begotten of" against typed "of the one and only Son from", while "made His dwelling" against "dwelt" and the added "all of" stay separate; two glue words merge and three do not; a four-letter glue word merges and a five-letter one does not; a short match run at the start or end of the answer is never folded; the match measures from T006 are unchanged by merging (data-model.md: "A match run of at most two words, each at most four letters after normalization, that sits between two edits is folded into one `replace`" and "Counted on the diff before merging").

### Implementation for User Story 4

- [X] T012 [US4] Add merging to the edit module, owner of "whether two edits merge across a glue run (FR-010)" (plan.md), reusing `normalize` from `wordDiff.ts` for letter counts, with the two-word and four-letter limits as named values commented with FR-010 (research R8). Apply it to prose cards only; club-list answers never reach it. No rendering change: a merged edit is an ordinary `replace`. Extend the `[Unreleased]` entry in `apps/web/CHANGELOG.md`. Covered by T011 and quickstart reference case 4.

**Checkpoint**: Paraphrases read as one correction.

---

## Phase 7: User Story 5 - Reader's typed club list is marked the same way (Priority: P5)

**Goal**: Typed club lists keep correct numbers in their own verse colours, strike numbers not in the club, and stack missed numbers above carets in sorted position.

**Independent Test**: Quickstart Scenario 4 and the spec's US5 acceptance scenarios.

### Tests for User Story 5

- [ ] T013 [P] [US5] Extend `apps/web/src/lib/diff/clubList.test.ts`: for members 1, 3, 4, 12, 14, 29 and typed "1, 3, 5, 12, 14, 18", the items come out in ascending order with 4 missing before 5 extra and 18 extra before 29 missing; members typed in any order produce matches only; a non-numeric token survives as an extra; a repeated number stays an extra (data-model.md, Club-list item order).

### Implementation for User Story 5

- [ ] T014 [P] [US5] Add the ascending order inside runs of consecutive non-match items to `apps/web/src/lib/diff/clubList.ts`, owner of "club-list order inside edit runs (FR-012)" (plan.md), beside `normaliseClubListAnswer`, leaving matched items in diff order and non-numeric tokens in place (research R7). Covered by T013.
- [ ] T015 [US5] Render club lists in the `diffHtml` computed in `apps/web/src/components/CardPrompt.vue` per `contracts/card-back-markup.md` (Club-list cards), using T014's order: matched numbers through the existing `verseNumberSpan`; typed numbers or tokens not in the club as `<del>` with a `title`; each missed number as T005's stacked mark with a caret below, its label taking that number's own verse colour through `--active-verse-colour` as `verseNumberSpan` sets it; commas only between adjacent typed numbers and plain spaces around a caret. Remove the `.diff-missing` and `.diff-extra` rules and their use of `--color-grade-again`, now unused. Extend the `[Unreleased]` entry in `apps/web/CHANGELOG.md`. Covered by T013 for order and by quickstart Scenario 4.

**Checkpoint**: All typed card kinds share the proofread look.

---

## Phase 8: Polish & Cross-Cutting Concerns

**Purpose**: Documentation, release, and end-to-end validation

- [ ] T016 [P] Write `docs/type-to-recite.md` covering the whole feature (research R9): optional typing and self-grading, normalized comparison and the earliest-occurrence preference on both sides, FTV prefix handling and dialect, the proofread view and its edit kinds, merging, the wrong-verse fallback and its two measures, and club lists; add it to the reference docs list in `CLAUDE.md`; point the club-list diffing mention in `docs/unspecced.md` at the new doc.
- [ ] T017 Release `@verse-vault/web` as a MINOR bump: move the `[Unreleased]` entry in `apps/web/CHANGELOG.md` under a dated version heading labelled MINOR, restating the bundled contract versions as unchanged, and bump `apps/web/package.json` to match. Set the number from master at the time of the commit.
- [ ] T018 Run the quickstart validation in `specs/004-proofread-recitation-diff/quickstart.md`: `pnpm --filter @verse-vault/web test`, `pnpm --filter @verse-vault/web type-check`, `dprint check`, and `typos`, then every reference case and Scenarios 1 to 5 against `pnpm dev:all`, in light and dark and at 360px width.

---

## Dependencies & Execution Order

### Phase Dependencies

- **Foundational (Phase 2)**: T001 then T002. Lands first, as its own commit.
- **US1 (Phase 3)**: after Phase 2; creates the edit module, the token, and the prose rendering every later prose story extends.
- **US2, US3, US4 (Phases 4 to 6)**: each depends on US1 (same module and same computed). They touch the same files, so run them one after another in priority order.
- **US5 (Phase 7)**: T013 and T014 depend on nothing and can run alongside Phase 2 and US1. T015 depends on T005 for the token and the stacked mark.
- **Polish (Phase 8)**: T016 can run any time after the behaviour is settled; T017 after all stories; T018 last.

### User Story Dependencies

- **US1 (P1)**: Phase 2.
- **US2 (P2)**: US1.
- **US3 (P3)**: US1.
- **US4 (P4)**: US1, and US2 (T011 checks T007's measures).
- **US5 (P5)**: US1 for rendering only.

### Within Each User Story

- A new test is written, and seen to fail, before the implementation it covers. T009's tests may pass on arrival, since US3 adds no rule; they guard against one being added.
- The edit module's rule before the rendering that consumes it.
- Each story ends in its own commit, or one commit per test-plus-implementation pair, per Principle V.

### Parallel Opportunities

- T013 and T014 (club-list ordering, `clubList.ts`) run in parallel with Phase 2 and US1 to US4.
- T016 (docs) runs in parallel with any story once the behaviour it describes is settled.
- Within Phase 2 and US1 to US4, tasks share files, so they are sequential.

---

## Parallel Example: Foundational alongside User Story 5's logic

```bash
# Different files, no shared state:
Task: "T001 Write apps/web/src/lib/diff/wordDiff.test.ts"
Task: "T013 [US5] Extend apps/web/src/lib/diff/clubList.test.ts with in-run ascending order"
```

---

## Implementation Strategy

### MVP First (User Story 1 Only)

1. Complete Phase 2: the `wordDiff` tie-break (T001, T002).
2. Complete Phase 3: User Story 1 (T003 to T005).
3. **STOP and VALIDATE**: quickstart reference cases 1 and 2, Scenarios 1, 2, 3, and 5.

### Incremental Delivery

1. Phase 2: the tie-break fix, already an improvement to today's diff.
2. US1: proofread view (MVP).
3. US2: wrong-verse fallback, the screenshot that started this.
4. US3: pin down long and trailing edits.
5. US4: merged paraphrases.
6. US5: club lists.
7. Docs, release, full quickstart run.

Each step ships on its own without breaking the previous ones; the release (T017) waits for all of them so the changelog describes one coherent change.

---

## Notes

- [P] tasks = different files, no dependencies.
- [Story] label maps each task to its user story for traceability.
- Verify tests fail before implementing.
- Commit after each test-plus-implementation pair or story, per Principle V.
- Run `/speckit-analyze` before `/speckit-implement`.
