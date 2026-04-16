# Reviews and Credit Assignment

How learner reviews update the memory graph. Depends on the graph structure defined in
[graph.md](graph.md).

## Surfaces

A surface is a **mask** over the graph: `shown = {atoms}`, `hidden = {atoms}`. The learner sees
the shown atoms and must produce the hidden ones. Surfaces are modes of testing, not memory units.

Example surfaces:

| Surface              | Shown                    | Hidden                         |
| -------------------- | ------------------------ | ------------------------------ |
| ref → verse           | {ref}                    | {p1, p2, p3, p4}              |
| verse → ref           | {p1, p2, p3, p4}         | {ref}                          |
| first words → rest   | {p1}                     | {p2, p3, p4}                  |
| fill-in-blank (p2)   | {ref, p1, p3, p4}        | {p2}                           |
| cross-verse          | {last phrase of prev}     | {p1, p2, p3, p4}              |
| club listing         | {chapter_gist}            | {ref(2:1), ref(2:4), ref(2:7)} |
| verse → heading      | {ref} or {p1, p2, ...}    | {heading}                      |
| ref → heading        | {ref}                     | {heading}                      |

Surfaces are **dynamically generated** by the scheduler based on which edges need reinforcement
(see [scheduling.md](scheduling.md)), not chosen from a fixed menu.

## Review interaction

1. Surface presents the shown atoms as the prompt.
2. Learner types the hidden atoms.
3. App diffs typed text against source, aligned to phrase boundaries.
4. Learner grades each hidden atom: Again / Hard / Good / Easy.
5. Grades feed into credit assignment.

**Heading grading**: headings don't need to be recalled perfectly — they vary across translations
and editions, so exact wording is less important than recognizing the right section. The app
should prompt the user to grade generously (e.g., "Good" for getting the gist right even if the
wording differs from the stored heading text).

## Credit assignment algorithm

Given per-atom grades from a review, determine how to update every edge in the graph.

### Observations

Each hidden atom's grade tells us:

* **Success** (Good/Easy): at least one path from a shown atom succeeded.
* **Failure** (Again): no path from any shown atom succeeded.
* **Partial** (Hard): a path succeeded with difficulty.

### Step 1: Enumerate paths

For each (shown atom, hidden atom) pair, find all paths through the graph up to **5 hops**.
Paths follow edge directionality — unidirectional edges can only be traversed in their defined
direction.

### Step 2: Compute path probabilities

```
R(path) = Π R(edge) for each edge in the path
```

Structural edges (no FSRS state) contribute R = 1.0 to path probability but cannot receive
credit or blame.

### Step 3: Credit (successful atoms)

For a hidden atom graded Good/Easy:

1. Eliminate paths that pass through any atom graded Again (broken paths).
2. Weight surviving paths by probability:

```
credit(path_i) = R(path_i) / Σ R(path_j)   for all surviving paths j
```

3. Each learnable edge on a surviving path receives credit proportional to its path's weight.

**Example**: p2 graded Good, p1 graded Again:

```
ref → verse → p2:        R = 0.85 × 0.90 = 0.765  ← viable
ref → verse → p1 → p2:   ELIMINATED (p1 failed)
ref → verse → p3 → p2:   R = 0.85 × 0.70 × 0.60 = 0.357  ← viable

credit: ref→verse gets 1.0, verse→p2 gets 0.68, verse→p3 gets 0.32, p3→p2 gets 0.32
```

### Step 4: Blame (failed atoms)

For a hidden atom graded Again, all paths failed. Bayesian blame — weakest edges get most blame:

```
For each path, identify the weakest edge (lowest R).
Aggregate blame: edges that are the weakest link on multiple paths receive the most blame.
```

### Step 5: Apply FSRS updates

```
total_weight = Σ (credit or blame from all observations involving this edge)
grade = weighted blend of grades from observations

S_new = interpolate(S_old, S_fsrs(grade), total_weight)
```

### Why this works

Reinforcement categories (full / strong / medium / weak) emerge from the path analysis instead
of being hand-coded:

* Short, high-probability paths → high credit ≈ full reinforcement
* Long, low-probability paths → low credit ≈ weak reinforcement
* No path to the atom → zero credit

The mask defines observations. The graph defines paths. The math handles the rest.

## Anchor transfer

When the hidden atom is a **reference**, path enumeration extends with anchor transfer: a path
can reach ANY ref atom, and arithmetic (target = anchor ± chain_distance) is modeled as
**distance-based decay**.

```
effective_R(path) = R(path_to_anchor_ref) × decay_factor ^ |target_num - anchor_num|
```

| Distance | Decay (factor=0.95) | Meaning                    |
| -------- | ------------------- | -------------------------- |
| 0        | 1.00                | Direct recall              |
| 1        | 0.95                | One verse away             |
| 2        | 0.90                | Two verses                 |
| 5        | 0.77                | Moderate mental effort     |
| 10       | 0.60                | Significant counting       |

**Example**: recalling ref(2:3), direct edge weak:

```
Direct:       verse(2:3) → ref(2:3)                      R = 0.30 × decay(0) = 0.30
Via ref(2:1): verse(2:3) → v(2:2) → v(2:1) → ref(2:1)   R = 0.81 × 0.85 × decay(2) = 0.62
Via ref(2:4): verse(2:3) → v(2:4) → ref(2:4)             R = 0.80 × 0.70 × decay(1) = 0.53

Parallel: R_total = 1 - (1-0.30)(1-0.62)(1-0.53) = 0.875
```

**Anchor transfer only applies to references.** References are numbers that support arithmetic.
Other atom types (phrases, gists, club membership) cannot be derived from neighbors.

**Counting requires full-material knowledge.** To count from ref(2:1) to ref(2:4), the learner
needs the chapter-consecutive verse chain (3 hops through 2:2, 2:3). If those edges are weak
(unreviewed), the anchor path is naturally weak.

## Grade blending

When an edge participates in both successful and failed observations in the same review, updates
accumulate additively:

```
Δ_total = Σ (weight_i × FSRS_update(grade_i))
```

Positive paths push S up, negative paths push S down.

## Lapses

A lapse is an Again grade — the learner could not produce the transition.

**Post-lapse update**: FSRS's post-lapse stability formula drops S significantly but preserves
partial prior learning. D increases.

**Re-drilling**: the scheduler queues a fill-in-the-blank surface targeting the lapsed edge later
in the current session, after a few intervening reviews (within-session spacing). If the re-drill
fails again, queue another with a longer gap.

## Computational cost

Per review (5-hop limit): ~40 path enumerations × ~3 multiplications ≈ 120 operations, plus ~20
FSRS updates. Anchor transfer adds one multiplication per ref-targeting path. Total: microseconds.
The bottleneck is the learner typing (30+ seconds), not computation.

## Open questions

* **Anchor transfer decay factor**: 0.95 is a starting point. Tunable per user or fixed?
* **Lapse threshold for re-drilling**: how many same-session re-drills before flagging the edge
  to the user as a persistent problem?
