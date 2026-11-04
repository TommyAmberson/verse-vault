---
description: "Task list for recitation-based phrase splits"
---

# Tasks: Recitation-Based Phrase Splits

**Input**: Design documents from `/specs/008-recitation-splits/`

**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/, quickstart.md

**Tests**: Follow the constitution's testing principle. Where it calls for a test, the
implementation task names the test task or existing test that covers it. All Python tests live in
`tools/test_phrase_splitter.py` and run with `python3 -m unittest tools/test_phrase_splitter.py`.

**Organization**: Tasks are grouped by user story to enable independent implementation and testing
of each story.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (e.g., US1, US2, US3)
- Include exact file paths in descriptions

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

**Purpose**: A worktree that can run the tools against real decks.

- [X] T001 Confirm `packages/api/data/verse-vault.db` in the worktree resolves to the canonical clone's cache (quickstart.md prerequisites) and that `python3 -m unittest tools/test_phrase_splitter.py` runs; record that `test_with_current_split` already fails on master (stale prompt wording, replaced in T016)

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: The reference set and its calibration report, which every story is measured against.

**⚠️ CRITICAL**: No user story work can begin until this phase is complete

- [X] T002 Convert the reviewed splits in `~/notes/verse-split/gold/` (`*.json` and `draft2/*.json`) into `tools/phrase_splitter/reference_set.json` as word counts, per contracts/reference-set.md: one entry per verse with `ref`, `deck`, `agreed`, `confidence`, optional `note`, and `rejected` alternatives with reasons. Record these rejections from the review: John 5:4, 5:14, 5:16, 5:19, 5:29, 5:34 (each the merged or split draft Claude proposed, rejected in favour of the deck's current split, which becomes `agreed`); John 5:7 ("Sir, I have no man / to put me into the pool when the water is stirred up;" and the deck's "pool / when" cut); 2 Corinthians 11:24 ("From the Jews / five times …"); 1 Corinthians 12:3 (the half-split draft). Hebrews 6:17 is `unresolved`; the weak entries keep `weak`. The John 5 entries whose current split was kept are exactly 5:4, 5:14, 5:16, 5:19, 5:29 and 5:34; add no other unchanged verses. Validation rules from data-model.md hold: "`agreed` and every `rejected` entry sum to the verse's canonical token count", "No `rejected` entry equals `agreed`", "`ref` is unique within the set"
- [X] T003 Write tests first in `tools/test_phrase_splitter.py` for reference-set validation: an entry whose counts don't sum to the canonical count fails naming the reference; a `rejected` entry equal to `agreed` fails; duplicate `ref` fails; `unresolved` entries validate but are excluded from scores. Extend the existing test fixtures (inline token lists) rather than reading the cache
- [X] T004 Add the calibration mode to the audit, owned by `tools/evaluate_phrases.py` (`--calibrate`, `--show-text`, existing `--db` and `--min-score`), reusing its deck and cache loading, `check_verse` and `evaluate`: validates every entry (exit 1 naming the reference on failure), prints per-entry `changed`/`kept`, score, `ok` / `MISS` / `FALSE ALARM` and the signals that fired, renders deck and agreed splits from the cache with `--show-text`, and ends with the totals in data-model.md "Calibration result"; covered by T003. Run it against the current signals and save the baseline output to `~/notes/verse-split/` for the PR body

**Checkpoint**: `python3 tools/evaluate_phrases.py --calibrate` reports the baseline.

---

## Phase 3: User Story 1 - The audit surfaces the splits that hurt recitation (Priority: P1) 🎯 MVP

**Goal**: The audit's worklist leads with splits that break the recitation criteria and no longer
pushes lead-ins and speech tags to merge.

**Independent Test**: Calibration surfaces every `agreed` `changed` reference verse at the default
threshold (SC-001); quickstart.md step 3 shows the named signals.

### Tests for User Story 1

> **NOTE: Write each test first and see it fail.**

- [X] T005 [US1] Tests in `tools/test_phrase_splitter.py` for pause points and long runs, using the existing inline-token style: a 17-word phrase with a relative clause ("… raised up judges who delivered them …") reports a `relative` pause point at "who" and a full-strength `long_run`; an internal comma reports `punct`; "told the Jews that it was …" reports `content_clause`; a 14-word phrase with no pause point gets a reduced `long_run`; a 10-word phrase with an internal comma ("but while I am coming, another steps down before me.") gets a non-zero `long_run`; "For this reason" as its own phrase draws no score. Replace the existing tests of `stub_phrase`, `cognitive_overload`, `word_overload` and the other removed fields (data-model.md "Removed")
- [X] T006 [US1] Tests for boundaries: `bare_relative` and `verb_content` severance fire only when the two phrases together are a short run (about 10 words) and stay zero for "judges / who delivered them …"; `no_pause_cue` fires for a cut with no punctuation before it and no clause edge after it ("“Sir, I have no man / to put me into the pool" fires; "the hour is coming / in which" does not); it stays zero after a short sentence-opening lead-in ("For this reason / the Jews persecuted Jesus," per FR-008) and not for "into the pool / when the water" (`when` is a clause edge; research R4 "Known limit")
- [X] T007 [US1] Tests for lost poetic line breaks: "That it may give seed to the sower And bread to the eater," fires; capitalized "He", "Him", "You", "Your", "Lord", "Spirit" mid-phrase and "I" do not; a capitalized word after terminal punctuation does not
- [X] T008 [US1] Tests for lists: "in infirmities, in reproaches, in needs, in persecutions, in distresses," is a word list; cutting it internally reports `word_list_cut`; "Therefore I take pleasure in infirmities, …" in one phrase reports `lead_in_merged`; "that any people, nation, or language" does not (lead-in can't stand alone); "Shadrach, Meshach, and Abed-Nego" draws nothing; Romans 9:4's cut after "the covenants," does not report `word_list_cut` because the items lengthen there
- [X] T009 [US1] Tests for parallel asymmetry: 1 Corinthians 12:3 with only the second "no one …" half split reports `parallel_asymmetry`; both whole or both split reports zero; Hebrews 12:25's matching cuts report zero

### Implementation for User Story 1

- [X] T010 [US1] Pause points and the long-run signal per research R1 and R3, owned by `extract_phrase_features` in `tools/phrase_splitter/features.py`, reusing `_trailing_punct`, `_ends_in_pause` and `CONTENT_CLAUSE_VERBS`; remove the fields listed in data-model.md "Removed" and their readers in `tools/evaluate_phrases.py` and `tools/split_phrases.py`; signal names per contracts/signals.md; covered by T005
- [X] T011 [US1] Length-gated severance and `no_pause_cue` per research R4, owned by `extract_boundary_features` in `tools/phrase_splitter/features.py`; covered by T006
- [X] T012 [US1] Lost poetic line breaks per research R2, as a pause-point kind and the `lost_line_break` field, in `tools/phrase_splitter/features.py`, reusing `FUNCTION_WORDS` minus personal pronouns; covered by T007
- [X] T013 [US1] List detection and `list_breaks` per research R5, owned by `extract_verse_features` in `tools/phrase_splitter/features.py`; covered by T008
- [X] T014 [US1] Parallel asymmetry per research R11, owned by `extract_verse_features` in `tools/phrase_splitter/features.py`; covered by T009
- [X] T015 [US1] Composite weights: the weight table in `tools/phrase_splitter/features.py` covers the new float signals and drops the removed ones; `_top_signals` in `tools/evaluate_phrases.py` reads that table instead of its own `_SIGNAL_WEIGHTS` copy; tune weights with `--calibrate` until every `agreed` `changed` entry is flagged at the default threshold (FR-009, SC-001), then add the calibration test to `tools/test_phrase_splitter.py` asserting SC-001 and SC-006, skipping with a reason when the cache is missing. Record the before/after calibration totals for the PR body

**Checkpoint**: The audit alone delivers a useful worklist; calibration passes SC-001.

---

## Phase 4: User Story 2 - The LLM splitter and judge apply the recitation criteria (Priority: P1)

**Goal**: Prompts teach the six criteria with reference-set examples, show em dashes and the new
signals; replies with or without dashes apply to the same counts.

**Independent Test**: quickstart.md step 4; SC-003 and SC-004 measured per quickstart.md step 5.

### Tests for User Story 2

- [X] T016 [P] [US2] Tests in `tools/test_phrase_splitter.py`: the verse display text keeps em dashes while the token stream is unchanged ("come forth—those" yields the same tokens as today); reply validation accepts phrases that keep, drop or space a dash and those using straight quotes for curly ones, and rejects a paraphrase or a word-count mismatch; the rendered split prompt contains the six criteria headings and the dash-bearing verse; the rendered signals block names `long_run`, `pause_points`, `no_pause_cue`, `lost_line_break`, `parallel_asymmetry` and `list_breaks` when they fire. A verse with keyword markup (`<b>`/`<i>` from the deck's annotations) renders with both the markup and the em dashes. Replace `test_with_current_split`'s assertion on the old wording

### Implementation for User Story 2

- [X] T017 [US2] Before changing any prompt: render split prompts for every `agreed` reference verse with `--no-current`, dispatch the current splitter with Haiku and with Sonnet per `.claude/skills/phrase-splitter/SKILL.md`, and record exact-match counts against `agreed` in `~/notes/verse-split/` (SC-003 baseline, research R9)
- [X] T018 [US2] Verse display text with em dashes per research R7, owned by `tools/phrase_splitter/apibible.py` beside `extract_verse_tokens`, reusing `_strip_to_text` and the verse-marker parsing; used by prompt rendering in `tools/split_phrases.py`; covered by T016
- [X] T019 [US2] Token-based reply validation per research R7, owned by `_validate` in `tools/split_phrases.py` for both `apply` and `judge-pairs`, reusing `apibible._tokenise` and the quote folding from `_splice_smart_quotes`, which is then removed; covered by T016
- [X] T020 [US2] Rewrite `.claude/skills/phrase-splitter/references/quality-criteria.md` around the word-perfect goal and the six criteria (spec Background), with worked examples drawn from the reference set (agreed and rejected, at least one per criterion where one exists, FR-002); keep NKJV quotations to the short examples the doc already uses
- [X] T021 [US2] Rewrite `SPLIT_PROMPT` and `JUDGE_PROMPT` in `tools/phrase_splitter/prompts.py` and the signal rendering in `split_phrases._render_signals` to match T020 and contracts/signals.md; the judge keeps the current split on a tie (FR-013); covered by T016
- [X] T022 [P] [US2] Update `.claude/skills/phrase-splitter/references/splitter-agent-instructions.md` and `judge-agent-instructions.md` to point at the criteria doc and the new signal names instead of restating them; add the v0.6 entry to `references/prompt-design.md` and the transition note to `.claude/skills/phrase-splitter/SKILL.md`
- [X] T023 [US2] Measure after the rewrite: repeat T017 with the new prompt (new exact-match count must exceed the baseline, SC-003); run `judge-pairs` pairing each `agreed` split with each of its `rejected` alternatives in both orders and dispatch the judge with Sonnet (must pick `agreed` every time, SC-004). Record results in `~/notes/verse-split/` for the PR body; if SC-004 fails, revise T020/T021 and repeat

**Checkpoint**: Splitter and judge follow the criteria; measurements recorded.

---

## Phase 5: User Story 3 - The reference set calibrates the tooling (Priority: P2)

**Goal**: Calibration covers the optional parse signal and is documented for later tuning.

**Independent Test**: quickstart.md step 2 with and without spaCy.

- [X] T024 [US3] Tests in `tools/test_phrase_splitter.py` for the optional parse signal: without spaCy importable the verse payload's `parse` is `skipped` and every other signal is unchanged; with it (skip the test when spaCy is absent) Exodus 12:40's subject–predicate boundary appears as a `parse` pause point
- [X] T025 [US3] Optional parse signal per research R6 in new `tools/phrase_splitter/parse.py` (kept apart so the stdlib path never imports spaCy; no existing module fits because `features.py` must stay importable without it), called once per verse from `extract_verse_features` in `tools/phrase_splitter/features.py` only when importable, attaching its pause points to the phrases that contain them; the audit and `--calibrate` report which ran; covered by T024
- [X] T026 [US3] Document in `tools/README.md`: optional spaCy setup in a virtual environment for the tools, the cache link for worktrees, `--calibrate` usage and how to add a reviewed verse to the reference set
- [X] T027 [US3] Re-run `--calibrate` with the spaCy environment; if any `agreed` `changed` entry is missed or the weights from T015 no longer hold, re-tune the weight table in `tools/phrase_splitter/features.py` so SC-001 passes both with and without the parse signal; covered by the T015 calibration test run under each interpreter

**Checkpoint**: Calibration runs with and without the parse signal.

---

## Phase 6: Polish & Cross-Cutting Concerns

- [X] T028 Run quickstart.md end to end, including the SC-005 timing with and without spaCy; confirm `git status` shows no change under `data/` (FR-016)
- [X] T029 Run `dprint check` and `typos` over the changed docs; run `python3 -m unittest tools/test_phrase_splitter.py`

---

## Phase 7: User Story 2 - Propose, rate, select (amendment; supersedes the judge parts of Phase 4)

**Goal**: Replace the A/B judge with several candidates per verse, each rated on its own, and a
selector with an optional churn guard (spec FR-013, FR-017 to FR-020; research R12, R13).

**Independent Test**: SC-004 on candidate sets built from the reference set's agreed, acceptable
and rejected splits; quickstart.md step 5.

- [X] T030 [US2] Tests in `tools/test_phrase_splitter.py`: proposals in both shapes (`candidates` and the older `phrases`) collect into candidate sets per contracts/pipeline-files.md; invalid candidates are reported and dropped; rating batches never hold two candidates of the same verse; bad ratings and choices are reported and skipped per the contract; duplicates, including one equal to the current split, share one id; ids don't reveal which is current; rating prompts never say which split is current; selection prompts show every candidate's text and rating, mark the current one, and add the churn-guard instruction only when asked; `apply` with choices writes only verses whose choice is not current
- [X] T031 [US2] Splitter replies with one to three candidates: update the output contract in `SPLIT_PROMPT` (`tools/phrase_splitter/prompts.py`) and the splitter agent instructions; covered by T030
- [X] T032 [US2] Rating and selection, owned by new subcommands in `tools/split_phrases.py` replacing `judge-pairs`, reusing `_validate`, `_verse_tokens_and_text`, `_render_current_split` and `_render_signals`; rating and selection prompts in `tools/phrase_splitter/prompts.py` replacing `JUDGE_PROMPT`; `apply` gains choices input per contracts/pipeline-files.md; covered by T030
- [X] T033 [P] [US2] Replace `references/judge-agent-instructions.md` with rater and selector instructions, rewrite quickstart.md step 5 to match, and update `SKILL.md`'s workflow and transition note (v0.6) and `references/prompt-design.md` for the new steps
- [ ] T034 [US2] Measure per research R13 with Haiku and with Sonnet in each role: splitter candidates against agreed and acceptable splits on the held-out half (SC-003); rater and selector on candidate sets of agreed, acceptable and rejected splits, churn guard off (SC-004) and on with the agreed split as current (SC-007). Record results in `~/notes/verse-split/` for the PR body, and the measured model options in `SKILL.md`

---

## Phase 8: Signals, length and parse for the LLM steps (second amendment)

**Goal**: FR-021 to FR-025 and the criteria and prompt revisions from the second rate-and-select
review (research R14 to R16).

- [ ] T035 Record the maintainer's second-review verdicts in `tools/phrase_splitter/reference_set.json` (acceptable and rejected alternatives), and the finer-split tie-break in the criteria doc
- [X] T036 [US1] Tests then implementation in `tools/phrase_splitter/features.py` and `tools/test_phrase_splitter.py`: `long_run` on syllables (R15); `no_pause_cue` exempts a short lead-in after any pause punctuation (FR-023); calibration still catches every agreed change
- [ ] T037 [US3] Tests then implementation in `tools/phrase_splitter/parse.py`: fronted-object pauses, no subject-verb pause before a predicate of one or two words, model selectable and reported (FR-023, FR-024); compare `en_core_web_sm` and `en_core_web_trf` on the reference set and record the result
- [ ] T038 [US2] Tests then implementation: one table in `tools/phrase_splitter/features.py` owning each signal's criterion, threshold, strength rule and wording; rating prompts render flags from it with no numbers (FR-021), via `split_phrases._render_signals`; drop `ends-mid-clause` and `opens-with-connector` from LLM-facing text
- [ ] T039 [US2] Revise `_CRITERIA_SUMMARY`, `RATE_PROMPT`, `SELECT_PROMPT`, `_CHURN_GUARD` and the splitter output instruction in `tools/phrase_splitter/prompts.py`, and the criteria doc, from the Fable review (`~/notes/verse-split/llm/fable-review.md`) and the maintainer's rulings, including the finer-split tie-break (FR-025)
- [ ] T040 [US2] Re-measure per research R13 with the parse on: splitter (Haiku, Sonnet), rater and selector (all-Haiku, all-Sonnet, Sonnet rater with Haiku selector), guard off and on; record in `~/notes/verse-split/`

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: none
- **Foundational (Phase 2)**: after Setup; blocks every story (calibration is their yardstick)
- **US1 (Phase 3)**: after Foundational
- **US2 (Phase 4)**: after Foundational; T017 (baseline) must run before T020/T021 land; T021 renders US1's signals, so it follows T010–T014 for the signal names (or renders whichever exist, and is finished after US1)
- **US3 (Phase 5)**: after US1's T010 (pause points exist to extend); T027 after T015 and T025
- **Polish**: after all stories

### Within Each User Story

- Each test task is written and seen to fail before the implementation that names it
- T015 (weights) after T010–T014, since it tunes their weights

### Parallel Opportunities

- T006–T009 are independent test groups in the same file, so they are not marked [P]; write them in
  one sitting before T010
- T017 (LLM baseline) can run while US1 is implemented, as soon as T002 lands
- T022 is doc-only and can run alongside T021

---

## Parallel Example: User Story 1

```bash
# Test groups written together before implementation:
Task: "Boundary tests (length-gated severance, no_pause_cue) in tools/test_phrase_splitter.py"
Task: "Line-break tests in tools/test_phrase_splitter.py"
Task: "List tests in tools/test_phrase_splitter.py"
Task: "Parallel asymmetry tests in tools/test_phrase_splitter.py"
```

---

## Implementation Strategy

### MVP First (User Story 1 Only)

1. Setup and Foundational: reference set plus baseline calibration
2. US1: signals and weights until SC-001 passes
3. **STOP and VALIDATE**: the audit's worklist is already a useful review list

### Incremental Delivery

1. US1 → audit worklist
2. US2 → prompts the LLM steps can use on that worklist (baseline measured first)
3. US3 → optional parse signal and calibration docs

Commit per plan.md "Commit sequence"; releases: none (no shipping package or contract crate
changes).

---

## Notes

- [P] tasks = different files or independent test groups, no dependencies
- Verify tests fail before implementing
- Deck re-splitting is follow-up work, deck by deck, outside this feature
