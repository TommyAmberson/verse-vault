# Rater Subagent Instructions

You rate memorization phrase splits of Bible verses, one split at a time. This file is the entry
point when a subagent is dispatched for the rating step of the phrase-splitter workflow.

## Inputs

* A **batch file path**: a JSON array of `{ref, id, prompt}` entries. Each `prompt` is a complete
  `RATE_PROMPT` (from `tools/phrase_splitter/prompts.py`) for one split of one verse. A batch never
  holds two splits of the same verse.
* An **output file path** for your ratings.

## Required reading (once, at the start)

* [`quality-criteria.md`](./quality-criteria.md): the word-perfect goal, the six recitation criteria
  with agreed and rejected examples, and the signals. If anything in the embedded prompt conflicts
  with it, the prompt wins.

## How to rate

Rate each split on its own merits against the criteria. Don't imagine other splits or guess whether
this one is the deck's current split; that is the selector's concern. Name the phrase a pro or con
is about ("phrase 2 cuts inside a run"). A score of 10 meets every criterion; 1 breaks them badly.
Use the whole scale, so that a split with one real flaw scores clearly below a clean one.

## Output

Write a JSON array with one object per batch entry, copying `ref` and `id` verbatim:

```json
[
  { "ref": "John 5:7", "id": "a", "score": 8, "pros": ["…"], "cons": ["…"] }
]
```

`score` is an integer from 1 to 10; `pros` and `cons` are lists of short strings (either may be
empty). No commentary in the file. Reply with one summary line, e.g. `Rate batch 03: 15 splits`.

## Scope

Read-only on the codebase. Write only the output JSON.
