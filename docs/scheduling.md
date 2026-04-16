# Scheduling

How the system decides what to show the learner and when. Depends on the graph structure
([graph.md](graph.md)) and review model ([review.md](review.md)).

## Architecture

Scheduling uses two database layers:

```
Edge DB (memory):      edge_id, S, D, last_review_time
Card DB (cards):    card_id, shown_atoms, hidden_atoms, effective_R, due_date
Edge→Card mapping:  edge_id → [card_ids that depend on this edge]
```

The **edge DB** tracks memory state. The **card DB** tracks scheduling state. Scheduling is
a simple query on the card DB — no graph computation at schedule time.

## Card catalog

Each verse has ~10 candidate cards. Each chapter has ~5–10. Total: ~5,200 card records
for a 500-verse season.

Per verse (N=4 phrases):

| Card              | Shown                | Hidden              |
| -------------------- | -------------------- | ------------------- |
| full recitation      | {ref}                | {p1, p2, p3, p4}   |
| fill-in-blank (×N)   | {ref, other phrases} | {one phrase}        |
| first words → rest   | {p1}                 | {p2, p3, p4}       |
| verse → ref          | {p1, p2, p3, p4}    | {ref}               |
| verse → heading      | {ref} or {phrases}   | {heading}           |
| cross-verse          | {prev last phrase}   | {p1, p2, p3, p4}   |

Per chapter:

| Card              | Shown                | Hidden              |
| -------------------- | -------------------- | ------------------- |
| club 150 listing     | {chapter_gist}       | {150 verse refs}    |
| club 300 listing     | {chapter_gist}       | {300 verse refs}    |
| heading → next       | {heading}            | {next heading}      |
| heading → prev       | {heading}            | {prev heading}      |

## Computing effective_R

For each card, effective_R is the probability the learner can recall ALL hidden atoms from
the shown atoms. Computed from the graph using path enumeration (see [review.md](review.md)):

```
For each hidden atom h:
  R_eff(h) = parallel composition over all paths from shown atoms to h (up to 5 hops)
  
effective_R(card) = Π R_eff(h) for all hidden atoms h
```

The product represents: the card "succeeds" only if ALL hidden atoms are recalled.

For cards where the hidden atom is a reference, anchor transfer applies (see
[review.md](review.md)).

## Computing due_date

R_effective(t) is a deterministic, monotonically decreasing function of time (as edge R values
decay). The due_date is when it crosses target_retention. Solved exactly via binary search:

```
low = now
high = now + 365 days
while high - low > 1 hour:
    mid = (low + high) / 2
    if R_effective_at(mid) > target_retention:
        low = mid
    else:
        high = mid
due_date = high
```

Computing R_effective_at(t) = evaluate the path enumeration with each edge's R projected to
time t: `R_edge(t) = (1 + (t - last_review) / (9 · S))^(-1)`.

Cost: ~20 iterations × ~120 ops = ~2,400 ops per card. Sub-millisecond.

## Post-review cascade

After each review:

1. **Credit assignment** updates edges in the edge DB (new S, D, last_review_time).
2. **Find affected cards** via the edge→card mapping. Most edges are within one verse,
   so ~10 cards are affected. Cross-verse edges add ~20 more. Typically ~30 cards total.
3. **Recompute effective_R and due_date** for each affected card using the updated edge
   values and binary search.
4. **Write** updated effective_R and due_date to the card DB.

Cost: ~30 cards × ~2,400 ops = ~72,000 ops. Sub-millisecond. The cascade runs as part of
the review completion — no background job needed.

## Picking the next review

Scheduling is a database query:

```sql
SELECT * FROM cards
WHERE due_date <= now
ORDER BY due_date ASC    -- easy first (barely overdue = easy)
LIMIT N                  -- session size
```

Easy-first ordering builds confidence and momentum when returning after a break. Barely
overdue cards (highest R among due items) come first.

No graph computation at schedule time. The expensive work (path enumeration, binary search)
is fully amortized into the post-review cascade.

## Sessions

### Fixed-size sessions

Defined by count or time, not "drain everything due":
* "Give me 20 reviews"
* "I have 15 minutes"

Each review is heavier than an Anki card (type a verse, grade multiple phrases), so sessions
have fewer reviews but richer signal.

### Within-session adaptation

After each review, the cascade updates affected cards. If the next planned card's
due_date moved past now (no longer due), skip to the next one. This avoids wasted reviews
when one review reinforces shared edges.

## New verse introduction

* Do not introduce new verses until the daily review target is met.
* Limit to 1–3 new verses per session.
* First review should be full recitation (ref → verse) to establish all forward edges.
* All edges start at initial S from FSRS parameters.
* New verse cards start with effective_R based on initial edge states.

## Phrase boundaries

Phrases define where the edges go inside a verse.

**Default**: AI-generated boundaries. KJV and other translations have consistent clause structure
(commas, semicolons, conjunctions) that LLMs segment reliably. One-time pipeline per translation.

**Override**: editable per verse, per user or per editor.
