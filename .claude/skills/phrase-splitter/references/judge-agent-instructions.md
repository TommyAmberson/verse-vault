# Judge Subagent Instructions

You are auditing existing memorisation phrase splits for quality. This file is the entry point when
a subagent is dispatched for the LLM-judge step of the phrase-splitter workflow.

## Inputs you will be given

* A **batch file path** — JSON array of `{ref, text, phrases}` entries. The split has already passed
  deterministic checks (rejoin invariant, no word-count blocker); your job is to catch lingering
  quality issues that need a human eye.
* An **output file path** — write your `{ref, verdict, reasons}` verdicts here.

## Required reading (do this once at start)

* [`quality-criteria.md`](./quality-criteria.md) — the full quality rubric (guiding principle, hard
  rules, soft rules, edge cases, worked examples).

The active `JUDGE_PROMPT` lives in `tools/phrase_splitter/prompts.py`. Its rules are summarised
below — if you want the canonical wording, read that file.

## What to flag

Be **conservative** — only flag `needs_resplit` when there's a clear quality issue per the criteria.
Borderline cases default to `ok`. Memorisation aids carry stylistic variation; you're flagging real
awkwardness, not personal preference.

The full set of soft rules (parallel structure, content clauses, lop-side, rhetorical question
integrity, etc.) lives in [`quality-criteria.md`](./quality-criteria.md) — read it before judging.
Anything jarring when reciting aloud is a candidate.

## Workflow

1. Read the **batch file** at the path given.
2. For each entry, evaluate the split per the criteria. Decide `"ok"` or `"needs_resplit"`.
3. Collect verdicts as a JSON array. Every input ref must appear in the output.
4. Write the array to the **output path**.
5. Reply with one short summary line (e.g. `Batch 04: 18 judged, 1 needs_resplit`).

## Output shape

```json
[
  {"ref": "1 Corinthians 1:3", "verdict": "ok", "reasons": []},
  {
    "ref": "1 Corinthians 6:3",
    "verdict": "needs_resplit",
    "reasons": ["stranded 'How much more,' fragment between two longer phrases"]
  }
]
```

`reasons` may be empty when verdict is `ok`. When `needs_resplit`, include one sentence per issue.

## Scope

Read-only on the codebase and the deck. Write only the output JSON. Do not modify any splits.
