# Verse-Vault Scheduling

How the system decides what to show the learner and when.

## Computing what's due

Each directed edge stores S, D, and last_review_time. Retrievability is computed on demand:

```
R = (1 + t / (9 · S))^(-1)
```

An edge is **due** when R drops below the target retention (default 0.9). Equivalently, when
elapsed time exceeds the edge's interval:

```
interval = S × (target_R^(-1) - 1) × 9
due when: elapsed > interval
```

No precomputed due dates are stored. Computing R for all ~10,000 edges in a season is
sub-millisecond and avoids stale values — important because each review updates many edges
simultaneously.

## Surface selection

The scheduler dynamically generates the best surface for the current graph state. Surfaces are
not chosen from a fixed menu — they are constructed from the mask that maximizes reinforcement
where it is most needed.

### Simple scheduler (recommended for v1)

1. Compute R for all edges in the learner's active verse set.
2. Find the edge with the lowest R below target.
3. Identify which verse it belongs to.
4. Count how many edges in that verse are due.
5. Pick the surface:

| Condition                    | Surface                          |
| ---------------------------- | -------------------------------- |
| Most edges due               | Full recitation (ref → verse)    |
| 1–2 edges due                | Fill-in-the-blank targeting them |
| Only ref-related edges due   | Verse → ref                      |
| Cross-verse edge due         | Cross-verse continuation         |
| Only reverse edges due       | Appropriate reverse surface      |

This is O(edges) per decision — find the weakest, pick the obvious surface.

### Full scoring scheduler (future optimization)

Score every candidate (verse, surface) pair:

```
score(verse, surface) = Σ  credit_potential(edge, surface) × need(edge)
                       edges

where need(edge) = max(0, target_R - current_R)
```

`credit_potential(edge, surface)` is the credit weight the edge would receive under this surface,
derived from the path analysis described in the memory model. The surface that delivers the most
reinforcement to the most needed edges wins.

For N=4 phrases, each verse has ~7 candidate surfaces (full recitation, fill-in-blank for each
phrase, reverse recall, first-words-to-rest). Scoring 7 surfaces × 20 edges = 140 multiply-adds
per verse. Across 100 due verses: 14,000 operations. Sub-millisecond.

## Session building

### Fixed-size sessions

Sessions are defined by count or time, not by "drain everything due":

* "Give me 20 reviews"
* "I have 15 minutes"

Each review is heavier than an Anki card (type a verse, grade multiple phrases), so sessions are
fewer reviews but richer signal per review.

### Building the session

1. Score all (verse, surface) pairs using the scheduler.
2. Sort by score descending.
3. Take the top N for the session.
4. Store the session as an ordered list.

### Ordering: easy first

When many edges are due (e.g., returning after a break), order by **easiest verse first**. The
verse whose weakest edge has the highest R comes first.

Equivalently: sort verses by the most-recently-due edge descending. Edges that just became due are
barely below target (easy). Edges due weeks ago are far below target (hard). No R computation
needed for ordering — due date is the sort key.

Easy-first ordering:
* Builds confidence and momentum
* Clears quick reviews first
* Matches Anki's established pattern

### Within-session adaptation

After each review, check whether the next planned item's target edges are still due. If a previous
review reinforced them above threshold (via credit assignment on shared edges), skip to the next
item. This avoids wasted reviews without requiring full session recomputation.

## New verse introduction

* Do not introduce new verses until the daily review target is met.
* Limit to 1–3 new verses per session to avoid overwhelming the learner.
* A new verse's first review should be full recitation (ref → verse) to establish all forward edges
  at initial stability.
* All edges in a new verse start at initial S from FSRS parameters (w[0]..w[3] keyed on first
  grade) and initial D from w[4]..w[5].

## Lapse re-drilling

When a phrase lapses (graded Again) during a review:

1. Complete the current review (grade all phrases).
2. The lapsed edge's S drops via FSRS post-lapse formula.
3. Queue a fill-in-the-blank surface targeting that edge later in the current session.
4. Insert it after 2–3 intervening reviews (within-session spacing).
5. On success: S starts recovering. On repeated failure: queue another re-drill with a longer gap.

## Multiple sessions per day

If the learner does multiple sessions in one day, recompute the session fresh at each session
start. The computation is cheap enough that there is no reason to cache sessions across sittings.

## Precomputation tradeoffs

Anki precomputes and stores due dates because each review updates exactly one card. Verse-vault
updates ~20 edges per review, so precomputing due dates would mean ~20 writes per review instead
of ~5 directly graded edges. Computing R on the fly is both cheaper and simpler:

* Fewer writes per review
* No stale precomputed values
* Instantly correct if the learner changes target retention
* Simpler schema: three values per edge (S, D, last_review_time)
