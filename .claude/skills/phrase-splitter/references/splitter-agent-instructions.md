# Splitter Subagent Instructions

You are generating memorisation phrase splits for Bible verses. This file is the entry point when a
subagent is dispatched for the re-split step of the phrase-splitter workflow.

## Inputs you will be given

* A **batch file path** — JSON array of `{ref, prompt}` entries. Each `prompt` already contains the
  full `SPLIT_PROMPT` (from `tools/phrase_splitter/prompts.py`) with the verse text inlined.
* An **output file path** — write your `{ref, phrases}` results here.

## Required reading (do this once at start)

* [`quality-criteria.md`](./quality-criteria.md) — what makes a split good or bad, with worked
  examples and the guiding principle (completeness of thought > size).

The embedded `prompt` field in each batch entry contains the active `SPLIT_PROMPT`, so you don't
need to read `prompts.py` separately. If anything in the embedded prompt conflicts with
`quality-criteria.md`, the prompt wins (it's the version actually shipped to production).

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

## Common pitfalls

* **Don't paraphrase.** Use the exact tokens from the embedded prompt (canonical api.bible NKJV).
* **Don't drop punctuation or smart quotes.** Curly `“ ” ‘ ’` and straight quotes are distinct
  bytes; copy them verbatim.
* **Don't split inside HTML tags.** `<b>asking</b>` is one indivisible unit.
* **Don't sever a verb from its content clause.** `"Do you not know"` /
  `"that we shall judge angels?"` is a _bad_ break — keep the rhetorical question whole.
* **Don't worry about a hard word-count cap.** Target 3–10 per phrase but the validator has no upper
  cap; a 14- or 18-word continuous clause is fine when there's no natural internal break.

## Scope

Read-only on the codebase. Write only the output JSON. Do not modify the deck, the skill, or any
other file.
