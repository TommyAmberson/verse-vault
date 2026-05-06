# Scheduling

How the engine decides which card to review next. Per-test FSRS, no path enumeration, no
priority-score arithmetic. For the memory model see
[`path-posterior-memory-model.md`](path-posterior-memory-model.md); for the review pipeline that
produces the state this scheduler reads see [`review.md`](review.md). Element layer:
[`graph.md`](graph.md).

## What changed

The old design pre-computed a `due_date` and `priority` per card by binary searching the time at
which a path-enumerated effective retrievability would hit the target. That table lived in a "card
DB" alongside the edge memory state and was recomputed in a post-review cascade.

In the HSRS architecture there is no path enumeration and no card-level state. Each test carries its
own FSRS `(stability, difficulty)`, and the scheduler computes "is this card due?" on the fly by
reading those tests.

## The two questions

`schedule.rs` answers exactly two questions, both for a card and a moment in time `now_secs`:

1. **Is this card past its sibling cooldown?** (`is_in_cooldown`)
2. **What is the lowest predicted retrievability across this card's tests?** (`card_min_r`)

The scheduler picks the card with the lowest min-r among cards that are below the target and out of
cooldown. That is the entire policy.

## Per-test due time

A test's due time is closed-form — `FsrsBridge::due_at(state, target_r)` inverts the FSRS power
forgetting curve directly:

```
R = (1 + factor·t/S)^(-decay)
t = S · (R^(-1/decay) - 1) / factor
```

where `factor = exp(ln(0.9) / -decay) - 1`. No binary search. The result is a wall-clock timestamp
measured from `state.last_base_secs` (the HSRS-style base, which advances fully on direct review and
partially on propagated updates — see the canonical spec).

Predicting present-time retrievability is the symmetric call, `retrievability_of(state, now_secs)`.

## Card min-r

A card grades several tests at once (composite cards like `Recitation`, `Citation`, `Ftv`,
`Holistic`; atomic cards like `PhraseFill` or `VerseInChapter` grade exactly one). The card's
effective retrievability is the minimum across its tests — the weakest link decides whether the card
is overdue:

```rust
fn card_min_r(card, now_secs) -> Option<f32> {
    card.tests(atoms)
        .iter()
        .filter_map(|tk| tests.get(tk).map(|s| fsrs.retrievability_of(s, now_secs)))
        .min()
}
```

If any of a Recitation card's phrase tests has decayed past the target, the whole Recitation
surfaces.

A card is **due** when `card_min_r < schedule_params.target_retention`. The default target is `0.9`,
matching the FSRS-6 default desired retention.

## Sibling cooldown

Cards on the same verse overlap heavily — a Recitation grades every phrase directly, then
propagation lifts the verse-binding tests. A PhraseFill on the same verse has a propagation-touched
test even if it hasn't been reviewed itself. Showing both in quick succession is wasted effort.

`is_in_cooldown(card_id, now_secs)` returns `true` if any test this card grades has
`now_secs - last_seen_secs < schedule_params.sibling_cooldown_secs` (default 30 minutes). The
scheduler filters those out. `last_seen_secs` is advanced by both direct and propagated updates, so
cooldown captures both forms of recent activity.

## next_card

```rust
pub fn next_card(engine: &ReviewEngine, now_secs: i64) -> Option<CardId> {
    engine.cards.iter()
        .filter(|c| !engine.is_in_cooldown(c.id, now_secs))
        .filter_map(|c| Some((c.id, engine.card_min_r(c, now_secs)?)))
        .filter(|(_, r)| *r < engine.schedule_params.target_retention)
        .min_by(|(_, a), (_, b)| a.partial_cmp(b).unwrap())
        .map(|(id, _)| id)
}
```

Linear scan over the card list. At the few-thousand-card scale this engine is designed for, the scan
is well under a millisecond and avoids the write-amplification of maintaining a cached priority
queue.

`next_card` returns `None` when nothing is both due and out of cooldown — the session loop
interprets that as "you're caught up".

## Sessions

Within-session behaviour (composite-card re-drilling, progressive reveal of new verses, FTV cards)
lives in [`session.md`](session.md) and `crates/core/src/session.rs`. The scheduler proper is
stateless across sessions; the session layer adds short-lived in-memory queueing on top.

## ScheduleParams

```rust
pub struct ScheduleParams {
    pub target_retention: f32,        // default 0.9
    pub sibling_cooldown_secs: i64,   // default 30 * 60
}
```

`target_retention` is also fed into `FsrsBridge::desired_retention` so that `due_at` answers _"when
will this hit the target the scheduler is using?"_ without an extra plumbing argument.

## What this gives up vs. the old design

The old priority score combined a "cost of delay" (how much momentum is about to be lost) with a
"review cost" exponent and a reinforcement bonus for cards whose shown-side covers other due edges.
None of that is implemented here — the new scheduler picks the most-overdue card and stops.

That is sufficient because:

* Composite cards naturally cover many tests in one review.
* Sibling cooldown prevents pile-ups on overlapping cards.
* Propagation lifts related tests as a side effect of the chosen review, so "double duty" is a
  property of the model, not a scoring term.

If session-level optimisation becomes worth the complexity later, it lives on top of `next_card`,
not in place of it.
