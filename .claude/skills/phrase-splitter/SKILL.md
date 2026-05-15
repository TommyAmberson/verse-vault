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
  score (auditor emits features) → re-split (splitter sees the current split
  + signals, proposes its honest best split) → score the proposals →
  judge (LLM picks A or B per verse, where stability lives) → apply →
  verify. The splitter and judge steps run either as the main agent
  answering prompts directly, or by dispatching parallel Claude Code
  subagents.
version: 0.5.0
---

# Phrase Splitter

The verse-vault deck stores memorisation phrases as **word counts**, not strings: each year deck
(`data/<N>-<book>.json` — e.g. `data/3-corinthians.json`, `data/4-john.json`) has a per-verse
`phraseWordCounts: [n1, n2, …]` that slices the canonical NKJV (fetched from api.bible) into
phrases. The guiding principle is that **each phrase is a memorisable chunk** — a unit a reciter
could blank on while still sensing the shape of the gap from what's left. Partition by _function_,
not by grammatical completeness: short framing intros, appositive chunks, and parallel siblings are
all valid even when they don't read as complete sentences in isolation. There are no rules, only
signals; the splitter aspires to the best split, sometimes by leaving a long clause whole.

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

The pipeline has two LLM-touching parts: the splitter (proposes its honest best split, no stability
bias) and the judge (compares the current split against the proposed one and picks). The auditor is
deterministic and runs twice — once on the current splits to build the worklist, once on the
proposals so the judge sees both signal blocks. Stability lives _only_ in the judge step now: when
the two options are genuinely equivalent under the recall test, the judge picks A (the current
split). The splitter no longer carries that bias itself.

## Workflow

Before any LLM step (re-split or judge), ask the user which model to dispatch subagents with.
Default recommendation: **Opus for both** — splitting and judging are precision tasks that benefit
from the stronger model. Sonnet is a reasonable pick for the splitter on a force-fresh pass where
speed and cost outweigh peak quality. Pass the choice through to the `Agent` tool's `model`
parameter (`"opus"` / `"sonnet"`); the agent-instructions docs the subagents read are
model-agnostic.

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
* The **current split** rendered as bullets, framed as context only. The splitter is no longer asked
  to defend the current split — it should propose its honest best split. Stability lives in the
  judge step (step 3 below), not in this prompt.
* A **signals** block — deterministic features of the current split, formatted as one line per
  phrase + boundary flags. The LLM reads these as context, not commands.

For a small worklist (≤ 10 verses), the main agent answers each prompt directly. For a large
worklist, dispatch parallel subagents (small batches per agent, typically 12–15 verses) using
`superpowers:dispatching-parallel-agents`. The subagent's prompt should point at
[`references/splitter-agent-instructions.md`](references/splitter-agent-instructions.md) — the
canonical entry-point doc — and give it the batch file path + output file path.

Each LLM reply is a single JSON array of phrase strings. Collect proposals into a JSON file shaped
as:

```json
[
  {
    "ref": "1 Corinthians 12:11",
    "phrases": [
      "But one and the same Spirit works all these things,",
      "distributing to each one individually as He wills."
    ]
  }
]
```

### 3. Judge (`tools/split_phrases.py judge-pairs`)

Skip this step on a force-fresh resplit (no current to compare against). For a second pass on an
existing deck:

```bash
# Score the proposals so the judge sees signals for both sides
python3 tools/split_phrases.py --deck data/4-john.json judge-pairs \
    --proposals /tmp/proposed.json --out /tmp/judge-prompts.json
```

`judge-pairs` reads the proposals, recomputes signals against each proposal's `phraseWordCounts`,
and emits one prompt per verse where current ≠ proposed. Each prompt embeds the verse text, both
splits as bullets, and both signal blocks. The judge replies with one character — `A` (keep current)
or `B` (take proposed) — and stability lives here: ties go to A.

For a small worklist (≤ 20 verses), the main agent answers directly. For larger ones, dispatch
parallel judge subagents (point them at
[`references/judge-agent-instructions.md`](references/judge-agent-instructions.md)). Collect
verdicts into a JSON file:

```json
[
  { "ref": "1 Corinthians 6:7", "verdict": "B" },
  { "ref": "1 Corinthians 1:15", "verdict": "A" }
]
```

Feed the verdicts back into `apply` (step 4) — only `B` entries get written.

### 4. Apply (`tools/split_phrases.py apply`)

```bash
python3 tools/split_phrases.py --deck data/4-john.json apply \
    --input /tmp/proposed.json --dry-run
python3 tools/split_phrases.py --deck data/4-john.json apply \
    --input /tmp/proposed.json

# Second-pass form: filter by judge verdicts
python3 tools/split_phrases.py --deck data/4-john.json apply \
    --input /tmp/proposed.json --verdicts /tmp/verdicts.json
```

`apply` rewrites only `phraseWordCounts` for the targeted verses. The validator confirms each
proposal rejoins to the canonical text and the per-verse word counts sum correctly; refs that fail
are listed and the deck is left untouched. `annotations.wordIndex` and `ftvWordCount` are positions
in the canonical token stream and don't shift when only the split boundaries change, so they're
preserved. A proposal whose word counts already match the deck is a no-op.

With `--verdicts`, only refs whose verdict is `B` get applied; `A` verdicts are filtered out before
the validator runs.

### 5. Verify

```bash
python3 tools/evaluate_phrases.py data/4-john.json --refs "John 1:14" --all
```

The deck is committed; once the year deck is happy, the change ships through git like any other code
edit. No regeneration step is needed — the year deck IS the file.

## Single-verse path (no audit needed)

When the user pastes a verse and asks for a split without referencing a specific ref or the deck,
the workflow shortens to: read `references/quality-criteria.md`, apply the recall test, return a
JSON array. Still mentally check the rejoin (joined phrases match the input) before answering.

If the verse exists in a deck and the user wants the same context the LLM normally sees, the
`--no-current --no-signals` form of `print-prompt` renders a clean prompt with just the verse text.

## Transition notes

* **v0.4 (skipped).** Briefly had no judge step at all — the splitter prompt carried a stability
  clause and decided whether to change boundaries itself. That over-merged because the splitter
  could only see one side of the comparison (its own proposal); the conservatism collapsed into "the
  current split is probably fine."
* **v0.5 (current).** Judge restored, but at a different position. Pre-v0.4's judge gated _whether
  to re-split_ — i.e. ran before the splitter. v0.5's judge runs _after_ the splitter and compares
  two concrete options (current vs proposed). The splitter is free to propose its honest best split;
  stability lives in the judge's tie-break rule (ties go to A = current). `JUDGE_PROMPT` and
  `format_judge_prompt` are back in `tools/phrase_splitter/prompts.py`.

## Reference files

* `references/quality-criteria.md` — the memorisable-chunk principle, hard constraints, signals
  (context, not rules), worked examples, and the recall test that's the judge's deciding criterion.
  Read before splitting or judging any verse you're not sure about, and pass to subagents.
* `references/splitter-agent-instructions.md` — entry point for splitter subagents.
* `references/judge-agent-instructions.md` — entry point for judge subagents.
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
