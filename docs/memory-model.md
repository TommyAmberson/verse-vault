# Verse-Vault Memory Model

## Overview

Verse-Vault uses an edge-based memory graph to model how scripture is learned and recalled. The core
insight: **memory is not about knowing isolated facts — it is about transitions between pieces of
information.** The unit of memory is not "I know phrase X" but "given cue X, I can produce Y."

Each transition (edge) carries its own spaced-repetition state (Stability, Difficulty,
Retrievability) tracked via the FSRS algorithm, with HSRS-style Bayesian coupling so that reviewing
a composite (e.g., an entire verse) propagates updates to all edges exercised in the recall.

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

The **verse node** is the key architectural choice. It is a non-testable hub that:

* Connects the reference to the phrase chain (ref ↔ verse ↔ phrases)
* Connects consecutive verses (verse ↔ verse)
* Separates **gist memory** ("I know what this verse is about") from **verbatim memory** ("I can
  recite the exact words")
* Has its own FSRS state that evolves through coupling, representing how well the learner "knows"
  the verse at an abstract level

### Edge types

Every edge is **bidirectional** — each direction is tracked as a separate memory with its own (S, D,
R) state. "John 3:16 → first phrase" and "first phrase → John 3:16" are two different memories.

| Edge            | Represents                                                                    | Stability profile                                                         |
| --------------- | ----------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| ref ↔ verse     | "I know what this reference is about" / "I know the reference for this verse" | Medium — decays if not reviewed                                           |
| verse ↔ phrase  | "this phrase belongs to/comes from this verse"                                | High — exercised on every review of the verse                             |
| phrase ↔ phrase | "this phrase leads to/comes from that phrase" (verbatim sequential order)     | Variable — the core of verbatim recall                                    |
| verse ↔ verse   | "this verse comes after/before that verse"                                    | Medium — cross-verse context                                              |
| ref ↔ ref       | "these references are sequential"                                             | Very high / trivial — "3:17 comes after 3:16" is near-permanent knowledge |

### Graph structure

For two consecutive verses, the graph looks like:

```
ref(3:16) ―― ref(3:17)                      sequential references (trivial, S≈∞)
    |              |
 verse1    ――   verse2                       cross-verse context
  / | \          / | \
 p1─p2─p3      p4─p5─p6                     phrase chains (verbatim)
```

Where each verse node also hub-connects to all of its phrases (verse1 ↔ p1, verse1 ↔ p2, verse1 ↔
p3).

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
~10,000 directed edges, each storing 3 floats (S, D, R). Trivially tractable.

## Composite retrievability

### Serial composition (within a chain)

When recall requires traversing a chain of edges (e.g., ref → verse → p1 → p2 → p3), all edges must
fire:

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
fewer reviews.

### Example: recalling phrase 3 given the reference

```
Path A (sequential):  ref → verse → p1 → p2 → p3
Path B (hub direct):  ref → verse → p3

R_total = 1 - (1 - R_a)(1 - R_b)
```

The hub edge (verse → p3) provides a shortcut. If it's strong, you can jump directly; if not, the
sequential chain is a fallback.

### Cross-verse recall via verse hubs

To recall the start of verse 2 after finishing verse 1:

```
p3(v1) → verse1 → verse2 → p1(v2)
```

This path goes through the verse-level abstraction rather than requiring a direct phrase-to-phrase
cross-verse edge. The hub edges (verse ↔ phrase) have high stability from frequent exercise, so this
path is strong in practice.

## Review surfaces

Review surfaces are not first-class memory units — they are **modes of testing** that exercise
specific subsets of edges in the graph. The same underlying edges can be tested through different
surfaces.

### Current surfaces (matching existing Anki card types)

| Surface                | Prompt            | Tests edges                                | Tested direction                                 |
| ---------------------- | ----------------- | ------------------------------------------ | ------------------------------------------------ |
| **ref → verse**        | Show reference    | ref→verse, verse→p1, p1→p2, ..., p(n-1)→pn | Forward chain from reference through all phrases |
| **verse → ref**        | Show verse body   | p1→verse, p2→verse, ..., verse→ref         | Phrases → verse hub → reference                  |
| **first words → rest** | Show first phrase | p1→p2, p2→p3, ..., p(n-1)→pn               | Forward chain skipping the ref→verse link        |

### Future surfaces (examples)

| Surface                         | Tests                                                        |
| ------------------------------- | ------------------------------------------------------------ |
| **Random phrase → context**     | Given a phrase, identify the verse and surrounding phrases   |
| **Cross-verse continuation**    | Given the end of verse N, continue into verse N+1            |
| **Reference → specific phrase** | "What's the middle of John 3:16?" — tests hub edges directly |

## HSRS-style coupling

When a composite review occurs (e.g., reciting a whole verse), the update propagates to every edge
exercised in the recall, using HSRS's Bayesian blame mechanism.

### On success (all edges in the chain fired)

Each exercised edge receives a standard FSRS stability update. Stability increases across the board.

### On failure (the chain broke somewhere)

The learner identifies where they got stuck (see Review Interaction below). The Bayesian blame
mechanism concentrates the stability penalty on the weak link:

```
For each edge i in the chain:
  p_i = (1 - R_i) / (1 - Π R_j)      ← posterior probability this edge caused the failure
  
  S_i_new = interpolate(S_i_old, S_i_fsrs_update, p_i)
```

Edges with low current retrievability receive most of the blame. Edges the learner clearly got right
receive minimal penalty.

### Latent atom updates

The verse node is never directly tested but participates in every review chain that passes through
it (which is all of them — every surface goes through the verse hub). Its stability evolves as a
natural byproduct of the coupling mechanism, representing a stable "gist memory" that outlasts
verbatim phrase recall.

## Review interaction

The primary review flow is **type-and-diff with per-phrase grading**:

1. A review surface presents the prompt (e.g., the reference).
2. The learner types the response (the verse body).
3. The app diffs the typed text against the source, aligned to phrase boundaries.
4. The learner manually grades each phrase (Again / Hard / Good / Easy).
5. Per-phrase grades feed into the HSRS coupling update for each edge in the chain.

This gives exact per-edge signal: the app knows which transitions the learner got right and which
they didn't, without sacrificing the "recite the whole verse" experience.

## Phrase boundaries

Phrases are the nodes inside a verse. Their boundaries determine where the edges go and therefore
what the learnable units are.

**Default**: AI-generated phrase boundaries. KJV and other translations have consistent clause
structure (commas, semicolons, conjunctions) that LLMs segment reliably. A one-time content pipeline
chunks the entire Bible per translation.

**Override**: Phrase boundaries are editable per verse, per user or per editor. If a default
boundary feels wrong, it can be adjusted. This does not affect other users' graphs.

## Terminology

| Term                         | Meaning in verse-vault                                                                                      |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------- |
| **Atom / Node**              | A discrete piece of knowledge: a reference, a verse (latent), or a phrase                                   |
| **Edge**                     | A directed cue→response association between two atoms. The unit of memory. Has its own FSRS state (S, D, R) |
| **Knowledge Component (KC)** | Academic term for the same concept as an edge — the atomic unit of what's being learned                     |
| **Surface / Card**           | A review mode that exercises a subset of edges. Not a memory unit itself                                    |
| **Verse graph**              | The full set of atoms and edges for one verse                                                               |
| **Chapter chain**            | Verse graphs connected by verse↔verse and ref↔ref edges                                                     |

## Open questions

* **Backward sequential edges**: phrase_2 → phrase_1 (backward recall) — are these worth tracking,
  or is backward recitation not a real use case?
* **Hub edge granularity**: does every phrase connect to the verse node, or only the first/last?
* **Cross-verse edge threshold**: should verse↔verse edges only be created between
  consecutively-memorized verses, or between all verses in a chapter regardless of whether they've
  been studied?
* **Trivial edge handling**: should near-permanent edges (ref↔ref sequential) be modeled with real
  FSRS state, or hardcoded as R=1.0 to avoid wasting computation?
* **Phase boundaries for non-KJV**: do phrase boundaries transfer across translations (same verse
  structure), or must each translation be chunked independently?
