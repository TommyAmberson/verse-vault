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
measured from `state.last_base_secs` (the HSRS-style base, which advances fully on a root update
from an atomic-card review and partially on sub-updates from a composite-card review — see the
canonical spec).

Predicting present-time retrievability is the symmetric call, `retrievability_of(state, now_secs)`.

## Card min-r

A card touches several tests at once (composite cards like `Recitation`, `Citation`, `Ftv`; atomic
cards like `PhraseFill` or `VerseInChapter` touch exactly one). The card's effective retrievability
is the minimum across its tests — the weakest link decides whether the card is overdue:

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

Cards on the same verse overlap heavily — a Recitation contains every phrase plus the citation
triple, so reviewing it touches all of those tests in one go. Following up immediately with a
PhraseFill that grades a phrase the Recitation just touched is wasted effort.

`is_in_cooldown(card_id, now_secs)` returns `true` if any test this card touches has
`now_secs - last_seen_secs < schedule_params.sibling_cooldown_secs` (default 30 minutes). The
scheduler filters those out. `last_seen_secs` is advanced by every update — root or sub — so
cooldown captures any recent activity on the test, regardless of which card drove it.

Every review surface honours the cooldown (#107): `next_card` filters masked cards, the due counts
(`due_review_count`, `due_verse_count`) exclude them so the "N to review" badge never advertises
reviews the session refuses to serve, and the relearning lane applies a per-test coldness gate (see
below).

## Relearning lane

`next_relearn_card` runs before `next_card` in the session's pick order. It surfaces any `Active`
card with a test that (a) has `pending_relearn = true` (sticky after an Again grade), (b) is past
its FSRS-computed due time, and (c) was last touched longer than the sibling cooldown ago.

Condition (c) is a **per-test** coldness gate, not the card-level `is_in_cooldown` check. Grading
Again advances `last_seen_secs` on every marked test, so without the gate the lane re-serves the
just-lapsed card (or a sibling sharing the test) seconds later — the learner just saw the answer, so
the re-drill teaches nothing (#107 A/B). Gating on the test's own last touch still lets a cold lapse
surface when its card is cooldown-masked via some _other_ shared test — the lane's designed purpose.

Ties break by earliest due time: the lapse the learner has been kept waiting longest clears first.

## next_card

`next_card` and the two due-count queries (`due_review_count`, `due_verse_count`) all draw from one
eligibility predicate — `eligible_due_cards` — so the "N to review" badge can never advertise a card
the session then refuses to serve (#107 C). Each card is `Active`, out of sibling cooldown, and
below its verse's target retention:

```rust
fn eligible_due_cards(engine: &ReviewEngine, now_secs: i64) -> impl Iterator<Item = (&Card, f32)> {
    engine.cards.iter()
        .filter(move |c| matches!(c.state, CardState::Active))
        .filter(move |c| !engine.is_card_in_cooldown(c, now_secs))
        .filter_map(move |c| Some((c, engine.card_min_r(c, now_secs)?)))
        .filter(move |(c, r)| *r < engine.target_r_for_verse(c.verse_id))
}

pub fn next_card(engine: &ReviewEngine, now_secs: i64) -> Option<CardId> {
    eligible_due_cards(engine, now_secs)
        .max_by(|(_, a), (_, b)| a.partial_cmp(b).unwrap())
        .map(|(c, _)| c.id)
}
```

Descending-R pick order (highest retrievability first) follows the FSRS-author recommendation for
capacity-limited sessions — see the docstring on `next_card` for the rationale.

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
None of that is implemented here — the new scheduler picks a due card (highest-R first) and stops.

That is sufficient because:

* Composite cards naturally cover many tests in one review — a Recitation distributes one grade
  across every phrase plus the citation triple via the engine's Bayesian-share decomposition.
* Sibling cooldown prevents pile-ups on overlapping cards.
* "Double duty" is a property of card containment, not a scoring term: cross-test influence flows
  only through cards that explicitly contain the affected tests.

If session-level optimisation becomes worth the complexity later, it lives on top of `next_card`,
not in place of it.
