# Data Model: Proofread Recitation Diff

Nothing is stored. Every value below is derived on the card back from the typed answer and the
expected text, and discarded on the next card.

## Diff item (existing)

Produced by `wordDiff` in `apps/web/src/lib/diff/wordDiff.ts`. Its output shape is unchanged; only
which equally good match it picks changes, preferring the earliest typed occurrence as it already
prefers the earliest expected one (FR-014, research R11).

| Field  | Meaning                                                                                        |
| ------ | ---------------------------------------------------------------------------------------------- |
| `kind` | `match`, `missing` (expected, not typed), or `extra` (typed, not expected)                     |
| `raw`  | The token as written; for `match`, the expected side's token, so it follows the verse (FR-003) |

Items come in an order consistent with both the expected text and the typed answer.

## Edit

A maximal run of consecutive non-match items, as one unit (spec Key Entities).

| Kind      | Typed words | Expected words | Shown as                                            |
| --------- | ----------- | -------------- | --------------------------------------------------- |
| `replace` | one or more | one or more    | typed words struck, expected words in a label above |
| `add`     | one or more | none           | typed words struck, no label                        |
| `skip`    | none        | one or more    | caret, expected words in a label above              |

Between edits are runs of matched words. A prose answer is therefore an alternating sequence of
match runs and edits.

**Validation rules**

* A match run of at most two words, each at most four letters after normalization, that sits between
  two edits is folded into one `replace`: its words join both the typed and the expected side
  (FR-010). Runs at the start or end of the answer are never folded.
* Merging applies to prose cards only.

## Match measures

| Measure   | Definition                     | Used for                                  |
| --------- | ------------------------------ | ----------------------------------------- |
| Recall    | matched words / expected words | fallback decision, and the "N of M" count |
| Precision | matched words / typed words    | fallback decision                         |

Counted on the diff before merging, so folded glue words still count as matched.

**State**: proofread view by default; wrong-verse fallback when recall < 0.5 AND precision < 0.5
(FR-011). Prose cards only. An empty typed answer never reaches this decision (FR-001).

## Club-list item order

Club-list answers use the diff items directly, one mark per number, with no edits, merging, or
fallback.

* Matched numbers keep diff order (ascending, since both sides are sorted).
* Within a run of consecutive non-match items, numbers are ordered ascending.
* A token that is not a number appears as typed, struck.
