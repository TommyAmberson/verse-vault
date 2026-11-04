# Implementation Plan: Recitation-Based Phrase Splits

**Branch**: `feat/recitation-splits` | **Date**: 2026-11-04 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `/specs/008-recitation-splits/spec.md`

## Summary

Re-aim the phrase-splitter tooling at word-perfect recitation. The audit gains deterministic signals
for the six agreed criteria (pause points inside long runs, lost poetic line breaks, length-gated
severance, cuts with no pause cue, parallel asymmetry, list handling) and drops the meaning-load and
merge-pressure signals. An optional spaCy parse adds pause points punctuation misses. The splitter
rater and selector prompts, the skill's criteria and agent instructions are rewritten around the
criteria, with worked examples from the user-reviewed reference set, and show verses with their em
dashes. The reference set is committed as word counts, and a calibration mode of the audit scores
the signals against it. The decks are not touched.

## Technical Context

**Language/Version**: Python 3 (stdlib only on the default path), as the existing `tools/`

**Primary Dependencies**: none required; optional spaCy with `en_core_web_sm` (research R6)

**Storage**: the committed year decks (read only) and the gitignored api.bible SQLite cache (read,
fetch on miss as today); a new committed reference-set JSON

**Testing**: `python3 -m unittest tools/test_phrase_splitter.py`; calibration test skips without the
cache

**Target Platform**: the maintainer's machine (Linux); not part of any shipped package

**Project Type**: CLI content tooling plus Claude Code skill documents

**Performance Goals**: full audit of all six phrase-split decks under a minute without spaCy, under
five minutes with it (SC-005)

**Constraints**: word-count convention unchanged (tokens split on whitespace or em dash); NKJV terms
(no verse text committed beyond the existing short documentation examples); deck files unchanged

**Scale/Scope**: six decks, 4,151 verses; about 40 reference verses

## Constitution Check

_GATE: Must pass before Phase 0 research. Re-check after Phase 1 design._

| Principle                          | Assessment                                                                                                                                                                                                                                                                                                                                                                     |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| I. Design docs are source of truth | The phrase-split docs are the skill's `references/` and `tools/README.md`; they change in the same commits as the code. `docs/decks.md` records per-deck split provenance; it changes when decks are re-split (follow-up), not here. Pass.                                                                                                                                     |
| II. Pure core, thin edges          | No crate or app code touched. Pass.                                                                                                                                                                                                                                                                                                                                            |
| III. Contract versions             | `crates/core` and `crates/wasm` untouched; no bump. Pass.                                                                                                                                                                                                                                                                                                                      |
| IV. Validate before you ship       | Tests first for each signal, the token-based validation, and calibration. No scheduling or algorithm change, so no simulation run. The required local checks (`dprint`, `typos`) cover the docs; the Python suite isn't in CI and is run by hand. A test on master already fails (`test_with_current_split` asserts old prompt wording); the prompt rewrite replaces it. Pass. |
| V. Atomic, traceable history       | One commit per signal or concern (see Commit sequence). Pass.                                                                                                                                                                                                                                                                                                                  |
| VI. No client can get stuck        | No client or sync path touched. N/A.                                                                                                                                                                                                                                                                                                                                           |
| VII. Simplest design that works    | New behaviour lands in existing owners (`features.py`, `prompts.py`, `evaluate_phrases.py`, `split_phrases.py`); one new data file and at most one new module (the optional parse). Removed signals go entirely. Calibration is a mode of the existing audit, not a new script. Pass.                                                                                          |

Content constraint: the reference set stores word counts, not text (research R8). Pass.

Post-design re-check: the design above holds; no violations to justify.

## Project Structure

### Documentation (this feature)

```text
specs/008-recitation-splits/
├── plan.md
├── research.md
├── data-model.md
├── quickstart.md
├── contracts/
│   ├── signals.md
│   └── reference-set.md
├── checklists/requirements.md
└── tasks.md             # /speckit-tasks
```

### Source Code (repository root)

```text
tools/
├── evaluate_phrases.py          # audit CLI: new --calibrate mode, top-signal summary reads the shared weight table
├── split_phrases.py             # prompt rendering with em dashes, token-based reply validation, signal rendering
├── test_phrase_splitter.py      # tests for new signals, validation, calibration
├── README.md                    # optional spaCy setup, calibration usage
└── phrase_splitter/
    ├── features.py              # signals and composite weights (the one owner)
    ├── apibible.py              # verse display text with dashes beside the token stream
    ├── prompts.py               # SPLIT_PROMPT rewritten; rating and selection prompts
    ├── parse.py                 # new, optional: spaCy pause points
    └── reference_set.json       # new: reviewed verses as word counts

.claude/skills/phrase-splitter/
├── SKILL.md                     # workflow, transition note v0.6
└── references/
    ├── quality-criteria.md      # rewritten around the six criteria
    ├── splitter-agent-instructions.md
    ├── rater-agent-instructions.md
    ├── selector-agent-instructions.md
    └── prompt-design.md         # v0.6 entry
```

**Structure Decision**: Everything lands in the existing tooling and skill directories. The only new
files are the reference set and the optional parse module, kept separate so the stdlib path never
imports spaCy.

## Reuse and Ownership

| Decision or write path                                     | Owner (existing symbol, or file and responsibility if new)                                                       | Existing code reused                                                                            |
| ---------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| Which signals a split has and their values                 | `phrase_splitter/features.py` (`extract_phrase_features`, `extract_boundary_features`, `extract_verse_features`) | `_trailing_punct`, `_ends_in_pause`, `CONTENT_CLAUSE_VERBS`, `WEAK_CONNECTORS`, `slice_phrases` |
| Composite score and signal weights                         | `features.py` composite weight table and `composite_signal_score`                                                | `_signal_max`; `evaluate_phrases._top_signals` reads this table instead of its own copy         |
| Parse-based pause points                                   | new `phrase_splitter/parse.py`, called once per verse from `extract_verse_features` only when importable         | spaCy                                                                                           |
| Verse text shown to the LLM                                | `phrase_splitter/apibible.py`, beside `extract_verse_tokens`                                                     | `_strip_to_text`, verse-marker parsing                                                          |
| Whether an LLM reply matches the canonical verse           | `split_phrases._validate` (apply and candidate collection)                                                       | `apibible._tokenise`, quote folding from `_splice_smart_quotes` (which then goes)               |
| Prompt text and signal rendering                           | `phrase_splitter/prompts.py`; `split_phrases._render_signals`                                                    | `format_split_prompt`; the judge prompt is replaced by rating and selection prompts             |
| Candidates, rating and selection prompts, applying choices | `split_phrases.py` subcommands replacing `judge-pairs`; `apply` takes choices                                    | `_validate`, `_verse_tokens_and_text`, `_render_current_split`, `_render_signals`               |
| Calibration and reference-set validation                   | `evaluate_phrases.py --calibrate`                                                                                | its deck and cache loading, `check_verse`, `evaluate`                                           |
| Criteria and examples for people and agents                | `.claude/skills/phrase-splitter/references/quality-criteria.md`                                                  | the agent-instruction docs link to it instead of restating it                                   |

**Platform already provides**: `apibible._tokenise` defines the word-count convention (split on
whitespace or em dash); the deck loader and cache fetch in `apibible.py`; `--db` on both CLIs.

**Releases**: none. No shipping package or contract crate changes.

## Commit sequence

1. The reference set as word counts, with the calibration mode reporting against the current signals
   (baseline numbers for the PR body).
2. Verse display text with em dashes, and token-based validation of replies.
3. Pause points and the long-run signal; drop the meaning-load and stub signals.
4. Length-gated severance and the no-pause-cue boundary signal.
5. Lost poetic line breaks.
6. List signals.
7. Parallel asymmetry.
8. Optional spaCy parse signal and its README setup.
9. Composite weights calibrated against the reference set, with and without the parse signal; the
   calibration test asserting SC-001.
10. Criteria doc, prompts and agent instructions rewritten (with the stale prompt test replaced);
    skill transition note.

Before step 10 lands, measure the current splitter prompt on the reference verses (research R9);
after it, measure again.

11. Acceptable alternatives in the reference set.
12. Propose, rate, select (research R12): multi-candidate splitter replies, per-candidate rating
    prompts, selection prompts with an optional churn guard, and `apply` from choices; `judge-pairs`
    and the judge prompt go. Then measure each step with Haiku and with Sonnet (research R13).

## Complexity Tracking

None.
