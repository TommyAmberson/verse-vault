# Review pipeline

How a graded card turns into per-test FSRS updates. For the memory model behind these updates see
[`path-posterior-memory-model.md`](path-posterior-memory-model.md); for the verse-element substrate
see [`graph.md`](graph.md); for what the scheduler does with the resulting state see
[`scheduling.md`](scheduling.md).

## The shape of a review

Every card carries one grade. `ReviewEngine::review(card_id, grade, now_secs)` is the single entry
point and returns a `ReviewOutcome` listing every test it touched, tagged `Root` or `Sub`.

Atomic cards (one contained test) act like vanilla FSRS — the grade is applied as a full FSRS step
to that one test, advancing all three timestamps. Composite cards (multiple contained tests, e.g.
`Recitation`) distribute the same grade across their contained tests via HSRS's Bayesian-share
weight `(1 − p_i) / (1 − p_total)`. This is the same decomposition HSRS's `getLearningCardDiff`
performs to spread one user grade across an "observation" of multiple memory elements.

The pipeline is small enough to state in full:

1. Look up the card and its `VerseAtoms`.
2. Compute `tests = card.tests(atoms)`.
3. **Empty** (`Reading`) — return `ReviewOutcome::default()`.
4. **One test** (atomic) — `update(state, grade, weight=1.0, is_root=true, now)` and emit one `Root`
   `TestUpdate`.
5. **Multiple tests** (composite) — for each contained test, compute its retrievability `p_i` at
   `now`; let `p_total = ∏ p_i`; let `weight = (1 − p_i) / (1 − p_total)` (clamped, with
   `p_total ≈ 1` collapsing to weight 0); apply `update(state, grade, weight, is_root=false, now)`
   and emit a `Sub` `TestUpdate`.

There is no propagation set, no fan-out to "related" tests, no edge gamma. Every cross-test
influence comes from a card explicitly containing those tests.

## The unified update primitive

`FsrsBridge::update(state, grade, weight, is_root, now_secs)` is the single update entry point.

* `weight = 1.0`, `is_root = true` — full FSRS-6 transition. All three timestamps advance to `now`.
  This is what an atomic card's review uses.
* `weight < 1.0`, `is_root = false` — HSRS-style sub-update. Stability and difficulty interpolate
  between the current state and the hypothetical post-FSRS-step state by `weight`; `last_base_secs`
  interpolates the same way; `last_seen_secs` advances to `now`; `last_root_secs` is preserved. This
  is what each contained test of a composite card uses.

The "never advance `last_root_secs` on a sub-update" invariant is load-bearing: it stops
composite-card sub-updates from impersonating an atomic-card root review to the scheduler. A test
that has only ever been touched via composite-card sub-updates carries a `last_root_secs` from its
seed value, marking it as never having been directly grilled in isolation.

## Cards contain tests

`Card::tests(&atoms)` is a pure routing function: same card + atoms always yields the same set.
Atomic cards return a 1-element vec; composites return their contained tests:

| Card kind               | Tests contained                                                                     | Atomic? |
| ----------------------- | ----------------------------------------------------------------------------------- | ------- |
| `PhraseFill { p }`      | 1 — `PhraseFromContext` at phrase `p`                                               | yes     |
| `VerseAtVerseRef`       | 1 — `VerseRefPosition` binding                                                      | yes     |
| `VerseInChapter`        | 1 — `VerseChapter` binding                                                          | yes     |
| `VerseInBook`           | 1 — `VerseBook` binding                                                             | yes     |
| `VerseInHeading { h }`  | 1 — `VerseHeading` binding                                                          | yes     |
| `VerseInClub { tier }`  | 1 — `VerseClub` binding                                                             | yes     |
| `Recitation`            | N phrases (`PhraseFromContext`) + `VerseRefPosition` + `VerseChapter` + `VerseBook` | no      |
| `Citation`              | 3 — `VerseRefPosition`, `VerseChapter`, `VerseBook`                                 | no      |
| `Ftv { with_citation }` | phrases-after-FTV-prefix (`PhraseFromContext`) [+ citation triple]                  | no      |
| `Reading`               | 0 — UX-only progressive-reveal card, never persisted                                | n/a     |

Recitation is the "say it all" card; it now contains everything the old `Holistic` did. There is no
separate Holistic kind in the new model.

## Bayesian share, in one paragraph

Suppose a Recitation contains 4 phrase tests and the citation triple. At review time each contained
test has some predicted retrievability `p_i`. The joint probability of the entire observation (every
contained test passing) is `p_total = ∏ p_i`. The Bayesian share for test `i` is

```
weight_i = (1 − p_i) / (1 − p_total)
```

— the probability mass on test `i` failing, divided by the probability mass on the joint observation
failing. Tests whose pass was most surprising (low `p_i`) get the largest share; tests whose pass
was already expected get a small share. The shares lie in `[0, 1]` and the engine clamps to that
range. When `p_total ≈ 1` the formula's denominator collapses; the engine treats that case as
`weight = 0` (every test was certain to pass anyway, so there's no surprise to credit).

This is exactly HSRS's `(1 - successProb) / (1 - totalSuccessProb)` in `getLearningCardDiff`,
applied to the contents of the card the user just graded rather than to a flattened tree of related
items.

## Re-drills

A re-drill is a session-layer concept. The session stages each card through `stage_review` and calls
`next_drill_after(grade)`. Under the single-grade pipeline that's a simple rule: any `Again`
re-queues the same card later in the session (`ReDrillKind::SameCard { kind }`); anything else
returns `None`. The old "majority-of-phrases failed → FullRecitation; one phrase failed →
FillInBlank" branching is gone — it depended on per-phrase grades that the new pipeline doesn't
have.

## Out-of-app practice

The HSRS model accepts that learners practise outside the app. Because state is per-test rather than
tied to a specific path through a graph, an unexpectedly-strong review just produces a normal FSRS
update — no history-trace consistency check rejects it.
