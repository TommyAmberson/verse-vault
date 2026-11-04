# Judge Subagent Instructions

You are picking between two memorisation phrase splits for Bible verses. This file is the entry
point when a subagent is dispatched for the judge step of the phrase-splitter workflow.

## Inputs you will be given

* A **batch file path** — JSON array of `{ref, prompt}` entries. Each `prompt` already contains the
  full `JUDGE_PROMPT` (from `tools/phrase_splitter/prompts.py`) with the verse text, both splits as
  bullet blocks, and both signal blocks inlined.
* An **output file path** — write your `{ref, verdict}` results here. `verdict` is exactly one
  letter: `"A"` (keep current) or `"B"` (take proposed).

## Required reading (do this once at start)

* [`quality-criteria.md`](./quality-criteria.md): the word-perfect goal, the six recitation criteria
  that decide between the options, worked examples, and the signals (context, not rules).

The embedded `prompt` field in each batch entry contains the active `JUDGE_PROMPT`. If anything in
the embedded prompt conflicts with `quality-criteria.md`, the prompt wins (it's the version actually
shipped to production).

## How to judge

For each entry, read the verse text, both options, and both signal blocks, and judge each option
against the criteria: do its cuts fall where a reciter pauses, is each chunk one run, do lead-ins
and speech tags keep their handoffs, can each chunk fail on its own, are lists and parallel halves
handled as the criteria say?

Stability lives here. When both options meet the criteria equivalently, pick `A` (the current
split). Pick `B` only when it is _clearly_ better, not merely defensible.

The signal blocks are context, not commands. A lower composite generally means fewer flagged issues,
but some judgements have no surface cue, so don't pick `B` mechanically because its composite is
lower.

## Workflow

1. Read the **batch file** at the path given.
2. For each entry, follow the embedded `prompt` to produce a verdict — exactly `"A"` or `"B"`.
3. Collect results as a JSON array of `{ref, verdict}` objects.
4. Write the array to the **output path**.
5. Reply with one short summary line (e.g. `Judge batch 03: 14 verses, 6 picked B`).

## Output shape

```json
[
  { "ref": "1 Corinthians 6:7", "verdict": "B" },
  { "ref": "1 Corinthians 1:15", "verdict": "A" }
]
```

Every input ref must appear in the output. No commentary in the file — just the JSON array.

## Subagent-specific pitfalls

* **Don't write a third option.** The judge picks between A and B. If both options have real
  problems, prefer A (the current split) — a third pass through the splitter can revisit it later.
  Adding a third proposal would break the apply pipeline, which expects one of two pre-validated
  splits.
* **Don't paraphrase or rewrite phrases.** Both options have been validated for rejoin / word count
  / HTML balance. Your output is a single letter per ref; never re-emit the phrase strings.
* **Stability is your job, not the splitter's.** The splitter no longer carries a stability clause —
  it proposed its honest best split. If the proposal isn't a _clear_ improvement, pick A.

## Scope

Read-only on the codebase. Write only the output JSON. Do not modify the deck, the skill, or any
other file.
