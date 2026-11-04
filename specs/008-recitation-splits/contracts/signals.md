# Contract: Audit Signals

The audit report (`tools/evaluate_phrases.py --out`) and the rendered splitter, rater and selector
prompts share these names. The splitter, rater and selector agent instructions refer to them by
name, so a rename is a prompt change.

All scores are floats in `[0, 1]`; higher means more worth a look. Signals are context for a person
or an LLM, not rules.

## Per phrase (`signals.phrases[]`)

| Name                         | Type                    | Meaning                                                                                                                                                                                                                  |
| ---------------------------- | ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `text`                       | string                  | The phrase's tokens joined by spaces                                                                                                                                                                                     |
| `word_count`                 | int                     | Tokens in the phrase                                                                                                                                                                                                     |
| `position`                   | string                  | `first`, `middle`, `last` or `only`                                                                                                                                                                                      |
| `starts_with_weak_connector` | bool                    | First word is a coordinating or relative connector                                                                                                                                                                       |
| `ends_in_pause_punct`        | bool                    | Last token ends in `,` `;` `:` or `—`                                                                                                                                                                                    |
| `contains_internal_pause`    | bool                    | An internal token ends in pause punctuation                                                                                                                                                                              |
| `ends_mid_clause`            | bool                    | Last token ends without pause or terminal punctuation                                                                                                                                                                    |
| `pause_points`               | list of `{index, kind}` | Token indexes (within the phrase) where a cut could go; `kind` is `punct`, `relative`, `content_clause`, `line_break`, `list` or `parse`, or one of the weak cues `coordinator` and `preposition` (after a content word) |
| `long_run`                   | float                   | How far the phrase runs past one recitation run, scaled down when it has no pause point                                                                                                                                  |
| `lost_line_break`            | bool                    | Contains a capitalized line-initial function word mid-phrase (NKJV poetry)                                                                                                                                               |

## Per boundary (`signals.boundaries[]`, one between each pair of phrases)

| Name                 | Type           | Meaning                                                                            |
| -------------------- | -------------- | ---------------------------------------------------------------------------------- |
| `boundary_severance` | float          | Cut at a `verb_content`, `bare_relative` or `stranded_stub` cue inside a short run |
| `severance_kind`     | string or null | Which cue fired                                                                    |
| `no_pause_cue`       | float          | Cut with no punctuation before it and no clause edge after it                      |

## Per verse (`signals`)

| Name                 | Type                     | Meaning                                                                                                                                             |
| -------------------- | ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `token_count`        | int                      | Canonical tokens in the verse                                                                                                                       |
| `phrase_count`       | int                      | Phrases in the split                                                                                                                                |
| `missing_split`      | float                    | Single-phrase verse long enough to hold more than one run                                                                                           |
| `parallel_asymmetry` | float                    | Parallel halves cut differently (one split, its mirror whole)                                                                                       |
| `list_breaks`        | list of `{kind, phrase}` | `word_list_cut` (short word list split internally), `lead_in_merged` (standalone lead-in shares a phrase with its word list), `clause_items_merged` |
| `parse`              | string                   | `spacy:<model>` when the parse signal ran, `skipped` otherwise                                                                                      |

## Composite

`signal_score` is a weighted sum of the maximum of each float signal, plus `missing_split`, clamped
to `[0, 1]`. The weight table has one owner (`phrase_splitter/features.py`); the audit's "top
signals" summary reads the same table. Weights are set by calibration against the reference set, so
the numbers are not part of this contract.
