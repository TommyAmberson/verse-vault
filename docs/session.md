# Sessions

How within-session flow works: re-drills after lapses, progressive reveal for new verses. Memory
state lives entirely on the engine's per-test `TestState` table — see [`review.md`](review.md) for
the review pipeline and [`scheduling.md`](scheduling.md) for card selection.

## Design principle

The session is a **queue manager, not a memory tracker**. Every memory update is the engine's job: a
single grade per card flows through `ReviewEngine::review`, which decomposes it across the card's
contained tests via HSRS's Bayesian-share weights. The session decides ordering and when to insert
re-drills — nothing more.

Sibling cooldown is enforced by the engine: `engine.review` advances `last_seen_secs` on every test
it touches, and `schedule::next_card` filters cards whose tests are still inside the cooldown
window. The session does not keep a parallel timestamp map.

## Session API

```rust
let mut session = Session::start(&engine, now_secs);   // seeds the FTV queue

// One review:
session.stage_review(card.kind, card.verse_id);
let outcome = session.review_card(&mut engine, card_id, grade, now_secs);
match session.next_drill_after(grade) {
    Some(SessionAction::ReDrill { verse_id, kind }) => /* re-queue */,
    Some(SessionAction::NextScheduled) | None      => /* fall through to schedule::next_card */,
    Some(SessionAction::Done)                       => /* session over */,
}
```

`Session::next_card(&engine, now_secs)` is a thin wrapper around `schedule::next_card` for the
common case where the session has no priority entry to surface.

## Re-drill on Again

Under a single grade per card, the session has no per-phrase signal — it can't tell which phrase of
a Recitation the learner blanked on. The only sensible recovery is to re-queue the same card later
in the session and let the engine's normal cooldown + scheduling handle the timing:

```rust
pub enum ReDrillKind {
    SameCard { kind: CardKind },
}
```

`next_drill_after(grade)` returns `Some(SessionAction::ReDrill { SameCard })` on `Grade::Again` and
`None` otherwise. The earlier "fill-in-blank vs. full-recitation" branching depended on per-phrase
grades the new pipeline doesn't produce; it has been removed.

## Progressive reveal (new verses)

`Session::new_verse_progression(verse_id, phrase_count)` returns the staged sequence used to
introduce a new verse:

```
[ Reading, PhraseFill 0, ..., PhraseFill N-1, Recitation ]
```

* **Reading** — has no contained tests; the engine treats it as a no-op review. The frontend uses it
  to display the full verse.
* **PhraseFill 0..N-1** — atomic cards, one per phrase position. Each one is a vanilla FSRS step on
  `PhraseFromContext` for that phrase.
* **Recitation** — composite card containing every phrase plus the citation triple
  (`VerseRefPosition`, `VerseChapter`, `VerseBook`). One grade decomposes across all of them via the
  engine's Bayesian-share weights.

The progression is just a list of `CardKind`s; the session walks it in order, gating advancement
through the same `next_drill_after` machinery any other review uses.

## FTV priority queue

`Session::start` seeds an `upcoming_cards` queue with every `Ftv` card the engine emitted (one per
eligible verse, with and without citation, depending on configuration). FTV is the highest- priority
surface in normal operation; the session is expected to drain that queue before falling back to
`schedule::next_card`. This lets the scheduler ignore FTV altogether — its retrievability is tracked
the same way as any other card, but the surfacing decision is queue-driven.

## Parameters

There are no session-level parameters under the current design. Cooldowns and target retention live
on the engine (`ScheduleParams`); FSRS parameters live on `FsrsBridge`. The session is entirely a
queueing layer on top.
