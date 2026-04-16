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

**Grading strictness varies by atom type**: phrases must be word-perfect (exact wording matters
for competition). Headings are the opposite — they vary across translations and editions, so
exact wording is irrelevant. The app should prompt generous grading for headings (e.g., "Good"
for getting the gist right even if wording differs from the stored text).

## Credit assignment algorithm

Given per-atom grades from a review, determine how to update every edge in the graph.

### Source set

The **source set** is everything the learner had access to during recall:

```
source = shown atoms ∪ correctly-recalled hidden atoms
```

Correctly recalled atoms join the source set because they were available for recalling subsequent
atoms. In a ref→verse surface, once p1 is successfully recalled it becomes a source for p2 — the
edge p1→p2 was directly exercised.

### Observations

For each hidden atom h:

* **Success** (Good/Easy): at least one path from the source set (excluding h) to h succeeded.
* **Failure** (Again): no path from the source set to h succeeded.
* **Partial** (Hard): a path succeeded with difficulty.

### Step 1: Enumerate paths

For each hidden atom h, enumerate all paths from any atom in the source set (excluding h itself)
to h, up to **5 hops**. Paths follow edge directionality.

### Step 2: Compute path probabilities

```
R(path) = Π R(edge) for each edge in the path
```

Structural edges (no FSRS state) contribute R = 1.0 but cannot receive credit or blame.

### Step 3: Credit (successful atoms)

For a hidden atom h graded Good/Easy:

1. Eliminate paths that pass through any atom graded Again (broken paths).
2. Weight surviving paths by probability:

```
credit(path_i) = R(path_i) / Σ R(path_j)   for all surviving paths j
```

3. Each learnable edge on a surviving path receives credit proportional to its path's weight.

### Step 4: Blame (failed atoms)

For a hidden atom h graded Again, all paths from the source set to h failed. Bayesian blame —
weakest edges get most blame:

```
For each path from source to h, identify the weakest edge (lowest R).
Aggregate blame: edges that are the weakest link on multiple paths receive the most blame.
```

### Step 5: Apply FSRS updates

```
total_weight = Σ (credit or blame from all observations involving this edge)
grade = weighted blend of grades from observations

S_new = interpolate(S_old, S_fsrs(grade), total_weight)
```

### Example

Surface: ref→verse. Grades: p1=Good, p2=Good, p3=Again, p4=Good.

```
Source set = {ref, p1, p2, p4}

Credit for p1 (Good):
  source: {ref, p2, p4}
  paths:  ref → verse → p1      (2 hops, hub)
          p2 → p1               (1 hop, backward)
  → both paths get credit; p2→p1 gets strong credit (short path)

Credit for p2 (Good):
  source: {ref, p1, p4}
  paths:  p1 → p2               (1 hop, sequential)
          ref → verse → p2      (2 hops, hub)
  → p1→p2 gets dominant credit (1-hop from source)

Blame for p3 (Again):
  source: {ref, p1, p2, p4}
  paths:  p2 → p3               (1 hop)
          p4 → p3               (1 hop, backward)
          ref → verse → p3      (2 hops, hub)
  → ALL failed. p2→p3 and p4→p3 get strong blame (short paths)

Credit for p4 (Good):
  source: {ref, p1, p2}
  paths:  ref → verse → p4      (2 hops, hub)
          p2 → p3 → p4          ELIMINATED (p3 failed)
  → hub path gets credit (sequential path broken at p3)
```

### Why this works

* **Sequential edges get direct credit**: p1 is in the source set, so p1→p2 is a 1-hop path —
  no dilution from competing with longer paths through the shown atom.
* **Both directions reinforced**: p1 is in the source set for p2 (p1→p2), and p2 is in the
  source set for p1 (p2→p1). Both edges were exercised.
* **Failed atoms block downstream paths**: p3=Again eliminates p2→p3→p4, so p4's credit goes
  to the hub — reflecting the learner "jumped" via another path.
* **Blame concentrates on short paths**: p2→p3 as a 1-hop failed path gets strong blame.

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

Per review (5-hop limit): path enumerations from each source atom to each hidden atom, ~3
multiplications per path. With source set of ~5 atoms and ~4 hidden atoms, roughly ~200
operations plus ~20 FSRS updates. Anchor transfer adds one multiplication per ref-targeting
path. Total: microseconds.

## Open questions

* **Anchor transfer decay factor**: 0.95 is a starting point. Tunable per user or fixed?
* **Lapse threshold for re-drilling**: how many same-session re-drills before flagging the edge
  to the user as a persistent problem?
