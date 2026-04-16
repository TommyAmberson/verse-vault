# Verse-Vault Memory Model

## Overview

Verse-Vault uses an edge-based memory graph to model how scripture is learned and recalled. The core
insight: **memory is not about knowing isolated facts — it is about transitions between pieces of
information.** The unit of memory is not "I know phrase X" but "given cue X, I can produce Y."

Each transition (edge) carries its own spaced-repetition state (Stability, Difficulty) tracked via
the FSRS algorithm. Retrievability is computed on the fly from Stability and elapsed time. When a
learner reviews a verse, the system uses path-based Bayesian credit assignment to update every edge
in the graph that participated in the recall.

This design is grounded in two theoretical results:

* **Paired-associate learning** (foundational memory science): memory is stored as cue→response
  associations. The strength of the association determines recall.
* **Woźniak's memory complexity formula** (2005): composite memory stability follows
  `1/S = 1/S_a + 1/S_b`. Long items modeled as single atomic cards have stability collapsing toward
  zero as complexity grows. Decomposition into smaller cue→response pairs is theoretically required,
  not just a UX preference.

## Primitives

### Node types

There are three types of nodes (atoms) in the graph:

| Node type     | What it represents                                                       | Directly testable?                              | Example                         |
| ------------- | ------------------------------------------------------------------------ | ----------------------------------------------- | ------------------------------- |
| **Reference** | The verse citation                                                       | Yes (recite it, identify it)                    | "John 3:16"                     |
| **Verse**     | The gist/identity of a verse — what it's about, where it sits in context | No — latent atom, updated only through coupling | [semantic anchor for John 3:16] |
| **Phrase**    | A chunk of verbatim text within a verse                                  | Yes (recite it)                                 | "For God so loved the world,"   |

The **verse node** is a non-testable hub that:

* Connects the reference to the phrase chain (ref ↔ verse ↔ phrases)
* Connects consecutive verses (verse ↔ verse)
* Separates **gist memory** ("I know what this verse is about") from **verbatim memory** ("I can
  recite the exact words")
* Has its own FSRS state that evolves through coupling, representing how well the learner "knows"
  the verse at an abstract level

There are **no direct edges between references and phrases**. All ref-to-phrase paths route through
the verse node.

### Edge types

Every edge is **bidirectional** — each direction is tracked as a separate memory with its own (S, D)
state. "verse → first phrase" and "first phrase → verse" are two different memories.

| Edge            | Represents                                                                    | Stability profile                                                         |
| --------------- | ----------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| ref ↔ verse     | "I know what this reference is about" / "I know the reference for this verse" | Medium — decays if not reviewed                                           |
| verse ↔ phrase  | "this phrase belongs to/comes from this verse"                                | High — exercised on every review of the verse                             |
| phrase ↔ phrase | "this phrase leads to/comes from that phrase" (verbatim sequential order)     | Variable — the core of verbatim recall                                    |
| verse ↔ verse   | "this verse comes after/before that verse"                                    | Medium — cross-verse context. Exists between all consecutive verses in a chapter, even if not actively memorized (assume basic familiarity) |
| ref ↔ ref       | "these references are sequential"                                             | **Hardcoded R=1.0** — not tracked with FSRS. "3:17 comes after 3:16" is trivially known and never needs review |

### Graph structure

For two consecutive verses, the graph looks like:

```
ref(3:16) ―― ref(3:17)                      sequential references (trivial, S≈∞)
    |              |
 verse1    ――   verse2                       cross-verse context
  / | \          / | \
 p1─p2─p3      p4─p5─p6                     phrase chains (verbatim)
```

Each verse node hub-connects to **all** of its phrases (verse1 ↔ p1, verse1 ↔ p2, verse1 ↔ p3).
Cross-verse recall routes through the verse hubs: `p3(v1) → verse1 → verse2 → p4(v2)`.

### Edge inventory per verse

For a verse with N phrases:

| Edge type                    | Count (undirected) | Count (directed, ×2) |
| ---------------------------- | ------------------ | -------------------- |
| ref ↔ verse                  | 1                  | 2                    |
| verse ↔ phrase (hub)         | N                  | 2N                   |
| phrase ↔ phrase (sequential) | N-1                | 2(N-1)               |
| verse ↔ next verse           | 1                  | 2                    |
| ref ↔ next ref               | 1                  | 2                    |
| **Total**                    | **2N + 2**         | **4N + 4**           |

For N=4 phrases: 20 directed edges per verse. For a 500-verse QuizMeet season (~4 phrases avg):
~10,000 directed edges, each storing (S, D, last_review_time). Trivially tractable.

### Edge state

Each directed edge stores:

* **Stability (S)**: days for retrievability to decay from 1.0 to 0.9
* **Difficulty (D)**: intrinsic difficulty, real number in [1, 10]
* **last_review_time**: timestamp of last update

**Retrievability (R)** is computed on the fly: `R = (1 + t / (9 · S))^(-1)` where t is elapsed days
since last review. No need to store R or due dates — the computation is trivial and avoids stale
precomputed values, especially since each review updates many edges simultaneously.

## Composite retrievability

### Serial composition (within a chain)

When recall requires traversing a chain of edges (e.g., ref → verse → p1 → p2 → p3), all edges
must fire:

```
R_chain = R₁ × R₂ × R₃ × ...
```

The weakest link dominates. This is Woźniak's formula expressed in retrievability space.

### Parallel composition (redundant paths)

When multiple independent paths exist from cue to target, any one succeeding is enough:

```
R_parallel = 1 - (1 - R_path_a)(1 - R_path_b)
```

The strongest path dominates. This explains why well-connected atoms (many paths to reach them) need
fewer reviews. Verses memorized in context (sequential chapters) are easier to maintain than
isolated verses — the cross-verse edges create redundant paths for free.

### Example: recalling phrase 3 given the reference

```
Path A (sequential):  ref → verse → p1 → p2 → p3
Path B (hub direct):  ref → verse → p3

R_total = 1 - (1 - R_a)(1 - R_b)
```

The hub edge (verse → p3) provides a shortcut. If it's strong, you can jump directly; if not, the
sequential chain is a fallback.

### Cross-verse recall

Recall can span across verses. For example, recalling John 3:17 via 3:16:

```
ref(3:17) → ref(3:16) → verse(3:16) → ... → verse(3:17) → p1(3:17)
              ↑ trivial (R≈1.0)
```

The trivial ref↔ref edge ("3:17 is after 3:16") has near-infinite stability, so this path's
strength is essentially just "how well do I know 3:16 + the cross-verse transition."

## Review surfaces

A review surface is a **mask over the verse graph**: which atoms are **shown** (given as context)
and which are **hidden** (must be produced by the learner). Surfaces are not first-class memory
units — they are modes of testing that exercise subsets of edges.

### Surface definition

A surface is fully specified by: `shown = {set of atoms}`, `hidden = {set of atoms}`.

Example surfaces:

```
ref → verse:        shown = {ref}              hidden = {p1, p2, p3, p4}
verse → ref:        shown = {p1, p2, p3, p4}   hidden = {ref}
first words → rest: shown = {p1}               hidden = {p2, p3, p4}
fill-in-blank(p2):  shown = {ref, p1, p3, p4}  hidden = {p2}
cross-verse:        shown = {last phrase prev}  hidden = {p1, p2, p3, p4}
```

### Review interaction

1. The surface presents the shown atoms as the prompt.
2. The learner types the hidden atoms (the verse body, the reference, or a single phrase).
3. The app diffs the typed text against the source, aligned to phrase boundaries.
4. The learner manually grades each hidden phrase: Again / Hard / Good / Easy.
5. Per-phrase grades feed into the credit assignment algorithm (see below).

## Credit assignment

When a learner reviews a surface, each hidden atom receives a grade. From these grades, we must
determine how to update **every edge** in the graph — not just edges directly between shown and
hidden atoms, but all edges on all paths that could have participated in the recall.

### Observations

For each hidden atom h, the grade tells us:

* **Success** (Good/Easy): at least one path from a shown atom to h succeeded.
* **Failure** (Again): no path from any shown atom to h succeeded.
* **Partial** (Hard): a path succeeded but with difficulty.

### Algorithm

**Step 1: Enumerate paths.** For each (shown atom, hidden atom) pair, enumerate all paths through
the graph up to a maximum depth of **5 hops**. This includes paths through other verses via
cross-verse edges.

For surface ref→verse (shown={ref}, hidden={p1,p2,p3,p4}), paths to p2:

```
ref → verse → p2                              (2 hops, via hub)
ref → verse → p1 → p2                         (3 hops, sequential)
ref → verse → p3 → p2                         (3 hops, backward)
ref → n_ref → n_verse → verse → p2            (4 hops, cross-verse)
```

**Step 2: Compute path probabilities.** For each path:

```
R(path) = Π R(edge) for each edge in the path
```

**Step 3: Process successful atoms.** For a hidden atom graded Good/Easy:

* Eliminate paths that pass through any atom graded Again (those paths are broken).
* Weight surviving paths by their probability:

```
credit(path_i) = R(path_i) / Σ R(path_j)   for all surviving paths j
```

* Each edge on a surviving path receives credit proportional to that path's weight.

**Example:** p2 graded Good, p1 graded Again:

```
ref → verse → p2:         R = 0.85 × 0.90 = 0.765  ← viable
ref → verse → p1 → p2:    ELIMINATED (p1 failed)
ref → verse → p3 → p2:    R = 0.85 × 0.70 × 0.60 = 0.357  ← viable

credit(path_1) = 0.765 / (0.765 + 0.357) = 0.68
credit(path_2) = 0.357 / (0.765 + 0.357) = 0.32

Edge credits:
  ref → verse:   0.68 + 0.32 = 1.0  (on both paths — always credited)
  verse → p2:    0.68
  verse → p3:    0.32
  p3 → p2:       0.32
```

**Step 4: Process failed atoms.** For a hidden atom graded Again, all paths to it failed. Apply
HSRS-style Bayesian blame — the edge with the lowest R on each path was most likely the cause:

```
For each path, identify the weakest edge.
Aggregate blame across all paths: edges that are the weakest link on multiple paths
receive the most blame.
```

**Step 5: Apply FSRS updates.** For each edge:

```
total_weight = Σ (credit or blame from all observations involving this edge)
grade = weighted blend of grades from observations involving this edge

S_new = interpolate(S_old, S_fsrs(grade), total_weight)
```

Edges with high credit get a strong positive FSRS update. Edges with high blame get a strong
negative update. Edges barely involved get a weak update.

### Why this works

The reinforcement categories that might seem necessary to hand-code (shown→hidden = full,
hidden→hidden = strong, hidden→shown = medium, etc.) **emerge naturally from the path analysis**:

* Edges on short, high-probability paths get high credit ≈ full reinforcement
* Edges on longer, lower-probability paths get less credit ≈ medium reinforcement
* Edges not on any path between shown and hidden atoms get zero credit

The mask defines the observations. The graph defines the paths. The math handles the rest.

### Computational cost

Per review with a 5-hop depth limit: ~40 path enumerations × ~3 multiplications each ≈ 120
arithmetic operations, plus ~20 per-edge FSRS updates. Total: microseconds. The bottleneck is the
learner typing the verse (30+ seconds), not the scheduler or credit assignment.

## Lapses

A lapse occurs when an edge is graded Again — the learner could not produce the transition.

### Post-lapse update

FSRS has a dedicated post-lapse stability formula. S drops significantly but not to zero — prior
learning is partially preserved. D increases (the edge is harder than estimated).

### Re-drilling

When a phrase lapses during a review, the scheduler queues a **fill-in-the-blank surface** targeting
that specific edge later in the current session:

1. Complete the current review (grade all phrases).
2. Queue a fill-in-the-blank for the lapsed phrase after a few intervening reviews (within-session
   spacing).
3. If the re-drill succeeds, S starts recovering.
4. If it fails again, queue another re-drill with a longer gap.

Fill-in-the-blank is well-suited for re-drilling because it targets the weak edge precisely, without
requiring the learner to recite the entire verse.

## Phrase boundaries

Phrases are the nodes inside a verse. Their boundaries determine where the edges go and therefore
what the learnable units are.

**Default**: AI-generated phrase boundaries. KJV and other translations have consistent clause
structure (commas, semicolons, conjunctions) that LLMs segment reliably. A one-time content pipeline
chunks the entire Bible per translation.

**Override**: Phrase boundaries are editable per verse, per user or per editor. If a default
boundary feels wrong, it can be adjusted. This does not affect other users' graphs.

## Terminology

| Term                | Meaning in verse-vault                                                                                      |
| ------------------- | ----------------------------------------------------------------------------------------------------------- |
| **Atom / Node**     | A discrete piece of knowledge: a reference, a verse (latent), or a phrase                                   |
| **Edge**            | A directed cue→response association between two atoms. The unit of memory. Has its own FSRS state (S, D)    |
| **Surface / Card**  | A mask (shown/hidden) over the graph that defines a review mode. Not a memory unit itself                   |
| **Credit**          | The weight assigned to an edge after a successful observation, based on path analysis                       |
| **Blame**           | The weight assigned to an edge after a failed observation, based on Bayesian inference over paths            |
| **Verse graph**     | The full set of atoms and edges for one verse                                                               |
| **Chapter chain**   | Verse graphs connected by verse↔verse and ref↔ref edges                                                     |

## Grade blending for shared edges

When an edge participates in both successful and failed observations in the same review (e.g.,
ref→verse is on a failed path to p1 and a successful path to p2), the updates accumulate
additively. Each observation produces a weighted FSRS update (positive for success, negative for
failure). The net effect is the sum:

```
Δ_total = Σ (weight_i × FSRS_update(grade_i))
```

Positive paths push S up, negative paths push S down. An edge on mostly successful paths gets a
net positive update; an edge that is the weak link on a failed path gets a net negative update even
if it also participated in successful paths.

## Open questions

* **Chapter boundary atoms**: ref↔ref is hardcoded to R=1.0, but this breaks at chapter boundaries
  (e.g., John 3:36 → John 4:1 is not trivially sequential). Should we introduce chapter-boundary
  atoms or special-case these edges?
* **Phrase boundaries for non-KJV**: do phrase boundaries transfer across translations (same verse
  structure), or must each translation be chunked independently?
