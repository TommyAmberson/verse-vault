# Data Model: Memorize by Schedule

**Date**: 2026-09-24 | **Plan**: [plan.md](./plan.md)

No persisted data changes. Everything here is computed per call inside `crates/core` from the
engine, the bound schedule and `now_secs`.

## Placement (per un-memorized verse)

Every un-memorized verse whose own club has memorize enabled gets exactly one placement:

| Placement        | Meaning                                                                               | Counted by `memorize_debt` | Served by the queue                        |
| ---------------- | ------------------------------------------------------------------------------------- | -------------------------- | ------------------------------------------ |
| `Owed { week }`  | First assigned in `week`, which has started; no week when there is no usable schedule | yes                        | first                                      |
| `Ahead { week }` | First assigned in `week`, which has not started                                       | no                         | after every owed verse, nearest week first |
| `Unscheduled`    | The schedule assigns it in no week under an enabled club                              | no                         | last                                       |

A verse is "assigned" by a week when the week's row lists its `(book, chapter, verse)` under any
enabled club, including Full's range derived from the passage minus the listed Club 150 and 300
verses. This is the union rule `memorize_debt` already uses, so a verse the schedule files under a
different club than its deck tag still counts, as long as its own club is enabled.

**State rules**

* No usable schedule (none bound, or one that assigns the deck nothing under an enabled club): every
  verse is `Owed` with no week, so `memorize_debt` counts them all (FR-010).
* Schedule, season not started: no verse is `Owed`; `memorize_debt` is zero (FR-011).
* Schedule, season ended: the final week is current, so every scheduled verse is `Owed`.
* Memorizing a verse removes it from every placement: it is no longer un-memorized.

## Club rank (per enabled club)

`rank(club)` = the number of unmet cross-club gates on the chain from the top enabled club down to
`club`, evaluated with the existing gate conditions. The top enabled club has rank 0. Disabled clubs
have no rank and contribute no verses.

## Queue order

The batch takes up to `batch_size` verses (firm limit, FR-008) from the first of these buckets that
has any, and never mixes buckets (FR-004): while anything is owed it holds only owed verses, even
when fewer than `batch_size`.

1. `Owed`, sorted by (rank, verse id). Then each club on calendar cascade reorders its own owed
   verses in the places they already hold: those first assigned in the current week before the rest.
   Other clubs' verses keep their places.
2. `Ahead`, sorted by (week, rank, verse id).
3. `Unscheduled`, sorted by (rank, verse id).

Each chosen verse maps to its anchor card as today (`anchor_card_for_verse`).

## `MemorizeDebt`

Unchanged shape `{ verses, cards }`: `verses` is the number of `Owed` verses, `cards` the `New`
cards those verses carry.
