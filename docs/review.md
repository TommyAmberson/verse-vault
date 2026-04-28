# Reviews and Credit Assignment

How learner reviews update the memory graph. Depends on the graph structure defined in
[graph.md](graph.md).

## Cards

A card is a **mask** over the graph: `shown = {atoms}`, `hidden = {atoms}`. The learner sees the
shown atoms and must produce the hidden ones. Cards are modes of testing, not memory units.

Example cards (using `{ref}` as shorthand for the `[book_ref, chapter_ref, verse_ref]` triple — see
"Reference triple" below):

| Card               | Shown                                | Hidden                                           |
| ------------------ | ------------------------------------ | ------------------------------------------------ |
| ref → verse        | {ref}                                | {p1, p2, p3, p4}                                 |
| verse → ref        | {p1, p2, p3, p4}                     | {ref}                                            |
| first words → rest | {p1}                                 | {p2, p3, p4}                                     |
| fill-in-blank (p2) | {ref, p1, p3, p4}                    | {p2}                                             |
| cross-verse        | {last phrase of prev}                | {p1, p2, p3, p4}                                 |
| club listing       | {club_gist, book_ref, chapter_ref}   | {verse_ref(2:1), verse_ref(2:4), verse_ref(2:7)} |
| verses → heading   | {verse_ref(10:23) … verse_ref(11:1)} | {heading}                                        |
| verse → heading    | {ref} or {p1, p2, ...}               | {heading}                                        |
| finish this verse  | {ftv}                                | {p1, p2, p3, p4}                                 |

All possible cards for a verse are **pre-generated** and stored in the card DB with precomputed
effective_R and due_date (see [scheduling.md](scheduling.md)). The scheduler picks from this catalog
— it does not generate cards on the fly.

### Reference triple

A verse reference is three atoms: `book_ref`, `chapter_ref`, `verse_ref`. The card-types TOML role
`ref` resolves to all three; verse-scoped cards that name `ref` in `show` or `hide` carry the full
triple in that slot. This means the source set for credit assignment includes all three refs
whenever a verse-style card is reviewed, and graders can produce three independent pass/fail signals
(one per component) if the frontend chooses to split the typed answer. See
[graph.md § Card scopes + coupling](graph.md#card-scopes--coupling).

Listing-style cards (`club_chapter_listing`, `verses_to_heading`) carry the verse-ref atoms directly
without the per-verse triple coupling — the chapter/book context is supplied either explicitly in
`shown` (chapter-club) or implicit in the rendered verse range (heading).

Session re-drills and progressive-reveal cards (constructed at runtime in
`crates/core/src/session.rs`) populate the same triple in `shown` via `Graph::verse_ref_parents`, so
the source set stays consistent between catalog cards and session-generated cards.

## Review interaction

1. Card presents the shown atoms as the prompt.
2. Learner types the hidden atoms.
3. App diffs typed text against source, aligned to phrase boundaries.
4. Learner grades each hidden atom: Again / Hard / Good / Easy.
5. Grades feed into credit assignment.

**Grading strictness varies by atom type**: phrases must be word-perfect (exact wording matters for
competition). Headings are the opposite — they vary across translations and editions, so exact
wording is irrelevant. The app should prompt generous grading for headings (e.g., "Good" for getting
the gist right even if wording differs from the stored text).

## Credit assignment algorithm

Given per-atom grades from a review, determine how to update every edge in the graph.

### Source set (review vs. scheduling)

There are two source set definitions, used in different contexts:

**During review (credit assignment)**:

```
source = shown atoms ∪ correctly-recalled hidden atoms
```

Correctly recalled atoms join the source set because they were available for recalling subsequent
atoms. In a ref→verse card, once p1 is successfully recalled it becomes a source for p2 — the edge
p1→p2 was directly exercised.

**During scheduling (card effective_R in the card DB)**:

```
source = shown atoms only
```

The card DB precomputes effective_R conservatively using only the shown atoms, because at scheduling
time we don't know which hidden atoms will be recalled. The actual review may go better than
predicted (due to source set expansion), which is fine — the prediction is a conservative lower
bound.

### Grades

FSRS uses four grades, following standard spaced-repetition convention:

| Grade | Code | Classification | Effect on S                                | Effect on D                  |
| ----- | ---- | -------------- | ------------------------------------------ | ---------------------------- |
| Again | 1    | **Fail**       | Post-lapse formula (S drops significantly) | D increases                  |
| Hard  | 2    | **Pass**       | S increases (smaller multiplier, w₁₅)      | D increases                  |
| Good  | 3    | **Pass**       | S increases (standard)                     | D unchanged (mean reversion) |
| Easy  | 4    | **Pass**       | S increases (larger multiplier, w₁₆)       | D decreases                  |

### Observations

For each hidden atom h:

* **Pass** (Good/Easy/Hard): at least one path from the source set (excluding h) to h succeeded. The
  atom joins the source set. Hard is a pass — the learner recalled it, just with difficulty. Paths
  through Hard atoms are NOT eliminated.
* **Fail** (Again): no path from the source set to h succeeded. The atom does NOT join the source
  set. Paths through this atom are eliminated for other atoms' credit assignment.

### Step 1: Enumerate paths

For each hidden atom h, enumerate all paths from any atom in the source set (excluding h itself) to
h, up to **5 hops**. Paths follow edge directionality.

### Step 2: Compute path probabilities

```
R(path) = Π R(edge) for each edge in the path
```

Structural edges (no FSRS state) contribute R = 1.0 but cannot receive credit or blame.

### Step 3: Credit (successful atoms)

For a hidden atom h graded Good/Easy/Hard (any pass):

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

### Step 5: Secondary reinforcement (fallback chain)

After primary credit/blame, edges that received no primary update may get a secondary update. These
follow a **priority chain** — each edge gets at most one type of update:

```
1. Primary credit/blame (Steps 3-4)     always applied, accumulates across atoms
2. Exposure                              ONLY if no primary update
3. Reverse reinforcement                 ONLY if no primary or exposure update
```

**Exposure**: edges between shown atoms were passively observed. If an edge got no primary credit or
blame, it receives a weak exposure update:

```
For each edge between shown atoms where R(edge) < target_retention:
  IF edge received no primary credit or blame this review:
    exposure_weight = β
    grade = Good
```

**Reverse reinforcement**: for bidirectional edges where one direction was updated but the reverse
was not. If the reverse direction got no primary or exposure update:

```
For each directed edge B→A that received NO update this review:
  If the reverse edge A→B DID receive an update with weight w and grade G:
    B→A gets: weight β × w, grade G
```

The fallback chain prevents double-counting. An edge between two shown atoms that is ALSO on a
credit path (e.g., p1→p2 in a verse→ref card where p1→p2→verse→ref is a path) gets only primary
credit, not exposure on top. Exposure only fills in edges the primary algorithm didn't reach.

### Step 6: Apply FSRS updates

```
total_weight = primary_weight + secondary_weight (if applicable)
grade = weighted blend of grades from all updates

S_new = interpolate(S_old, S_fsrs(grade), total_weight)
```

### Example

Card: ref→verse. Grades: p1=Good, p2=Good, p3=Again, p4=Good.

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

* **Sequential edges get direct credit**: p1 is in the source set, so p1→p2 is a 1-hop path — no
  dilution from competing with longer paths through the shown atom.
* **Both directions reinforced**: p1 is in the source set for p2 (p1→p2), and p2 is in the source
  set for p1 (p2→p1). Both edges were exercised.
* **Failed atoms block downstream paths**: p3=Again eliminates p2→p3→p4, so p4's credit goes to the
  hub — reflecting the learner "jumped" via another path.
* **Blame concentrates on short paths**: p2→p3 as a 1-hop failed path gets strong blame.
* **No double-counting**: secondary updates (exposure, reverse reinforcement) only apply to edges
  that got no primary update. An edge on a credit path AND between shown atoms gets primary credit
  only — not exposure on top.

## Anchor transfer

When the hidden atom is a **reference**, path enumeration extends with anchor transfer: a path can
reach ANY ref atom, and arithmetic (target = anchor ± chain_distance) is modeled as **distance-based
decay**.

```
effective_R(path) = R(path_to_anchor_ref) × decay_factor ^ |target_num - anchor_num|
```

| Distance | Decay (factor=0.95) | Meaning                |
| -------- | ------------------- | ---------------------- |
| 0        | 1.00                | Direct recall          |
| 1        | 0.95                | One verse away         |
| 2        | 0.90                | Two verses             |
| 5        | 0.77                | Moderate mental effort |
| 10       | 0.60                | Significant counting   |

**Example**: recalling ref(2:3), direct edge weak:

```
Direct:       verse(2:3) → ref(2:3)
              R = 0.30 × decay(0) = 0.30

Via ref(2:1): verse(2:3) → v(2:2) → v(2:1) → ref(2:1)
              R = 0.90 × 0.90 × 0.95 × decay(2) = 0.77 × 0.90 = 0.69

Via ref(2:4): verse(2:3) → v(2:4) → ref(2:4)
              R = 0.85 × 0.80 × decay(1) = 0.68 × 0.95 = 0.65

Parallel: R_total = 1 - (1-0.30)(1-0.69)(1-0.65) = 0.924
```

**Anchor transfer only applies to references.** References are numbers that support arithmetic.
Other atom types (phrases, gists, club membership) cannot be derived from neighbors.

**Counting requires full-material knowledge.** To count from ref(2:1) to ref(2:4), the learner needs
the chapter-consecutive verse chain (3 hops through 2:2, 2:3). If those edges are weak (unreviewed),
the anchor path is naturally weak.

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

**Re-drilling**: the scheduler queues a fill-in-the-blank card targeting the lapsed edge later in
the current session, after a few intervening reviews (within-session spacing). If the re-drill fails
again, queue another with a longer gap.

## Computational cost

Per review (5-hop limit): path enumerations from each source atom to each hidden atom, ~3
multiplications per path. With source set of ~5 atoms and ~4 hidden atoms, roughly ~200 operations
plus ~20 FSRS updates. Anchor transfer adds one multiplication per ref-targeting path. Total:
microseconds.

## Open questions

* **Anchor transfer decay factor**: 0.95 is a starting point. Tunable per user or fixed?
* **Lapse threshold for re-drilling**: how many same-session re-drills before flagging the edge to
  the user as a persistent problem?
