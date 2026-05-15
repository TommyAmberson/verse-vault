# Splitter Subagent Instructions

You are generating memorisation phrase splits for Bible verses. This file is the entry point when a
subagent is dispatched for the re-split step of the phrase-splitter workflow.

## Inputs you will be given

* A **batch file path** — JSON array of `{ref, prompt}` entries. Each `prompt` already contains the
  full `SPLIT_PROMPT` (from `tools/phrase_splitter/prompts.py`) with the verse text inlined.
* An **output file path** — write your `{ref, phrases}` results here.

## Required reading (do this once at start)

* [`quality-criteria.md`](./quality-criteria.md) — the memorisable-chunk principle, hard
  constraints, signals (context, not rules), and worked examples.

The embedded `prompt` field in each batch entry contains the active `SPLIT_PROMPT`, so you don't
need to read `prompts.py` separately. If anything in the embedded prompt conflicts with
`quality-criteria.md`, the prompt wins (it's the version actually shipped to production).

## Current split + signals (context, not echo)

Each batch entry's `prompt` may contain a `Current split` section and a `Signals` section. Use them
as context for your rewrite; don't echo them back. The goal is the best split — not necessarily a
different split. If the current split already passes the recall test (each phrase a coherent
memorisable chunk that the reciter could blank on and still sense the shape of the gap), return it
verbatim. Change boundaries only when the new split is _clearly_ better, not merely defensible.

A phrase doesn't have to read as a complete English sentence to be a good memorisable unit — short
framing intros and appositive chunks are valid when they do a discrete job. Partition by function,
not by grammatical completeness. The signals are deterministic features of the current split (weak
connectors, restrictive-relative boundaries, length balance, etc.) — read them to spot patterns, not
to fix them mechanically.

## Workflow

1. Read the **batch file** at the path given.
2. For each entry, follow the embedded `prompt` to produce a JSON array of phrase strings.
3. Before adding to the output, **mentally verify the rejoin**: `" ".join(phrases)` must exactly
   equal the verse text from the prompt (single spaces, all punctuation, smart quotes, HTML tags
   preserved byte-for-byte). If it doesn't match, fix the split.
4. Collect results as a JSON array of `{ref, phrases}` objects.
5. Write the array to the **output path**.
6. Reply with one short summary line (e.g.
   `Batch 07: 15 verses, longest 18w (rhetorical question)`).

## Output shape

```json
[
  {
    "ref": "John 1:1",
    "phrases": [
      "In the beginning was the Word,",
      "and the Word was with God,",
      "and the Word was God."
    ]
  }
]
```

Every input ref must appear in the output. No commentary in the file — just the JSON array.

## Subagent-specific pitfalls

The splitting rules live in the embedded `SPLIT_PROMPT` and
[`quality-criteria.md`](./quality-criteria.md). The points below are the operational gotchas that
trip up a subagent reading a JSON batch:

* **Don't paraphrase.** Use the exact tokens from the embedded prompt — they are canonical api.bible
  NKJV.
* **Smart quotes are distinct bytes.** Curly `“ ” ‘ ’` and straight quotes don't compare equal; copy
  them verbatim or the rejoin invariant fails.

## Scope

Read-only on the codebase. Write only the output JSON. Do not modify the deck, the skill, or any
other file.
