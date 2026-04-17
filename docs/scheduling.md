# Scheduling

How the system decides what to show the learner and when. Depends on the graph structure
([graph.md](graph.md)) and review model ([review.md](review.md)).

## Goal

Maximize total retained memory, minimize review effort. The scheduler picks the card where
each unit of learner effort produces the most memory maintenance.

## Architecture

Scheduling uses two database layers:

```
Edge DB (memory):     edge_id, S, D, last_review_time
Card DB (cards):      card_id, shown_atoms, hidden_atoms, due_R, due_date, priority
Edge→Card mapping:    edge_id → [card_ids that depend on this edge]
```

The **edge DB** tracks memory state. The **card DB** tracks scheduling state. Scheduling is
a simple query on the card DB — no graph computation at schedule time.

## Card catalog

Each verse has ~10 candidate cards. Each chapter has ~5–10. Total: ~5,200 card records
for a 500-verse season.

Per verse (N=4 phrases):

| Card                 | Shown                | Hidden              |
| -------------------- | -------------------- | ------------------- |
| full recitation      | {ref}                | {p1, p2, p3, p4}   |
| fill-in-blank (×N)   | {ref, other phrases} | {one phrase}        |
| first words → rest   | {p1}                 | {p2, p3, p4}       |
| verse → ref          | {p1, p2, p3, p4}    | {ref}               |
| verse → heading      | {ref} or {phrases}   | {heading}           |
| ref → heading        | {ref}                | {heading}           |
| cross-verse          | {prev last phrase}   | {p1, p2, p3, p4}   |

Per chapter:

| Card                 | Shown                | Hidden              |
| -------------------- | -------------------- | ------------------- |
| club 150 listing     | {chapter_gist}       | {150 verse refs}    |
| club 300 listing     | {chapter_gist}       | {300 verse refs}    |
| heading → next       | {heading}            | {next heading}      |
| heading → prev       | {heading}            | {prev heading}      |
| ref range → heading  | {start ref, end ref} | {heading}           |

## Computing due_R

A card is due when any of its hidden atoms drops below target retention. `due_R` is the
R_eff of the weakest hidden atom:

```
due_R(card) = min over hidden atoms h: R_eff(h, shown_atoms)
```

Where R_eff(h, shown_atoms) = parallel composition over all paths from shown atoms to h
(up to 5 hops). See [review.md](review.md).

For cards where the hidden atom is a reference, anchor transfer applies (see
[review.md](review.md)).

A card is **due** when `due_R < target_retention`.

## Computing due_date

R_eff(t) is deterministic and monotonically decreasing as edge R values decay. The due_date
is when the weakest hidden atom crosses target_retention. Solved via binary search:

```
low = now
high = now + 365 days
while high - low > 1 hour:
    mid = (low + high) / 2
    if min_R_eff_at(mid) > target_retention:
        low = mid
    else:
        high = mid
due_date = high
```

Computing min_R_eff_at(t) = for each hidden atom, evaluate path enumeration with each edge's
R projected to time t: `R_edge(t) = (1 + (t - last_review) / (9 · S))^(-1)`. Take the min.

Cost: ~20 iterations × ~120 ops = ~2,400 ops per card. Sub-millisecond.

## Computing priority

The scheduler's goal: maximize memory maintained per unit of review effort. The priority
score captures this by combining **cost of delay** and **review cost**.

### Cost of delay

The cost of skipping a review is highest for barely-due edges — they have the most
stability-compounding momentum to lose. Very overdue edges have already lost their momentum;
delaying further costs little extra.

For each edge on a path from shown to hidden:
```
cost_of_delay(edge) = R(edge)    if R(edge) < target_retention (edge is due)
                    = 0          if R(edge) ≥ target_retention (edge is fine)
```

Higher R among due edges = more to lose from delay.

Total cost of delay for the card = sum across all due edges the card exercises:
```
total_delay(card) = Σ R(edge) for each due edge on paths from shown to hidden
```

This is a byproduct of the path enumeration already done when computing due_R — just flag
which edges are on paths and below target.

### Review cost

Review effort scales sub-linearly with hidden atoms. Typing a full verse flows sequentially
(each phrase cues the next) and has fixed per-review overhead.

```
review_cost(card) = N_hidden ^ α      where α ∈ (0.5, 0.8), default 0.6
```

| Card type          | N_hidden | Cost (α=0.6) |
| ------------------ | -------- | ------------- |
| fill-in-blank      | 1        | 1.0           |
| verse → ref        | 1        | 1.0           |
| first words → rest | 3        | 1.9           |
| full recitation    | 4        | 2.3           |
| club 150 listing   | 7        | 3.4           |

α can be calibrated from observed review durations once users are active.

### Reinforcement bonus

A card also passively reinforces edges between shown atoms (see exposure reinforcement in
[review.md](review.md)). Edges between shown atoms that are below target contribute a
β-discounted bonus to the priority:

```
reinforcement_bonus(card) = Σ R(edge) for due edges between shown atoms
```

This gives a card credit for doing "double duty" — testing hidden atoms while also exposing
due shown-atom edges.

### Priority formula

```
priority(card) = (total_delay(card) + β × reinforcement_bonus(card)) / review_cost(card)
```

Where β ≈ 0.1–0.3 (same discount as exposure reinforcement in credit assignment).

Reinforcement bonus sums both directions of each shown↔shown edge (each directed edge
contributes separately).

**Examples** (β=0.2, α=0.6):

Note: in these examples, "due edges" means all directed edges on paths from shown to
hidden that have R < target. A full recitation card with 4 hidden phrases has paths
through hub edges (verse→p1..p4), sequential edges (p1→p2, p2→p3, p3→p4), and
ref→verse — typically 8+ directed edges. The examples use simplified counts for
clarity.

```
All phrase-related edges barely due (R=0.88):
  Full recitation (shown={ref}, hidden={p1,p2,p3,p4}):
    delay = 8 × 0.88 = 7.04 (ref→verse, verse→p1..p4, p1→p2, p2→p3, p3→p4)
    reinf = 0 (only one shown atom, no shown↔shown edges)
    cost = 4^0.6 = 2.3
    priority = 7.04 / 2.3 = 3.06

  Fill-in-blank for p2 (shown={ref,p1,p3,p4}, hidden={p2}):
    delay = 0.88 (p1→p2 is the main due edge on paths to p2)
    reinf = p3→p4 + p4→p3 = 2 × 0.88 = 1.76 (only direct shown↔shown pair)
    cost = 1^0.6 = 1.0
    priority = (0.88 + 0.2 × 1.76) / 1.0 = 1.23
  → Full recitation wins — covers all due edges in one review ✓

Ref edge due, phrase→phrase edges also due:
  verse→ref (shown={p1,p2,p3,p4}, hidden={ref}):
    delay = 0.88 (verse→ref is the main due edge on paths to ref)
    reinf = p1↔p2 + p2↔p3 + p3↔p4 = 6 × 0.88 = 5.28 (3 bi pairs = 6 directed)
    cost = 1^0.6 = 1.0
    priority = (0.88 + 0.2 × 5.28) / 1.0 = 1.94
  → verse→ref wins — reinforces 6 phrase edges while testing ref ✓

Only 1 edge due, nothing else weak:
  Full recitation:  delay=0.88, reinf=0, cost=2.3 → priority = 0.38
  Fill-in-blank:    delay=0.88, reinf=0, cost=1.0 → priority = 0.88
  → Fill-in-blank wins — don't waste effort on non-due edges ✓
```

## Post-review cascade

After each review:

1. **Credit assignment** updates edges in the edge DB (new S, D, last_review_time).
2. **Find affected cards** via the edge→card mapping. Most edges are within one verse,
   so ~10 cards are affected. Cross-verse edges add ~20 more. Typically ~30 cards total.
3. **Recompute due_R, due_date, and priority** for each affected card using the updated
   edge values and binary search.
4. **Write** updated values to the card DB.

Cost: ~30 cards × ~2,400 ops = ~72,000 ops. Sub-millisecond. The cascade runs as part of
the review completion — no background job needed.

## Picking the next review

Scheduling is a database query:

```sql
SELECT * FROM cards
WHERE due_date <= now
ORDER BY priority DESC
LIMIT N
```

No graph computation at schedule time. The expensive work (path enumeration, binary search,
priority scoring) is fully amortized into the post-review cascade.

## Sessions

### Fixed-size sessions

Defined by count or time, not "drain everything due":
* "Give me 20 reviews"
* "I have 15 minutes"

Each review is heavier than an Anki card (type a verse, grade multiple phrases), so sessions
have fewer reviews but richer signal.

### Within-session adaptation

After each review, the cascade updates affected cards. If the next planned card's due_date
moved past now (no longer due), skip to the next one. This avoids wasted reviews when one
review reinforces shared edges.

## New verse introduction

* Do not introduce new verses until the daily review target is met.
* Limit to 1–3 new verses per session.
* First review should be full recitation (ref → verse) to establish all forward edges.
* All edges start at initial S from FSRS parameters.
* New verse cards start with due_R and priority based on initial edge states.

## Phrase boundaries

Phrases define where the edges go inside a verse.

**Default**: AI-generated boundaries. KJV and other translations have consistent clause structure
(commas, semicolons, conjunctions) that LLMs segment reliably. One-time pipeline per translation.

**Override**: editable per verse, per user or per editor.

## Open questions

* **α calibration**: default 0.6 is a guess. Calibrate from observed review durations per card
  type once real usage data exists.
* **Session-level optimization**: the greedy approach (pick highest priority next) doesn't account
  for covering multiple due edges in one broad card vs. several targeted cards. A knapsack-style
  optimizer could improve session efficiency but adds complexity.
