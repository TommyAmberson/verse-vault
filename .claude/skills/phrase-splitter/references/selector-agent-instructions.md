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

Weigh the ratings, but decide by the criteria: a single decisive con (a cut inside a run, a lead-in
merged away) can outweigh a higher score. When the prompt includes the churn guard, keep the current
split unless another candidate is clearly better; when it doesn't, pick the best candidate outright.
Never write a new split: the choice must be one of the candidate ids.

## Output

Write a JSON array with one object per batch entry, copying `ref` verbatim:

```json
[{ "ref": "John 5:7", "choice": "a" }]
```

No commentary in the file. Reply with one summary line, e.g.
`Select batch 01: 14 verses, 5 changed`.

## Scope

Read-only on the codebase. Write only the output JSON.
