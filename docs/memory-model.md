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

| Node type       | What it represents                                                       | Directly testable?                              | Example                         |
| --------------- | ------------------------------------------------------------------------ | ----------------------------------------------- | ------------------------------- |
| **Phrase**       | A chunk of verbatim text within a verse                                  | Yes (recite it)                                 | "For God so loved the world,"   |
| **Verse gist**   | The gist/identity of a verse — what it's about, where it sits in context | No — latent atom, updated only through coupling | [semantic anchor for Acts 2:3]  |
| **Reference**    | The verse citation                                                       | Yes (recite it, identify it)                    | "Acts 2:3"                      |
| **Club entry**   | A verse's membership in a club tier, forming a chain with other entries  | Indirectly — tested via club listing surfaces   | "Acts 2:1 is in club 150"      |
| **Chapter gist** | A material section's identity (may not start at verse 1)                 | No — structural source node for listing surfaces | [semantic anchor for Acts 2]   |
| **Chapter ref**  | The chapter citation                                                     | Yes (recite it)                                 | "Acts 2"                        |

The **verse gist** is a non-testable hub that:

* Connects the reference to the phrase chain (ref ↔ verse ↔ phrases)
* Connects consecutive verses (verse ↔ verse)
* Separates **gist memory** ("I know what this verse is about") from **verbatim memory** ("I can
  recite the exact words")
* Has its own FSRS state that evolves through coupling

The **chapter gist** is a structural source node that:

* Connects to the chapter's club entries (outgoing only) for listing surfaces
* Receives incoming edges from verse gists ("this verse is in this chapter")
* Cannot be traversed INTO from club entries or other chapters — prevents shortcut paths
* Does not need FSRS state (never a target of credit assignment)

There are **no direct edges between references and phrases**. All ref-to-phrase paths route through
the verse gist.

### Edge types

Edges are either **bidirectional** (each direction tracked separately with its own S, D) or
**unidirectional** (only one direction exists). All edges are learnable (tracked by FSRS). There
are **no hardcoded R=1.0 edges** anywhere in the graph.

| Edge                                 | Direction | Represents                                                  |
| ------------------------------------ | --------- | ----------------------------------------------------------- |
| phrase ↔ phrase (sequential)         | **bi**    | "this phrase leads to/comes from that phrase"                |
| phrase ↔ verse gist (hub)            | **bi**    | "this phrase belongs to/comes from this verse"               |
| verse gist ↔ reference              | **bi**    | "I know this verse's reference" / "I know what this ref is"  |
| verse gist ↔ verse gist (chapter-consecutive) | **bi** | "this verse comes after/before that verse"             |
| reference ↔ club entry              | **bi**    | "this reference is in this club" / "this club entry is this ref" |
| verse gist → chapter gist           | **uni**   | "this verse is in this chapter" (verse knows its chapter)    |
| chapter gist ↔ chapter ref          | **bi**    | "this chapter is called Acts 2" / "Acts 2 is this chapter"  |
| chapter gist → club entry           | **uni**   | "this chapter has this club entry" (for listing surfaces)    |
| club entry → club entry (chain)     | **uni**   | "the next verse in this club's sequence"                     |

### Edge directionality rationale

Unidirectional edges prevent shortcuts while preserving useful recall paths:

* **verse gist → chapter gist** (not reverse): given a verse, you can recall its chapter. But the
  chapter gist should not directly point to individual verses — that would create shortcuts between
  club entries and verses through the chapter gist. Listing goes through club entries instead.

* **chapter gist → club entry** (not reverse): the chapter gist needs to reach club entries for
  listing surfaces. The reverse is unnecessary because club_entry → ref → verse_gist → chapter_gist
  already exists as a 3-hop path through bidirectional edges.

* **club entry → club entry** (chain, not reverse): the chain represents "what's the next 150
  verse," a forward sequence. Reverse traversal ("what was the previous 150 verse") could be added
  later if needed.

### Reference model

A verse's reference (e.g., "Acts 2:3") is composed of two pieces of knowledge:

1. **Chapter**: which chapter the verse is in (verse gist → chapter gist → chapter ref)
2. **Verse number**: the position within the chapter

The verse number can be recalled two ways:

* **Direct recall**: the verse→ref edge is strong — "I just know this is Acts 2:3"
* **Anchor-derived**: count the chain distance from a verse whose reference IS known, then apply
  arithmetic. Any reachable verse→ref edge serves as an anchor.

```
"What's the reference for verse(2:3)?"

Direct:      verse(2:3) → ref(2:3)                              just know it
Via anchor:  verse(2:3) → verse(2:2) → verse(2:1) → ref(2:1)   count 2 hops from anchor
             ref(2:1) = "Acts 2:1", 2:1 + 2 = 2:3              arithmetic (free)
```

Every verse has a ref atom and a verse→ref edge, but the edge may start with low stability for
unstudied verses. Nearby anchors provide backup paths. Over time, repeated review strengthens the
direct edge and the learner transitions from "counting from an anchor" to "just knowing."

See **Anchor transfer** in the Credit assignment section for how this integrates with path
computation.

### Graph structure

For two consecutive verses with club 150 membership:

```
chapter_ref("Acts 2") ↔ chapter_gist
                            |  \
                            |   ↓
                            |  club_150_entry(2:1) → club_150_entry(2:4)
                            |       |                      |
    ref(2:1)    ref(2:4)    |       |                      |
       ↕           ↕        ↓       ↓                      ↓
    verse1  ──  verse2 ─────↗──────↗
     / | \       / | \
    p1─p2─p3   p4─p5─p6

Edge key:
  ↔  bidirectional        →  unidirectional
  ──  verse-verse bi      ↗  verse→chapter_gist uni
```

Each verse gist hub-connects (bi) to **all** of its phrases. Chapter-consecutive verse↔verse edges
are bidirectional. Verse gists point to the chapter gist (uni). The chapter gist points to club
entries (uni). Club entries point to next entries (uni chain) and connect to refs (bi).

### Club structure

QuizMeet has three competition tiers: **full material** (all verses), **club 300** (a specific
300 verses), and **club 150** (a specific 150 verses, subset of 300). Club 150 ⊂ Club 300 ⊂ full
material. Most chapters have 3–7 club-150 verses and 6–14 club-300 verses.

Club membership is modeled with **per-verse club entry atoms** that chain together:

```
chapter_gist ──→ club_150_entry(2:1) ──→ club_150_entry(2:4) ──→ club_150_entry(2:7)
                       ↕                        ↕                        ↕
                    ref(2:1)                 ref(2:4)                 ref(2:7)
                       ↕                        ↕                        ↕
                    verse(2:1)               verse(2:4)               verse(2:7)
```

Each club entry atom connects to:
* Its **reference** (bidirectional — "this club entry is Acts 2:1" / "Acts 2:1 is a club entry")
* The **next club entry** in the chapter sequence (unidirectional chain)

The chapter gist points to club entries (unidirectional) for listing surfaces. Club entries connect
to their verse gists indirectly through their references (club_entry ↔ ref ↔ verse_gist).

**Membership** is implicit: a verse has a club entry atom = it's in the club.

**Sequence**: the chain between club entry atoms represents "what's the next 150 verse."

**Why club entries are separate atoms** (not edges on verse gists):
* Avoids creating verse↔verse shortcuts that could give false anchor transfer credit
* The club sequence is meta-knowledge about the verse list, not verse content flow
* Keeps the verse gist chain clean: verse↔verse edges only represent chapter-consecutive flow

**Listing surfaces**: "which 150 verses in Acts 2?" uses shown={chapter_gist(Acts 2)}, hidden
={ref(2:1), ref(2:4), ref(2:7), ...}. Paths go chapter_gist → club_entry → ref. All entries are
1 hop from the chapter gist (equidistant), each reaching its ref in 1 more hop.

For long chapters with many club verses, Woźniak's complexity formula naturally prevents the
scheduler from requesting the full list — it will prefer targeted surfaces over listing all at
once.

Club 300 entries include all 300 verses (including the 150 subset). A verse in club 150 has both
a club_150_entry and a club_300_entry.

### Edge inventory per verse

For a verse with N phrases:

| Edge type                          | Count (undirected) | Count (directed) |
| ---------------------------------- | ------------------ | ---------------- |
| phrase ↔ phrase (sequential)       | N-1                | 2(N-1)           |
| phrase ↔ verse gist (hub)          | N                  | 2N               |
| verse gist ↔ ref                   | 1                  | 2                |
| verse gist ↔ next verse (chapter)  | 1                  | 2                |
| verse gist → chapter gist          | —                  | 1                |
| **Total (base)**                   | —                  | **4N + 3**       |

Additional edges for club members:

| Edge type                           | Count (directed) |
| ----------------------------------- | ---------------- |
| ref ↔ club_entry (per club tier)    | 2–4              |
| club_entry → next entry (per tier)  | 1–2              |
| chapter_gist → club_entry (per tier)| 1–2              |

For N=4 phrases: 19 base directed edges + up to 8 club edges = ~27 per verse.
For a 500-verse QuizMeet season: ~9,500 base + ~1,200 club edges ≈ 11,000 directed edges total.
Each learnable edge stores (S, D, last_review_time). Trivially tractable.

### Edge state

Each directed learnable edge stores:

* **Stability (S)**: days for retrievability to decay from 1.0 to 0.9
* **Difficulty (D)**: intrinsic difficulty, real number in [1, 10]
* **last_review_time**: timestamp of last update

**Retrievability (R)** is computed on the fly: `R = (1 + t / (9 · S))^(-1)` where t is elapsed days
since last review. No need to store R or due dates — the computation is trivial and avoids stale
precomputed values.

Unidirectional structural edges (chapter_gist → club_entry, chapter_gist → verse connections used
only for listing) do not need FSRS state — they are traversal-only.

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

The strongest path dominates. Verses memorized in context (sequential chapters) are easier to
maintain than isolated verses — the cross-verse edges create redundant paths.

### Cross-verse recall

Recall can span across verses through the verse chain:

```
verse(3:17) → verse(3:16) → ref(3:16) = "John 3:16"
  anchor transfer: 3:16 + 1 = 3:17
```

Sequential reference knowledge is captured by: learnable verse↔verse chain edge + learnable
verse↔ref anchor edge + arithmetic via anchor transfer. No hardcoded edges needed.

## Review surfaces

A review surface is a **mask over the verse graph**: which atoms are **shown** (given as context)
and which are **hidden** (must be produced by the learner). Surfaces are not first-class memory
units — they are modes of testing that exercise subsets of edges.

### Surface definition

A surface is fully specified by: `shown = {set of atoms}`, `hidden = {set of atoms}`.

Example surfaces:

```
ref → verse:        shown = {ref}                     hidden = {p1, p2, p3, p4}
verse → ref:        shown = {p1, p2, p3, p4}          hidden = {ref}
first words → rest: shown = {p1}                      hidden = {p2, p3, p4}
fill-in-blank(p2):  shown = {ref, p1, p3, p4}         hidden = {p2}
cross-verse:        shown = {last phrase prev}         hidden = {p1, p2, p3, p4}
club listing:       shown = {chapter_gist(Acts 2)}     hidden = {ref(2:1), ref(2:4), ref(2:7)}
```

### Review interaction

1. The surface presents the shown atoms as the prompt.
2. The learner types the hidden atoms.
3. The app diffs the typed text against the source, aligned to phrase boundaries.
4. The learner manually grades each hidden atom: Again / Hard / Good / Easy.
5. Per-atom grades feed into the credit assignment algorithm.

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
the graph up to a maximum depth of **5 hops**. Paths follow edge directionality — unidirectional
edges can only be traversed in their defined direction.

**Step 2: Compute path probabilities.** For each path:

```
R(path) = Π R(edge) for each edge in the path
```

Structural edges (no FSRS state) contribute R = 1.0 to path probability but cannot receive
credit or blame.

**Step 3: Process successful atoms.** For a hidden atom graded Good/Easy:

* Eliminate paths that pass through any atom graded Again (those paths are broken).
* Weight surviving paths by their probability:

```
credit(path_i) = R(path_i) / Σ R(path_j)   for all surviving paths j
```

* Each learnable edge on a surviving path receives credit proportional to that path's weight.

**Step 4: Process failed atoms.** For a hidden atom graded Again, all paths to it failed. Apply
Bayesian blame — the edge with the lowest R on each path was most likely the cause:

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

### Anchor transfer

When the hidden atom is a **reference**, the credit assignment extends path enumeration with
anchor transfer: a path does not need to reach the exact target ref — it can reach ANY ref atom
in the graph, and the arithmetic derivation (target_number = anchor_number ± chain_distance) is
modeled as a **distance-based decay**.

```
effective_R(path) = R(path_to_anchor_ref) × distance_decay(|target_num - anchor_num|)

where distance_decay(d) = factor^d    (tunable, e.g., factor = 0.95)
```

Distance decay values (at factor = 0.95):

| Distance (d) | Decay   | Meaning                                    |
| ------------- | ------- | ------------------------------------------ |
| 0             | 1.00    | Direct recall — path reaches the target ref itself |
| 1             | 0.95    | One verse away — minimal arithmetic        |
| 2             | 0.90    | Two verses — easy counting                 |
| 5             | 0.77    | Five verses — moderate mental effort        |
| 10            | 0.60    | Ten verses — significant counting           |

**Example: recalling ref(2:3), direct edge is weak:**

```
Direct:       verse(2:3) → ref(2:3)                        R = 0.30 × decay(0) = 0.30
Via ref(2:1): verse(2:3) → v(2:2) → v(2:1) → ref(2:1)     R = 0.81 × 0.85 × decay(2) = 0.62
Via ref(2:4): verse(2:3) → v(2:4) → ref(2:4)               R = 0.80 × 0.70 × decay(1) = 0.53

Parallel: R_total = 1 - (1-0.30)(1-0.62)(1-0.53) = 0.875
```

The weak direct edge is compensated by strong nearby anchors. Credit flows to the chain edges
and anchor ref edges that made the derivation possible.

**Why anchor transfer only applies to refs:** References are numbers, and numbers support
arithmetic (±N). Other atom types (phrases, verse gists, club membership) cannot be derived from
neighbors via arithmetic.

**Counting requires the chapter-consecutive chain:** A 150 quizzer using club entries
(club_entry(2:1) → club_entry(2:4), 1 hop) doesn't know the chapter-distance is 3. To count
from ref(2:1) to ref(2:4), they'd need the chapter-consecutive verse chain
(verse(2:1)→verse(2:2)→verse(2:3)→verse(2:4), 3 hops). If those intermediate edges have low R
(unreviewed), the anchor transfer path is naturally weak. Full-material quizzers with strong
chapter-consecutive edges get anchor transfer as a strong backup.

### Computational cost

Per review with a 5-hop depth limit: ~40 path enumerations × ~3 multiplications each ≈ 120
arithmetic operations, plus ~20 per-edge FSRS updates. Anchor transfer adds a multiplication per
ref-targeting path. Total: microseconds.

## Grade blending for shared edges

When an edge participates in both successful and failed observations in the same review, the
updates accumulate additively. Each observation produces a weighted FSRS update (positive for
success, negative for failure). The net effect is the sum:

```
Δ_total = Σ (weight_i × FSRS_update(grade_i))
```

Positive paths push S up, negative paths push S down.

## Lapses

A lapse occurs when an edge is graded Again — the learner could not produce the transition.

### Post-lapse update

FSRS has a dedicated post-lapse stability formula. S drops significantly but not to zero — prior
learning is partially preserved. D increases (the edge is harder than estimated).

### Re-drilling

When a phrase lapses during a review, the scheduler queues a **fill-in-the-blank surface** targeting
that specific edge later in the current session:

1. Complete the current review (grade all phrases).
2. Queue a fill-in-the-blank for the lapsed phrase after a few intervening reviews.
3. If the re-drill succeeds, S starts recovering.
4. If it fails again, queue another re-drill with a longer gap.

## Phrase boundaries

Phrases are the nodes inside a verse. Their boundaries determine where the edges go.

**Default**: AI-generated phrase boundaries. KJV and other translations have consistent clause
structure that LLMs segment reliably. A one-time content pipeline chunks the entire Bible per
translation.

**Override**: Phrase boundaries are editable per verse, per user or per editor.

## Terminology

| Term                | Meaning in verse-vault                                                                                   |
| ------------------- | -------------------------------------------------------------------------------------------------------- |
| **Atom / Node**     | A piece of knowledge: phrase, verse gist (latent), reference, chapter gist, chapter ref, or club entry   |
| **Edge**            | A directed association between two atoms. Learnable edges have FSRS state (S, D). Structural edges have no state |
| **Surface / Card**  | A mask (shown/hidden) over the graph that defines a review mode. Not a memory unit itself                |
| **Credit**          | The weight assigned to an edge after a successful observation, based on path analysis                    |
| **Blame**           | The weight assigned to an edge after a failed observation, based on Bayesian inference                   |
| **Anchor**          | A verse whose reference is directly known (strong verse→ref edge). Used to derive nearby refs            |
| **Anchor transfer** | Computing a target ref from a nearby anchor ref via chain distance + arithmetic, with distance decay     |
| **Verse graph**     | The full set of atoms and edges for one verse                                                            |
| **Chapter chain**   | Verse graphs connected by chapter-consecutive verse↔verse edges                                          |
| **Club chain**      | Club entry atoms connected sequentially, representing a club tier's verse order within a chapter          |

## Open questions

* **Chapter boundary modeling**: material sections may not start at verse 1. How should section
  start/end be represented — as properties on the chapter gist, or as edges to specific verses?
* **Anchor transfer decay factor**: the 0.95 default is a starting point. Should it be tunable per
  user, or fixed? Should it vary by context (e.g., lower decay within a well-studied chapter)?
* **Phrase boundaries for non-KJV**: do phrase boundaries transfer across translations, or must
  each translation be chunked independently?
* **Reverse club chain**: should club_entry chains be bidirectional (enabling "what was the previous
  150 verse?") or is the forward-only chain sufficient?
