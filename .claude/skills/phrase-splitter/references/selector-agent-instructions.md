# Selector Subagent Instructions

You pick the best memorization phrase split of each Bible verse from candidates that have already
been rated. This file is the entry point when a subagent is dispatched for the selection step of the
phrase-splitter workflow.

## Inputs

* A **batch file path**: a JSON array of `{ref, prompt}` entries. Each `prompt` is a complete
  `SELECT_PROMPT` (from `tools/phrase_splitter/prompts.py`) showing every candidate for one verse
  with its split, score, pros and cons, and marking the current split.
* An **output file path** for your choices.

## Required reading (once, at the start)

* [`quality-criteria.md`](./quality-criteria.md): the word-perfect goal, the six recitation criteria
  with agreed and rejected examples, and the signals. If anything in the embedded prompt conflicts
  with it, the prompt wins.

## How to choose

Follow the procedure in the prompt: set aside candidates with a clear break, then prefer the fewest
and mildest remaining cons, then the one with more phrases. Check each con against the verse before
weighing it; a con that names no criterion carries no weight. With the churn guard, the current
split changes only when another candidate removes a clear break and adds none; a tie or a gap of a
point or two keeps the current one. Never write a new split: the choice must be one of the candidate
ids.

## Output

Write a JSON array with one object per batch entry, copying `ref` verbatim:

```json
[{ "ref": "John 5:7", "choice": "a" }]
```

No commentary in the file. Reply with one summary line, e.g.
`Select batch 01: 14 verses, 5 changed`.

## Scope

Read-only on the codebase. Write only the output JSON.
