# Memory Graph

Verse-Vault models scripture memorization as a directed graph where **edges are the unit of
memory**. The core insight: memory is not about knowing isolated facts — it is about transitions
between pieces of information. "Given cue X, I can produce Y" is one edge, tracked with its own
spaced-repetition state.

Each edge stores Stability (S), Difficulty (D), and last_review_time. Retrievability is computed on
demand from the FSRS-6 forgetting curve (see [review.md](review.md) and
`crates/core/src/fsrs_bridge.rs`).

## Retrieval-edge framing

An edge is a **testable retrieval proposition**. When deciding whether an edge should exist between
two atoms X and Y, ask:

> If I'm thinking about X, is "produce Y" a retrieval with a unique, gradable answer?

If the answer is a definite unique Y, the edge is valid. If Y is ambiguous, non-existent, or a list
of many items, the edge does not exist — the relationship is either expressed via a proper atom that
lets the listing become a sequence of single retrievals (see `ChapterClubMember`), or not modeled in
the graph at all.

**Every edge is learnable.** There are no structural edges — each edge carries FSRS state. This was
not always true: the original design had one `ChapterGistClubEntry` structural edge to support club
listings from a chapter, but that role was replaced by proper `ChapterClubMember` atoms when the
club hierarchy was fleshed out.

## Theoretical grounding

* **Paired-associate learning**: memory is stored as cue→response associations.
* **Woźniak's memory complexity** (2005): composite stability follows `1/S = 1/S_a + 1/S_b`. Long
  items as single cards have stability collapsing toward zero. Decomposition into smaller
  cue→response pairs is theoretically required.

## Atoms (node types)

| Atom                  | Testable?                         | Purpose                               |
| --------------------- | --------------------------------- | ------------------------------------- |
| **Phrase**            | yes                               | "For God so loved the world,"         |
| **VerseGist**         | no — latent, updated via coupling | [meaning of Acts 2:3]                 |
| **VerseRef**          | yes                               | "verse 3 within the chapter"          |
| **ChapterGist**       | no — chapter-level hub            | [meaning of Acts 2]                   |
| **ChapterRef**        | yes                               | "chapter 2"                           |
| **BookGist**          | no — book-level hub               | [meaning of Acts]                     |
| **BookRef**           | yes                               | "Acts"                                |
| **Heading**           | yes                               | "All to the Glory of God"             |
| **ClubGist**          | no — per-tier hub                 | concept of "club 150" / "club 300"    |
| **VerseClubMember**   | indirectly                        | "verse X is a member of club N"       |
| **ChapterClubMember** | indirectly                        | "chapter C has club-N presence"       |
| **HeadingClubMember** | indirectly                        | "section H has club-N presence"       |
| **Ftv**               | no — cue only, never recalled     | first few words that identify a verse |

**VerseRef carries the verse-number fact only.** The struct keeps `chapter` and `verse` fields for
atom uniqueness, but the retrieval the atom represents is "which verse within the chapter." The
chapter part is a separate atom (`ChapterRef`), and the book is yet another (`BookRef`). See the
per-component grading section below.

**Gist atoms are routing hubs.** They are never the visible answer on a card, but participate in
credit-assignment paths. A `VerseGist`'s edges get updated whenever reviews involve atoms that
connect through it.

**`*ClubMember` atoms represent membership at a given layer.** The atom's existence is the fact.
There is one `VerseClubMember` per (tier, verse) pair where the verse is in the tier, one
`ChapterClubMember` per (tier, chapter) where the chapter contains any member of that tier, and
similarly for headings. Deleting a member atom is how you'd remove club membership.

**`Ftv` (Finish This Verse)** is the unique first words that identify a verse for quiz purposes.
Optional — only created when the FTV text is ≤ 5 words. A pure cue node with unidirectional edges
outward only (ftv → first phrase, ftv → verse gist). You never recall the FTV; it's given as a
prompt.

## The layered pattern

Every containment layer (book → chapter → verse, and the parallel club-membership hierarchies) has
the same five-edge shape:

| Pattern                        | Direction | Example                                |
| ------------------------------ | --------- | -------------------------------------- |
| gist ↔ ref                     | bi        | `ChapterGistChapterRef`                |
| child_gist → parent_gist       | uni       | `VerseGistChapterGist`                 |
| parent_gist → first_child_gist | uni       | `ChapterGistFirstVerseGist`            |
| parent_gist → last_child_gist  | uni       | `ChapterGistLastVerseGist`             |
| parent-consecutive gist ↔ gist | bi        | `ChapterGistChapterGist` (within book) |
| child_ref → parent_ref         | uni       | `VerseRefChapterRef`                   |

Child→parent is always a unique retrieval ("which chapter is this verse in?"). Parent→child is only
unique via the endpoint edges ("what's the first verse of this chapter?") — there's no
`ChapterGist → some_verse_gist` for arbitrary verses because it's non-unique.

## Edge inventory (43 kinds)

### Phrase / verse layer

| Edge                 | Shape | Role                                   |
| -------------------- | ----- | -------------------------------------- |
| `PhrasePhrase`       | bi    | sequential phrase chain within a verse |
| `PhraseVerseGist`    | bi    | hub between phrase and verse gist      |
| `VerseGistVerseRef`  | bi    | verse gist ↔ verse ref                 |
| `VerseGistVerseGist` | bi    | chapter-consecutive verse chain        |

### Chapter layer

| Edge                        | Shape | Role                           |
| --------------------------- | ----- | ------------------------------ |
| `ChapterGistChapterRef`     | bi    | chapter gist ↔ ref             |
| `VerseGistChapterGist`      | uni   | verse knows its chapter        |
| `ChapterGistFirstVerseGist` | uni   | first verse of this chapter    |
| `ChapterGistLastVerseGist`  | uni   | last verse of this chapter     |
| `VerseRefChapterRef`        | uni   | "Acts 2:3" → "Acts 2"          |
| `ChapterGistChapterGist`    | bi    | book-consecutive chapter chain |

### Book layer

| Edge                       | Shape | Role                            |
| -------------------------- | ----- | ------------------------------- |
| `BookGistBookRef`          | bi    | book gist ↔ ref                 |
| `ChapterGistBookGist`      | uni   | chapter knows its book          |
| `BookGistFirstChapterGist` | uni   | first chapter of this book      |
| `BookGistLastChapterGist`  | uni   | last chapter of this book       |
| `ChapterRefBookRef`        | uni   | "Acts 2" → "Acts"               |
| `BookGistBookGist`         | bi    | material-consecutive book chain |

### Heading layer

| Edge                    | Shape | Role                                        |
| ----------------------- | ----- | ------------------------------------------- |
| `VerseGistHeading`      | uni   | verse knows its section                     |
| `HeadingHeading`        | bi    | section-to-section chain (within-book only) |
| `HeadingFirstVerseGist` | uni   | first verse in section's range              |
| `HeadingLastVerseGist`  | uni   | last verse in section's range               |

Heading layer routes **through verses** to reach chapter/book
(`heading → first_verse_gist → chapter_gist → book_gist`). There are no direct
`heading → chapter_gist` or `heading → book_gist` edges. This keeps the graph narrow; book-scoping
is a graph-building invariant rather than an edge.

### Club hierarchy (verse + chapter)

| Edge                                    | Shape | Role                                  |
| --------------------------------------- | ----- | ------------------------------------- |
| `VerseRefVerseClubMember`               | bi    | "is this verse in club N?"            |
| `VerseClubMemberVerseClubMember`        | bi    | prev/next verse in same tier          |
| `VerseClubMemberClubGist`               | uni   | which club is this member in          |
| `VerseClubMemberChapterClubMember`      | uni   | which chapter-membership am I part of |
| `ChapterRefChapterClubMember`           | bi    | chapter ↔ its club-presence atom      |
| `ChapterClubMemberChapterClubMember`    | bi    | prev/next chapter with club presence  |
| `ChapterClubMemberClubGist`             | uni   | which club                            |
| `ChapterClubMemberFirstVerseClubMember` | uni   | first verse-member in this chapter    |
| `ChapterClubMemberLastVerseClubMember`  | uni   | last verse-member in this chapter     |
| `ClubGistFirstVerseClubMember`          | uni   | first verse of whole club             |
| `ClubGistLastVerseClubMember`           | uni   | last verse of whole club              |
| `ClubGistFirstChapterClubMember`        | uni   | first chapter with club presence      |
| `ClubGistLastChapterClubMember`         | uni   | last chapter with club presence       |

### Heading-club hierarchy

Same shape as chapter-club, applied at the section level.

| Edge                                    | Shape | Role                                    |
| --------------------------------------- | ----- | --------------------------------------- |
| `HeadingHeadingClubMember`              | bi    | section ↔ its club-presence atom        |
| `HeadingClubMemberHeadingClubMember`    | bi    | prev/next section with club presence    |
| `HeadingClubMemberClubGist`             | uni   | which club                              |
| `VerseClubMemberHeadingClubMember`      | uni   | verse-member → section-level membership |
| `HeadingClubMemberFirstVerseClubMember` | uni   | first verse-member in section           |
| `HeadingClubMemberLastVerseClubMember`  | uni   | last verse-member in section            |
| `ClubGistFirstHeadingClubMember`        | uni   | first section with club presence        |
| `ClubGistLastHeadingClubMember`         | uni   | last section with club presence         |

**Why section-level atoms matter.** In long chapters (Luke 1, ~80 verses across many sections),
quizzers don't hold "the club-150 verses in Luke 1" as a single flat list. They mentally bucket by
section ("these are my 150s in the Annunciation; these are mine in the Visitation; …").
`HeadingClubMember` makes that section-scoped navigation an explicit retrieval the graph can test
and reinforce.

### FTV

| Edge           | Shape | Role                   |
| -------------- | ----- | ---------------------- |
| `FtvPhrase`    | uni   | FTV cue → first phrase |
| `FtvVerseGist` | uni   | FTV cue → verse gist   |

## Card coupling (design intent)

When card generation code lands, it should enforce these co-presence rules so grading and credit
assignment have the right source atoms:

* **Ref-chain coupling**: whenever a `VerseRef` is in `shown` or `hidden`, add its `ChapterRef`.
  Whenever `ChapterRef` is present, add its `BookRef`. Transitively, any `VerseRef` pulls all three
  refs together.
* **Club-gist coupling**: whenever any `*ClubMember` atom is in `shown` or `hidden`, add its
  `ClubGist`. Listing cards that hide verse-members are automatically sourced from the club tier.
* Do **not** auto-add chapter/heading `*ClubMember` atoms when a verse-member appears — those are
  hub atoms, not transitively present.

These rules are not yet implemented in code; they're documented here as the design contract for the
eventual card generator.

## Per-component grading (design intent)

Verse references are graded per-component, not as a single string:

| Typed (for "Acts 2:3") | book_ref | chapter_ref | verse_ref | Interpretation                    |
| ---------------------- | -------- | ----------- | --------- | --------------------------------- |
| "Acts 2:3"             | Pass     | Pass        | Pass      | clean recall                      |
| "Acts 2:4"             | Pass     | Pass        | Again     | right chapter, wrong verse number |
| "Acts 3:3"             | Pass     | Again       | Pass      | right verse fact, wrong chapter   |
| "John 2:3"             | Again    | Pass        | Pass      | wrong book, position facts held   |
| "Matthew 5:16"         | Again    | Again       | Again     | lost everything                   |

The "John 2:3" row is where the decomposition earns its keep: the learner's
`phrase → verse_gist → verse_ref` and `phrase → verse_gist → chapter_gist → chapter_ref` chains
produced the right numeric facts — they just lost book context. The graph tracks this as three
independent signals rather than collapsing to a single pass/fail.

This grading decomposition happens at the app layer (client-side typed-answer parser). It's not
implemented today; documented here for when the frontend lands.

## Tier-subset rule (Anki import)

The Anki export tags quiz verses with a single tier: a verse is marked "150" or "300". Because club
150 is a subset of club 300, a verse tagged "150" implicitly belongs to both tiers.

The builder enforces this via `expand_tiers()` in `crates/core/src/builder.rs`: a raw `clubs: [150]`
expands to `[Club150, Club300]` and emits `VerseClubMember` atoms for both tiers. Verses tagged only
"300" stay single-tier.

The same rule applies transitively to `ChapterClubMember` and `HeadingClubMember` — a chapter with
any 150-tagged verse has both a `ChapterClubMember(tier=150)` and a `ChapterClubMember(tier=300)`.

## Graph structure (worked example)

Two consecutive verses in Acts 2, verse 1 is a 150-member:

```
  BOOK LAYER
  ──────────
            BookGist(Acts) ↔ BookRef(Acts)

  CHAPTER LAYER
  ─────────────
          ChapterGist(2) ↔ ChapterRef(2)
              ↑                ↑
       uni from         uni from
       verse gist       verse ref

  VERSE LAYER
  ───────────
        VerseGist(2:1) ─bi─ VerseGist(2:2)
            ↕                    ↕
      VerseRef(2:1)         VerseRef(2:2)
         (uni → ChapterRef)    (uni → ChapterRef)
         ↕                    ↕
      VerseClubMember         (no member)
        (tier=150)
      VerseClubMember
        (tier=300)

  PHRASE LAYER
  ────────────
     p1─p2─p3─p4              p1─p2─p3─p4
     (bi chain)                (bi chain)
     each ↔ VerseGist          each ↔ VerseGist
```

Plus:

* `ChapterGist(2) → first/last VerseGist(chapter 2)` (endpoint edges)
* `BookGist → first/last ChapterGist` (endpoint edges)
* `ChapterGist(2) ↔ ChapterGist(3)` if the book has more chapters
* Club hierarchy: `ClubGist(150)`, `ChapterClubMember(150, 2)`, plus all the "first/last member"
  endpoints and the verse/chapter chains
* FTV nodes for verses whose FTV text is ≤ 5 words
* Heading associations when a verse falls in a section

## Edge inventory per verse

Rough counts to sanity-check memory usage. Per verse with N phrases:

| Edge                              | Directed count    |
| --------------------------------- | ----------------- |
| phrase ↔ phrase (sequential)      | 2(N-1)            |
| phrase ↔ verse gist (hub)         | 2N                |
| verse gist ↔ verse ref            | 2                 |
| verse gist → chapter gist         | 1                 |
| verse ref → chapter ref           | 1                 |
| verse gist ↔ next verse (chapter) | 2                 |
| verse gist → heading              | 1 (if in section) |
| **verse total**                   | **≈ 4N + 7**      |

Plus per-tier-member additions:

* `ref ↔ club_member` (2 directed)
* verse member chain (2 directed) + upward to chapter/heading cm (1–2)
* club gist hub (1)
* ≈ 6–8 extra directed edges per (verse, tier) pair.

At the material level, add:

* ~6 book-level edges (gist↔ref, endpoints, consecutive chain)
* ~6–8 edges per chapter (gist↔ref, endpoints, parent-linkage, consecutive chain)
* Club hierarchy: chapter-cm + heading-cm add bounded overhead per populated chapter / section.

A full 1 Corinthians (553 verses, single book, ~16 chapters, 150 + 300 club members) builds to ~4k
nodes and ~14.6k directed edges. Every edge has FSRS state — on the order of 250 KB of raw state,
trivially tractable.

## Reference model (anchor transfer)

A verse's full reference = book + chapter + verse number. The verse number can be recalled two ways:

**Direct recall**: `verse_gist → verse_ref` is strong. "I just know this is verse 3."

**Anchor-derived**: count the chapter-consecutive chain distance from a verse whose reference is
already known, then apply arithmetic. Any reachable `verse_gist → verse_ref` edge serves as an
anchor, with decay based on chain distance (see [review.md](review.md) anchor transfer).

```
Direct:      verse(2:3) → verse_ref(2:3)                       just know it
Via anchor:  verse(2:3) → verse(2:2) → verse(2:1) → ref(2:1)   2 hops + arithmetic
```

**Counting requires full-material knowledge**: anchor transfer works via the verse-gist chain; if
that chain is weak the anchor path is weak.

## Open questions

* **Generalised edge-kind enum.** The book/chapter/verse/heading/club-member layers all follow the
  same five-edge containment shape (gist↔ref, child→parent, parent→first/last child,
  parent-consecutive chain, child_ref→parent_ref). A future cleanup could collapse `EdgeKind` to
  generic variants parameterised by a layer discriminator (`ContainsStart`, `ContainsEnd`,
  `ParentRef`, …). Kept explicit for now while the schema is still iterating.
* **Cross-book anchor transfer.** `BookGistBookGist` exists in the schema but isn't exercised in
  card generation today. Once multi-book materials land, the anchor-transfer algorithm may want to
  use book-level chains for cross-book references.
* **Reverse club_entry chain.** The `VerseClubMemberVerseClubMember` edge is now bi (previous + next
  verse in tier). Earlier versions had it uni.
* **Phrase boundaries for non-KJV.** Unresolved: do phrase atoms transfer across translations or
  chunk each translation independently?
