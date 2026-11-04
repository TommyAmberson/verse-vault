# Contract: Propose, Rate, Select Files

The LLM steps run as Claude Code subagents that read and write JSON files. These shapes are what the
`split_phrases.py` subcommands emit and accept.

## Splitter reply (`proposals.json`)

```json
[{ "ref": "John 5:7", "candidates": [["The sick man answered Him,", "…"], ["…"]] }]
```

One to three candidates per verse, best first. The older `{ "ref", "phrases": [...] }` shape is read
as one candidate.

## Candidate sets (`candidates.json`, written by the rating step)

```json
[{
  "ref": "John 5:7",
  "current": "c",
  "candidates": [{ "id": "a", "counts": [5, 17, 5, 5] }, { "id": "c", "counts": [5, 10, 6, 11] }]
}]
```

Every candidate is validated against the canonical words; invalid ones are reported and dropped, and
identical splits (including the current one) share one id. Ids are assigned in an order that does
not reveal which is current.

## Rating prompts and replies

Prompts: `[{ "ref", "id", "prompt" }]`, one per candidate, written in batches that never hold two
candidates of the same verse, so a rater working through a batch can't compare them. Replies
(`ratings.json`):

```json
[{ "ref": "John 5:7", "id": "a", "score": 8, "pros": ["…"], "cons": ["…"] }]
```

`score` is an integer from 1 (breaks the criteria badly) to 10 (meets them fully).

## Selection prompts and replies

Prompts: `[{ "ref", "prompt" }]`, one per verse, showing every candidate's text and rating and which
is current; with the churn guard, the prompt tells the selector to keep the current split unless
another is clearly better. Replies (`choices.json`): `[{ "ref": "John 5:7", "choice": "a" }]`.

## Apply

`apply --candidates candidates.json --choices choices.json` writes the chosen split's counts for
every verse whose choice is not the current split.

## Bad replies

A rating with an unknown id, a score outside 1 to 10, or missing pros and cons, and a choice naming
an unknown id, are reported with their reference and skipped. Selection prompts are emitted only for
verses whose candidates are all rated; a verse with no valid choice is left unchanged.
