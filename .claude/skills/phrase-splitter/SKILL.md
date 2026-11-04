---
name: phrase-splitter
description: >-
  Use whenever the verse-vault project's phrase splitting comes up — auditing
  existing splits in any year deck (`data/<N>-<book>.json`), regenerating bad
  splits, splitting a new verse from scratch, or anything touching a deck's
  `phraseWordCounts` field. Trigger phrases include "evaluate phrase splits",
  "re-split this verse", "bad phrase chunking", "the splits are awkward",
  "split this verse for memorisation", "the splitter prompt", or any mention
  of `evaluate_phrases.py`, `split_phrases.py`, or a year-deck file like
  `3-corinthians.json` / `4-john.json`. Drive a tight loop:
  score (auditor emits features) → propose (splitter offers one to three
  candidate splits) → rate (each candidate and the current split rated on
  its own) → select (LLM picks one, optional churn guard) → apply →
  verify. The LLM steps run either as the main agent answering prompts
  directly, or by dispatching parallel Claude Code subagents.
version: 0.6.0
---

# Phrase Splitter

The verse-vault deck stores memorisation phrases as **word counts**, not strings: each year deck
(`data/<N>-<book>.json` — e.g. `data/3-corinthians.json`, `data/4-john.json`) has a per-verse
`phraseWordCounts: [n1, n2, …]` that slices the canonical NKJV (fetched from api.bible) into
phrases. The decks serve word-perfect Bible quizzing, and the guiding principle is that **a split
matches the reciter's runs**: cut where you would naturally pause reciting aloud, keep each chunk to
one run, and give lead-ins and speech tags whose wording slips their own handoff. The six criteria
and their worked examples live in `references/quality-criteria.md`.

## When to invoke

* The user asks to evaluate or audit phrase splits.
* The user names a specific bad verse split (e.g. "the 'But one' fragment in 1 Cor 12:11 is wrong").
* The user wants splits regenerated, either for specific refs or for whatever the auditor surfaces.
* A new verse has no real split (single-phrase placeholder) and the user wants it chunked.
* The user mentions the splitter prompt or the splitter pipeline.

## Deck files

One JSON per year. The tooling defaults to year 3 but every CLI accepts a deck path argument:

| Year | File                      | Books                 |
| ---- | ------------------------- | --------------------- |
| 3    | `data/3-corinthians.json` | 1–2 Corinthians       |
| 4    | `data/4-john.json`        | John                  |
| 5    | `data/5-hp.json`          | (Hebrews-Philippians) |
| 6    | `data/6-ot-survey.json`   | OT Survey             |
| 7    | `data/7-rj.json`          | Romans–Jude           |

(Years 1–2 use different deck shapes and are not phrase-split here.)

## Architecture

The splitter operates on two stores:

* **`data/<N>-<book>.json`** — the committed structural deck file. Per-verse `phraseWordCounts` is
  the durable record of where phrase boundaries fall. Other relevant fields the audit reads:
  `annotations` (keyword markup), `ftvWordCount`, `headings`, `clubs`.
* **api.bible cache** — `packages/api/data/verse-vault.db`, table `apibible_passages`. Holds
  canonical NKJV HTML; tools fetch on demand and write back. Honour the 30-day TTL per API.Bible
  MAUA.

Verse text and word boundaries come from api.bible, **never the deck**. `phraseWordCounts` indexes
the api.bible token stream — same convention as `packages/api/src/lib/render.ts` at runtime.

The pipeline has three LLM steps. The splitter offers one to three candidate splits per verse. A
rater rates every candidate, and the current split, one at a time without knowing which is current:
pros, cons and a score from 1 to 10. A selector reads all the rated candidates for a verse and picks
one; with the churn guard on, it keeps the current split unless another is clearly better. The
auditor is deterministic: it builds the worklist, and its signals for each candidate go into the
rating prompts. File shapes are in `specs/008-recitation-splits/contracts/pipeline-files.md`.

## Workflow

Before any LLM step, ask the user which model to dispatch each step's subagents with: all-Haiku when
tokens are short, all-Sonnet when they aren't, or a mix. The measured results for each step on the
reference set are under "Model choice" below. Pass the choice through to the `Agent` tool's `model`
parameter; the agent-instruction docs the subagents read are model-agnostic.

### 1. Score (`tools/evaluate_phrases.py`)

Walks the deck and emits one record per verse: structural blockers (deck/canonical drift, unbalanced
HTML, ftv out of range) and, when there are no blockers, a composite `signal_score` in `[0, 1]` plus
the full `signals` payload (cognitive weight, restrictive-relative boundaries, weak-connector
starts, length balance, …).

```bash
# Year 3 (default deck), top 20 by composite score
python3 tools/evaluate_phrases.py --top 20

# Year 4
python3 tools/evaluate_phrases.py data/4-john.json --top 20

# Tune the threshold (default 0.2)
python3 tools/evaluate_phrases.py data/4-john.json --min-score 0.3

# Specific refs (always emitted regardless of threshold via --all)
python3 tools/evaluate_phrases.py data/4-john.json --refs "John 1:1, John 1:14" --all

# Write a JSON report for the splitter to consume
python3 tools/evaluate_phrases.py data/4-john.json --out /tmp/john-report.json --all
```

Blockers fail the run (exit 1). Signal-flagged verses sort worst-first by score.

### 2. Re-split (`tools/split_phrases.py print-prompt`)

```bash
# From a saved report (signals reused from the report)
python3 tools/split_phrases.py --deck data/4-john.json print-prompt \
    --from-report /tmp/john-report.json --top 10 --json > /tmp/prompts.json

# Or target specific refs (signals recomputed on the fly)
python3 tools/split_phrases.py --deck data/4-john.json print-prompt \
    --refs "John 1:14, John 3:16"

# Single-verse paste path (splitter operates purely on the verse text)
python3 tools/split_phrases.py --deck data/4-john.json print-prompt \
    --refs "John 1:14" --no-current --no-signals
```

`SPLIT_PROMPT` lives in `tools/phrase_splitter/prompts.py`. By default each prompt includes:

* The canonical verse text.
* The **current split** rendered as bullets, framed as context only. The splitter proposes its
  honest best splits; stability lives in the selector's churn guard, not in this prompt.
* A **signals** block — deterministic features of the current split, formatted as one line per
  phrase + boundary flags. The LLM reads these as context, not commands.

For a small worklist (≤ 10 verses), the main agent answers each prompt directly. For a large
worklist, dispatch parallel subagents (small batches per agent, typically 12–15 verses) using
`superpowers:dispatching-parallel-agents`. The subagent's prompt should point at
[`references/splitter-agent-instructions.md`](references/splitter-agent-instructions.md) — the
canonical entry-point doc — and give it the batch file path + output file path.

Each reply is a JSON array of one to three candidate splits, best first. Collect them into a file
shaped as:

```json
[
  {
    "ref": "1 Corinthians 12:11",
    "candidates": [
      ["But one and the same Spirit works all these things,",
       "distributing to each one individually as He wills."]
    ]
  }
]
```

### 3. Rate (`tools/split_phrases.py rate-prompts`)

Skip rating and selection on a force-fresh pass (placeholder splits): apply the splitter's first
candidates directly with `apply --input`.

```bash
python3 tools/split_phrases.py --deck data/4-john.json rate-prompts \
    --proposals /tmp/proposals.json --candidates-out /tmp/candidates.json \
    --outdir /tmp/rate --batch-size 15
```

`rate-prompts` validates each candidate against the canonical words, merges them with the current
split (identical splits share one id, and ids don't reveal which is current), writes the candidate
sets, and emits one rating prompt per candidate. Batches never hold two candidates of the same
verse, so a rater never compares them. Dispatch rater subagents per batch, pointing them at
[`references/rater-agent-instructions.md`](references/rater-agent-instructions.md), and collect the
replies into one `ratings.json`: `[{ref, id, score, pros, cons}]`.

### 4. Select (`tools/split_phrases.py select-prompts`)

```bash
python3 tools/split_phrases.py --deck data/4-john.json select-prompts \
    --candidates /tmp/candidates.json --ratings /tmp/ratings.json \
    --out /tmp/select.json --churn-guard
```

One prompt per verse shows every candidate with its split, score, pros and cons, and marks the
current one. Malformed ratings are reported and skipped, and a verse with an unrated candidate gets
no prompt. Dispatch selector subagents with
[`references/selector-agent-instructions.md`](references/selector-agent-instructions.md) and collect
`choices.json`: `[{ref, choice}]`. Use `--churn-guard` on an existing deck so the current split
survives unless another is clearly better.

### 5. Apply (`tools/split_phrases.py apply`)

```bash
python3 tools/split_phrases.py --deck data/4-john.json apply \
    --candidates /tmp/candidates.json --choices /tmp/choices.json --dry-run
python3 tools/split_phrases.py --deck data/4-john.json apply \
    --candidates /tmp/candidates.json --choices /tmp/choices.json

# Force-fresh pass: apply each verse's first candidate directly
python3 tools/split_phrases.py --deck data/4-john.json apply --input /tmp/proposals.json
```

`apply` rewrites only `phraseWordCounts`, and only for verses whose choice isn't the current split.
Unknown choices are reported and the verse is left unchanged. `annotations.wordIndex` and
`ftvWordCount` are positions in the canonical token stream and don't shift when only the split
boundaries change, so they're preserved.

### 6. Verify

```bash
python3 tools/evaluate_phrases.py data/4-john.json --refs "John 1:14" --all
```

The deck is committed; once the year deck is happy, the change ships through git like any other code
edit. No regeneration step is needed — the year deck IS the file.

## Model choice

Measured on the reference set's agreed verses, with no current split shown, scored against the
agreed and acceptable splits on the half held out from prompt tuning (18 verses):

| Splitter prompt (single proposal) | Haiku | Sonnet |
| --------------------------------- | ----- | ------ |
| v0.5 prompt                       | 1/18  | 3/18   |
| v0.6 prompt                       | 4/18  | 10/18  |
| v0.6 prompt plus a length rule    | 11/18 | n/a    |

Rating and selection results, and the multi-candidate splitter, are recorded in the PR that
introduced them. Prefer Sonnet for the selector when tokens allow; Haiku is the cheap option for the
splitter.

## Single-verse path (no audit needed)

When the user pastes a verse and asks for a split without referencing a specific ref or the deck,
the workflow shortens to: read `references/quality-criteria.md`, apply its criteria, return a JSON
array. Still mentally check the rejoin (joined phrases match the input) before answering.

If the verse exists in a deck and the user wants the same context the LLM normally sees, the
`--no-current --no-signals` form of `print-prompt` renders a clean prompt with just the verse text.

## Transition notes

* **v0.4 (skipped).** Briefly had no judge step at all — the splitter prompt carried a stability
  clause and decided whether to change boundaries itself. That over-merged because the splitter
  could only see one side of the comparison (its own proposal); the conservatism collapsed into "the
  current split is probably fine."
* **v0.5.** Judge restored, but at a different position. Pre-v0.4's judge gated _whether to
  re-split_ — i.e. ran before the splitter. v0.5's judge runs _after_ the splitter and compares two
  concrete options (current vs proposed). The splitter is free to propose its honest best split;
  stability lives in the judge's tie-break rule (ties go to A = current). `JUDGE_PROMPT` and
  `format_judge_prompt` are back in `tools/phrase_splitter/prompts.py`.
* **v0.6 (current).** Propose, rate, select replaces the A/B judge: the A/B judge only failed when
  the better split sat in position B, and a single cheap proposal landed at the wrong granularity in
  either direction. Recitation criteria (spec `specs/008-recitation-splits/`). The meaning-load and
  merge-pressure signals gave way to signals for recitation runs (`long_run` with `pause_points`,
  `no_pause_cue`, `lost_line_break`, `parallel_asymmetry`, `list_breaks`). The prompts teach the six
  criteria with examples the maintainer agreed, and show verses with their em dashes.
  `evaluate_phrases.py --calibrate` scores the audit against the committed reference set; add a
  verse there whenever the maintainer settles a split.

## Reference files

* `references/quality-criteria.md`: the word-perfect goal, the six recitation criteria with agreed
  and rejected examples, hard constraints, and the signals (context, not rules). Read before
  splitting or judging any verse you're not sure about, and pass to subagents.
* `references/splitter-agent-instructions.md` — entry point for splitter subagents.
* `references/rater-agent-instructions.md` — entry point for rater subagents.
* `references/selector-agent-instructions.md` — entry point for selector subagents.
* `references/prompt-design.md` — current state of `SPLIT_PROMPT` / `JUDGE_PROMPT` and notes on
  prior iterations. Read before editing `tools/phrase_splitter/prompts.py`.

## Sibling audit tools

The same year-deck + api.bible cache pair powers two adjacent auditors — useful to combine with the
splitter on a quality pass:

* `tools/find_ftvs.py --deck data/4-john.json` — shortest unique opening prefix per verse; audits
  the deck's `ftvWordCount`.
* `tools/find_keywords.py --deck data/4-john.json` — audits `annotations` (`bold` keywords, 1 verse
  occurrence; `boldItalic` context-keys, within ±5 verses) against canonical word occurrences.
* `tools/audit_colpkg.py --deck data/4-john.json` — read-only diff of an Anki `.colpkg` against the
  year deck and api.bible, flagging text typos / FTV / keyword markup / clubs drift between the Anki
  source and the structural file.

## Notes

* The CLIs live in `/home/amberson/Code/verse-vault/tools/`. Run them from the repo root.
* The user prefers atomic commits — one logical change per commit (see `CLAUDE.md`). When this skill
  writes splits, commit the year-deck change separately from any prompt-design or tool-script
  changes. When auditing multiple years in one session, one commit per year deck is the norm.
