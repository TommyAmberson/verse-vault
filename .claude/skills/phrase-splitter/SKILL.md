---
name: phrase-splitter
description: >-
  Use whenever the verse-vault project's phrase splitting comes up — auditing
  existing splits in the structural deck, regenerating bad ones, splitting a
  new verse from scratch, or anything touching `data/corinthians.json`'s
  `phraseWordCounts` field. Trigger phrases include "evaluate phrase splits",
  "re-split this verse", "bad phrase chunking", "the splits are awkward",
  "split this verse for memorisation", "the splitter prompt", or any mention of
  `corinthians.json`, `evaluate_phrases.py`, or `split_phrases.py`. Drive a tight
  loop: deterministic audit → LLM resplit on flagged verses → write-back to the
  structural file.
version: 0.2.0
---

# Phrase Splitter

The verse-vault deck stores memorisation phrases as **word counts**, not strings:
`data/corinthians.json`'s per-verse `phraseWordCounts: [n1, n2, …]` slices the canonical NKJV
(fetched from api.bible) into phrases. Splits should chunk each verse into 3–12 word phrases that
fall on natural reciting pauses (clause starts, parallel items, connectives that introduce new
thoughts). This skill is the loop for keeping that structural data high-quality.

## When to invoke

* The user asks to evaluate or audit phrase splits.
* The user names a specific bad verse split (e.g. "the 'But one' fragment in 12:11 is wrong").
* The user wants splits regenerated, either for specific refs or for whatever the evaluator flags.
* A new verse has no real split (single-phrase placeholder) and the user wants it chunked.
* The user mentions the splitter prompt or the splitter pipeline.

## Architecture

The splitter operates on two stores:

* **`data/corinthians.json`** — the committed structural deck file. Per-verse `phraseWordCounts` is
  the durable record of where phrase boundaries fall. Other relevant fields the audit reads:
  `annotations` (keyword markup), `ftvWordCount`, `headings`, `clubs`.
* **api.bible cache** — `packages/api/data/verse-vault.db`, table `apibible_passages`. Holds
  canonical NKJV HTML; tools fetch on demand and write back. Honour the 30-day TTL per API.Bible
  MAUA.

Verse text and word boundaries come from api.bible, **never the deck**. `phraseWordCounts` indexes
the api.bible token stream — same convention as `packages/api/src/lib/render.ts` at runtime.

## Workflow

### 1. Audit (`tools/evaluate_phrases.py`)

```bash
python3 tools/evaluate_phrases.py --top 20
python3 tools/evaluate_phrases.py --refs "1 Cor 12:11"
python3 tools/evaluate_phrases.py --out /tmp/report.json
```

Deterministic checks:

* `phraseWordCounts` sum matches api.bible's token count (catches drift)
* Each phrase word count in `[3, 12]`; edge phrases may be shorter
* Single-phrase verse with > 10 words → missing split
* `ftvWordCount` in range

Pass `--llm-judge` to add a Claude Haiku quality pass for verses that clear the deterministic checks
but might still feel awkward (needs `anthropic` + `ANTHROPIC_API_KEY`).

### 2. Re-split

```bash
# Print prompts for the worst N entries in a report
python3 tools/split_phrases.py print-prompt --from-report /tmp/report.json \
    --top 10 --json > /tmp/prompts.json

# Or target specific refs
python3 tools/split_phrases.py print-prompt --refs "1 Cor 12:11"
```

The prompt lives in `tools/phrase_splitter/prompts.py` (shared with this skill so iterations land in
one place). Refresh the criteria from `references/quality-criteria.md` before splitting any verse
where the judgement call isn't obvious.

The LLM in the loop (you, the model running this skill) answers each prompt with a single JSON array
of phrase strings. Collect proposals into a JSON file shaped as:

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
python3 tools/split_phrases.py apply --input /tmp/proposed.json --dry-run
python3 tools/split_phrases.py apply --input /tmp/proposed.json
```

`apply` rewrites only `phraseWordCounts` for the targeted verses. `annotations.wordIndex` and
`ftvWordCount` are positions in the canonical token stream and don't shift, so they're preserved
untouched.

### 3. Verify

```bash
python3 tools/evaluate_phrases.py --refs "1 Cor 12:11"
```

The deck is committed; once `corinthians.json` is happy, the change ships through git like any other
code edit. No regeneration step is needed — `corinthians.json` IS the file.

## Single-verse path (no audit needed)

When the user pastes a verse and asks for a split without referencing a specific ref or the deck,
the workflow shortens to: read `references/quality-criteria.md`, generate the split applying those
rules, return a JSON array. Still mentally check the rejoin (joined phrases match the input) before
answering.

## Reference files

* `references/quality-criteria.md` — what makes a split good or bad, with worked examples. Read
  before splitting any verse you're not sure about.
* `references/prompt-design.md` — current state of the prompt and notes on prior iterations. Read
  before editing `tools/phrase_splitter/prompts.py`.

## Sibling audit tools

The same `corinthians.json` + api.bible cache pair powers two adjacent auditors — useful to combine
with the splitter on a quality pass:

* `tools/find_ftvs.py` — shortest unique opening prefix per verse; audits the deck's `ftvWordCount`.
* `tools/find_keywords.py` — audits `annotations` (`bold` keywords, 1 verse occurrence; `boldItalic`
  context-keys, within ±5 verses) against canonical word occurrences.
* `tools/audit_colpkg.py` — read-only diff of an Anki `.colpkg` against `corinthians.json` and
  api.bible, flagging text typos / FTV / keyword markup / clubs drift between the Anki source and
  the structural file.

## Notes

* The CLIs live in `/home/amberson/Code/verse-vault/tools/`. Run them from the repo root.
* The user prefers atomic commits — one logical change per commit (see `CLAUDE.md`). When this skill
  writes splits, commit the `corinthians.json` change separately from any prompt-design or
  tool-script changes.
