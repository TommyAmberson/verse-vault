# Data Model: Recitation-Based Phrase Splits

No app data changes. The deck files (`data/<N>-<book>.json`) and their `phraseWordCounts` keep their
shape and are not modified by this feature (FR-016).

## Reference verse

One entry in the committed reference set (see
[contracts/reference-set.md](contracts/reference-set.md)).

| Field        | Meaning                                                                                        |
| ------------ | ---------------------------------------------------------------------------------------------- |
| `ref`        | Verse reference in deck form, e.g. `John 5:7`                                                  |
| `deck`       | Deck path relative to the repository root, e.g. `data/4-john.json`                             |
| `agreed`     | `phraseWordCounts` of the split the maintainer agreed                                          |
| `confidence` | `agreed`, `weak` or `unresolved`                                                               |
| `note`       | Optional: why, in a sentence (e.g. "parallel halves stay whole")                               |
| `rejected`   | Optional list of `phraseWordCounts` the maintainer rejected for this verse, each with a reason |

Validation:

* `agreed` and every `rejected` entry sum to the verse's canonical token count.
* No `rejected` entry equals `agreed`.
* `ref` is unique within the set.
* An `unresolved` entry is excluded from calibration scores but still validated.

Derived state used by calibration: _kept_ when `agreed` equals the deck's current counts, _changed_
otherwise.

## Signals

Signals stay in the existing audit payload (`signals.phrases[]`, `signals.boundaries[]`, verse
level). They are part of the prompt contract, so names are fixed in
[contracts/signals.md](contracts/signals.md).

Removed: `word_overload`, `cognitive_overload`, `stub_phrase`, `content_word_count`,
`function_ratio`, `verse_function_ratio`, `syllable_count`, `length_balance` (meaning-load and
merge-pressure signals with no role under the recitation criteria; `syllable_count` and the
function-ratio fields have no reader once the composite drops them).

Kept: `word_count`, `starts_with_weak_connector`, `ends_in_pause_punct`, `contains_internal_pause`,
`ends_mid_clause`, `position`, `text`, `missing_split`, and the boundary `boundary_severance` with
`severance_kind` (now length-gated, R4).

Added, per phrase: `pause_points` (list of `{index, kind}`), `long_run`, `lost_line_break`. Per
boundary: `no_pause_cue`. Per verse: `parallel_asymmetry`, `list_breaks` (list of `{kind, phrase}`),
and `parse` (`"spacy:<model>"` or `"skipped"`).

## Calibration result

Per reference verse: `ref`, `state` (`changed` or `kept`), `flagged` (score at or above the
threshold), `score`, `fired` (names of signals above zero), and `ok` (flagged when changed, quiet
when kept). Overall: counts of changed-caught, changed-missed, kept-quiet, kept-flagged, and the
excluded unresolved entries.

## Candidate sets, ratings and choices

The propose, rate and select steps exchange JSON files whose shapes are fixed in
[contracts/pipeline-files.md](contracts/pipeline-files.md): candidate sets per verse (ids and word
counts, which one is current), one rating per candidate (score 1 to 10, pros, cons), and one choice
per verse.
