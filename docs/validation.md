# Validation

How to verify the algorithm is correct and well-behaved. Depends on the graph
([graph.md](graph.md)), review model ([review.md](review.md)), and scheduling
([scheduling.md](scheduling.md)).

## Mathematical proofs

Properties to verify on paper before implementation.

### Binary search convergence

The due_date binary search requires R_effective(t) to be monotonically decreasing.

**Proof sketch:**
- Each edge R(t) = (1 + t/(9·S))^(-1) is monotonically decreasing in t ✓
- Serial composition: product of decreasing positive functions is decreasing ✓
- Parallel composition: 1 - Π(1 - R_path(t)). Each (1-R_path) is increasing, product of
  increasing is increasing, 1 minus increasing is decreasing ✓
- due_R = min over atoms of decreasing functions is decreasing ✓

Binary search always converges.

### Credit conservation

For a successful hidden atom, path credits sum to 1.0 by construction:
```
credit(path_i) = R(path_i) / Σ R(path_j)    → Σ credit = 1.0
```

An edge on multiple paths accumulates credit from each — total credit per edge can exceed
1.0. This is correct: an edge on every surviving path was definitely exercised.

For blame: need to verify that blame weights also sum correctly and that the weakest-edge
identification is well-defined (what if two edges have equal R?).

### Monotonicity of priority

Verify that the priority formula has correct ordering properties:
- A card with more due edges should have higher priority than one with fewer (all else equal)
- A card with barely-due edges should have higher priority than one with very-overdue edges
- A cheaper card should have higher priority than an expensive one (same due edges)

## Sensitivity analysis

Analyze behavior at parameter extremes.

### α (review cost exponent, default 0.6)

| Value | Effect |
| ----- | ------ |
| α → 0 | All cards cost the same. Broad cards always win (they exercise more edges per review). |
| α = 0.5 | Moderate penalty. Full recitation costs √4 = 2× a fill-in-the-blank. |
| α = 0.6 | Default. Full recitation costs 4^0.6 = 2.3× a fill-in-the-blank. |
| α = 1.0 | Linear cost. Full recitation costs 4× a fill-in-the-blank. Targeted cards almost always win. |

**Risk at extremes:** α too low over-schedules broad cards (reviewing entire verses when one
phrase needs work). α too high never schedules broad cards (fragments reviews into tiny pieces,
losing sequential-recall practice).

### β (exposure discount, default 0.2)

| Value | Effect |
| ----- | ------ |
| β = 0 | No exposure reinforcement. Shown→shown edges only update when actively tested. |
| β = 0.2 | Default. Exposure is 20% as strong as active testing. |
| β → 1 | Exposure equals active recall. Shown edges get full updates — incorrect, would over-reinforce. |

**Risk at extremes:** β too high inflates edge stability beyond what active recall would
justify. β too low misses real (if weak) reinforcement from passive exposure.

**Runaway check:** with β=0.2, a card reviewed every S days gives shown→shown edges an update
of 0.2 × Good each time. Over many reviews, does this compound to unreasonably high stability?
Need to verify that the FSRS update with weight=0.2 produces appropriately small S increases.

### decay_factor (anchor transfer, default 0.95)

| Value | Effect |
| ----- | ------ |
| → 0 | No anchor transfer. Every verse reference must be memorized independently. |
| 0.95 | Default. 10 verses away decays to 0.60 — significant but not zero. |
| → 1 | One anchor covers the whole chapter. References are "free" near an anchor. |

**Risk at extremes:** Factor too high means learning one reference teaches all nearby refs
(unrealistic). Factor too low means no benefit from knowing nearby refs (also unrealistic —
counting IS a real recall strategy).

## Degenerate cases

### All edges at R ≈ 0 (total forgetting after long break)

Every card is due with priority ≈ 0 (cost_of_delay uses R of due edges, which is ~0). The
scheduler would see all cards as equally low priority.

**Expected behavior:** schedule new-verse-style reviews (full recitation) starting from the
first verse. Essentially re-learning.

**Potential issue:** priority = 0/cost = 0 for all cards — need tiebreaking. Tiebreak by
verse order (start from the beginning of the material).

### One dominant path (R ≈ 1.0) with all alternatives weak

Credit concentrates entirely on the dominant path. Other paths' edges get near-zero credit.
Correct — the dominant path was almost certainly the one used.

**Risk:** the weak alternative paths never get strengthened. If the dominant path later
decays, the alternatives are still weak. This is by design (edges have independent decay),
but worth monitoring.

### Disconnected atom (no paths from any source)

effective_R = 0, card is permanently due. Indicates a graph construction bug — every atom
should be reachable from at least one shown atom in at least one card.

### Very long verses (many phrases)

A verse with 10 phrases has 10 fill-in-the-blank cards + full recitation + other types =
~15 cards. Edge count: 4(10)+4 = 44 base edges. The path enumeration and binary search
scale linearly — no performance concern. But the full recitation card has review_cost =
10^0.6 = 4.0, making it expensive. The scheduler should prefer fill-in-the-blank for long
verses unless many edges are due simultaneously.

## Toy graph walkthrough

Manually trace the full algorithm through several review cycles to verify correctness.

### Setup

One verse with 3 phrases. Initial state: all edges at S=1, D=5 (new).

```
chapter_gist ← verse ↔ ref
                 / | \
               p1 ─ p2 ─ p3
```

Edges (directed):
- verse ↔ ref (2)
- verse ↔ p1, verse ↔ p2, verse ↔ p3 (6)
- p1 ↔ p2, p2 ↔ p3 (4)
- verse → chapter_gist (1)
Total: 13 directed edges

Cards:
- full recitation: shown={ref}, hidden={p1,p2,p3}
- fill-in-blank(p1): shown={ref,p2,p3}, hidden={p1}
- fill-in-blank(p2): shown={ref,p1,p3}, hidden={p2}
- fill-in-blank(p3): shown={ref,p1,p2}, hidden={p3}
- verse→ref: shown={p1,p2,p3}, hidden={ref}

### Cycle 1: First review (day 0)

1. All edges S=1, R=1.0 (just initialized). No card is due.
2. New verse introduction: schedule full recitation.
3. Learner reviews: p1=Good, p2=Good, p3=Good.
4. Credit assignment:
   - Source set = {ref, p1, p2, p3}
   - Trace paths and credit for each hidden atom
   - Compute FSRS updates for each edge
5. Post-review cascade:
   - Update all 5 cards' due_R, due_date, priority
6. Record: new edge states, new card states

### Cycle 2: Next due card (day S_new)

1. Find the card with earliest due_date.
2. Which card comes due first? (depends on which edges have lowest S after cycle 1)
3. Review and trace credit assignment.
4. Verify: do edge states converge toward expected values?

### Cycle 3+: Introduce a lapse

1. Force a failure on one phrase (grade Again).
2. Trace blame assignment — does it target the right edge?
3. Verify: lapse re-drilling queues a fill-in-the-blank.
4. After re-drill: does the edge recover?

### What to verify

- Edge S values increase on successful reviews and decrease on lapses
- Credit flows to the right edges (sequential edges get strong credit, hub edges get moderate)
- Hard grades: atom joins source set, doesn't block paths, gives smaller S increase than Good
- **Fallback chain correctness**:
  - An edge on a credit path AND between shown atoms gets primary credit only (no exposure)
  - An edge between shown atoms NOT on any credit path gets exposure only
  - A reverse edge where the forward got credit but reverse got nothing gets reverse reinforcement
  - No edge gets more than one type of secondary update
- Priority formula selects targeted cards when one edge is weak, broad cards when many are
- due_date binary search gives correct values
- Post-review cascade correctly updates affected cards
- Anchor transfer (if multi-verse): nearby anchors boost effective_R for refs

## Simulation framework

### Architecture

A simulation that generates synthetic review data and evaluates algorithm predictions.

```
Ground truth model → generates recall outcomes
Algorithm under test → predicts recall, updates state
Evaluation metrics → compares predictions to outcomes
```

### Ground truth model

The "simulated learner" has true edge states (S_true, D_true) and recall is stochastic:
```
R_true(edge) = (1 + t / (9 · S_true))^(-1)
recall = random() < R_true
```

The true states evolve with FSRS update rules when the learner reviews. This gives us a
known-correct baseline to test against.

### Test scenarios

1. **Single verse, all cards**: verify convergence of edge states over 50+ reviews
2. **Two adjacent verses**: verify cross-verse edges and anchor transfer
3. **Full chapter (30 verses)**: verify scaling, priority selection, session building
4. **Returning after a break**: all R values low, verify recovery ordering
5. **Club 150 quizzer**: verify club entries, listing cards, club-consecutive chains
6. **Mixed lapse rates**: some phrases always succeed, some frequently lapse

### Metrics to compute

Per the [SRS benchmark methodology](https://github.com/open-spaced-repetition/awesome-fsrs/wiki/The-Metric):

- **Log loss**: -(1/N) Σ [y_i log(p_i) + (1-y_i) log(1-p_i)]
  where p_i = predicted effective_R, y_i = actual outcome (0/1)
- **AUC**: does ranking cards by effective_R correctly predict which will succeed vs fail?
- **RMSE (bins)**: bin by interval length, review count, lapse count. Compare predicted R
  to actual recall rate per bin.

### Comparison baselines

- **Vanilla FSRS per-card**: standard FSRS with no edge graph, one S/D per card. Shows
  whether the edge-based model outperforms the per-card model.
- **Random scheduling**: pick cards randomly. Shows the minimum bar.
- **Perfect oracle**: schedule using true S values. Shows the theoretical maximum.

### Implementation plan

1. Implement the edge graph data structures (atoms, edges, S/D/last_review)
2. Implement FSRS update functions (stability increase, post-lapse, initial state)
3. Implement path enumeration (BFS/DFS up to 5 hops, respecting directionality)
4. Implement credit assignment (source set, path weighting, blame)
5. Implement card DB (effective_R, due_date binary search, priority scoring)
6. Implement the simulated learner (ground truth model)
7. Run test scenarios, compute metrics
8. Compare against vanilla FSRS baseline
