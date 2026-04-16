# Scheduling

How the system decides what to show the learner and when. Depends on the graph structure
([graph.md](graph.md)) and review model ([review.md](review.md)).

## What's due

An edge is due when its retrievability drops below target retention (default 0.9):

```
R = (1 + t / (9 · S))^(-1)
due when: R < target_retention
```

No precomputed due dates. Computing R for all ~11,000 edges in a season is sub-millisecond.
Each review updates many edges simultaneously, so precomputing would mean extra writes without
saving meaningful computation.

## Surface selection

The scheduler dynamically generates the best surface for the current graph state.

### Simple scheduler (v1)

1. Compute R for all edges.
2. Find the edge with the lowest R below target.
3. Identify which verse it belongs to.
4. Count how many of that verse's edges are due.
5. Pick the surface:

| Condition                  | Surface                          |
| -------------------------- | -------------------------------- |
| Most edges due              | Full recitation (ref → verse)    |
| 1–2 edges due               | Fill-in-the-blank targeting them |
| Only ref-related edges due | Verse → ref                      |
| Cross-verse edge due        | Cross-verse continuation         |
| Club edges due              | Club listing                     |

O(edges) per decision.

### Full scoring scheduler (future)

Score every candidate (verse, surface) pair:

```
score(verse, surface) = Σ  credit_potential(edge, surface) × max(0, target_R - R(edge))
                       edges
```

`credit_potential` is the credit weight the edge would receive under this surface, from the path
analysis in [review.md](review.md). The surface delivering the most reinforcement where it's
most needed wins.

~7 candidate surfaces per verse × ~27 edges = ~190 multiply-adds per verse. Across 100 due
verses: ~19,000 operations. Sub-millisecond.

For ref-targeting surfaces, the scheduler must account for anchor transfer when computing
effective R — a ref with weak direct recall but strong nearby anchors may not actually need
drilling.

## Sessions

### Fixed-size sessions

Defined by count or time, not "drain everything due":
* "Give me 20 reviews"
* "I have 15 minutes"

Each review is heavier than an Anki card (type a verse, grade multiple phrases), so sessions
have fewer reviews but richer signal.

### Building a session

1. Score all (verse, surface) pairs.
2. Sort by score descending.
3. Take the top N.
4. Store as an ordered list.

### Ordering: easy first

When many edges are due (returning after a break), order **easiest verse first** — the verse
whose weakest edge has the highest R comes first. Equivalently, sort by most-recently-due edge
descending (barely overdue = easy).

* Builds confidence and momentum
* Clears quick reviews first

### Within-session adaptation

After each review, check whether the next planned item's target edges are still due. If the
previous review reinforced them above threshold via credit assignment, skip to the next item.

## New verse introduction

* Do not introduce new verses until the daily review target is met.
* Limit to 1–3 new verses per session.
* First review should be full recitation (ref → verse) to establish all forward edges.
* All edges start at initial S from FSRS parameters.

## Multiple sessions per day

Recompute fresh at each session start. Cheap enough that caching is unnecessary.

## Phrase boundaries

Phrases define where the edges go inside a verse.

**Default**: AI-generated boundaries. KJV and other translations have consistent clause structure
(commas, semicolons, conjunctions) that LLMs segment reliably. One-time pipeline per translation.

**Override**: editable per verse, per user or per editor.
