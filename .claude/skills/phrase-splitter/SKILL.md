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
  `3-corinthians.json` / `4-john.json`. Drive a tight loop: deterministic
  audit → LLM judge → LLM resplit on flagged verses → write-back to the
  structural file. The judge and resplit steps run either via the
  `--llm-judge` flag (programmatic Haiku) or by dispatching parallel Claude
  Code subagents in-session.
version: 0.3.0
---

# Phrase Splitter

The verse-vault deck stores memorisation phrases as **word counts**, not strings: each year deck
(`data/<N>-<book>.json` — e.g. `data/3-corinthians.json`, `data/4-john.json`) has a per-verse
`phraseWordCounts: [n1, n2, …]` that slices the canonical NKJV (fetched from api.bible) into
phrases. Splits should chunk each verse into 3–12 word phrases that fall on natural reciting pauses
(clause starts, parallel items, connectives that introduce new thoughts). This skill is the loop for
keeping that structural data high-quality.

## When to invoke

* The user asks to evaluate or audit phrase splits.
* The user names a specific bad verse split (e.g. "the 'But one' fragment in 1 Cor 12:11 is wrong").
* The user wants splits regenerated, either for specific refs or for whatever the evaluator flags.
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

## Workflow

### 1. Audit (`tools/evaluate_phrases.py`)

Pass the target deck explicitly (year 3 is the implicit default):

```bash
# Year 3 — uses the default
python3 tools/evaluate_phrases.py --top 20

# Year 4
python3 tools/evaluate_phrases.py data/4-john.json --top 20

# Specific refs
python3 tools/evaluate_phrases.py data/4-john.json --refs "John 1:1, John 1:14"

# Write a JSON report for later filtering
python3 tools/evaluate_phrases.py data/4-john.json --out /tmp/john-report.json
```

Deterministic checks:

* `phraseWordCounts` sum matches api.bible's token count (catches drift)
* Each phrase word count in `[3, 12]`; edge phrases may be shorter
* Single-phrase verse with > 10 words → missing split
* `ftvWordCount` in range

### 2. LLM-judge (catches awkward-but-valid splits)

The deterministic pass misses splits that obey the bounds but still read badly (stranded fragments,
lumped parallels, lopsided distribution). Two ways to run the judge — both use `JUDGE_PROMPT` in
`tools/phrase_splitter/prompts.py`:

**a. `--llm-judge` (programmatic, Anthropic SDK)**

```bash
python3 tools/evaluate_phrases.py data/4-john.json --llm-judge --out /tmp/john-report.json
```

Needs `pip install anthropic` and `ANTHROPIC_API_KEY`. Runs the judge prompt over each verse that
cleared deterministic checks; merges verdicts into the report. Fast for one-shot CLI use outside
Claude Code.

**b. Subagent fan-out (in-session, parallel)**

When running this skill inside Claude Code, dispatch parallel `Agent` calls to judge instead of (or
in addition to) `--llm-judge`. Use `superpowers:dispatching-parallel-agents` to manage the fan-out.

Each subagent's prompt should point at
[`references/judge-agent-instructions.md`](references/judge-agent-instructions.md), which is the
canonical entry-point doc for judging subagents. The instructions tell the subagent to read
`quality-criteria.md`, lay out the workflow, and specify the output shape. The dispatch prompt just
needs to:

1. Point at the instructions doc.
2. Give the batch file path (JSON array of `{ref, text, phrases}`).
3. Give the output file path.

Build batches of ~15–20 verses each. Merge the verdicts with the deterministic flags to build the
resplit worklist. This path is preferred when the skill is being driven interactively, because it
keeps the judging in the same evaluation loop as everything else.

### 3. Re-split

```bash
# From an evaluator report
python3 tools/split_phrases.py --deck data/4-john.json print-prompt \
    --from-report /tmp/john-report.json --top 10 --json > /tmp/prompts.json

# Or target specific refs
python3 tools/split_phrases.py --deck data/4-john.json print-prompt \
    --refs "John 1:14, John 3:16"
```

`SPLIT_PROMPT` lives in `tools/phrase_splitter/prompts.py` (shared with this skill so iterations
land in one place). Refresh the criteria from `references/quality-criteria.md` before splitting any
verse where the judgement call isn't obvious.

For a small worklist (≤ 10 verses), the main agent answers each prompt directly. For a large
worklist, dispatch parallel subagents (small batches per agent, typically 12–15 verses) using
`superpowers:dispatching-parallel-agents`. The subagent's prompt should point at
[`references/splitter-agent-instructions.md`](references/splitter-agent-instructions.md), the
canonical entry-point doc — and give it the batch file path + output file path. The instructions
handle the rest (read criteria, follow the embedded `SPLIT_PROMPT` in each batch entry, verify
rejoin, write proposals).

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

Apply with deterministic validation (word counts sum to canonical token count; each phrase ≤ 12
words):

```bash
python3 tools/split_phrases.py --deck data/4-john.json apply \
    --input /tmp/proposed.json --dry-run
python3 tools/split_phrases.py --deck data/4-john.json apply \
    --input /tmp/proposed.json
```

`apply` rewrites only `phraseWordCounts` for the targeted verses. `annotations.wordIndex` and
`ftvWordCount` are positions in the canonical token stream and don't shift, so they're preserved
untouched.

### 4. Verify

```bash
python3 tools/evaluate_phrases.py data/4-john.json --refs "John 1:14"
```

The deck is committed; once the year deck is happy, the change ships through git like any other code
edit. No regeneration step is needed — the year deck IS the file.

## Single-verse path (no audit needed)

When the user pastes a verse and asks for a split without referencing a specific ref or the deck,
the workflow shortens to: read `references/quality-criteria.md`, generate the split applying those
rules, return a JSON array. Still mentally check the rejoin (joined phrases match the input) before
answering.

## Reference files

* `references/quality-criteria.md` — what makes a split good or bad, with worked examples. Read
  before splitting any verse you're not sure about, and pass to subagents that are judging or
  splitting.
* `references/prompt-design.md` — current state of the prompt and notes on prior iterations. Read
  before editing `tools/phrase_splitter/prompts.py`.

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
