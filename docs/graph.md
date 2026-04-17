# Memory Graph

Verse-Vault models scripture memorization as a directed graph where **edges are the unit of
memory**. The core insight: memory is not about knowing isolated facts — it is about transitions
between pieces of information. "Given cue X, I can produce Y" is one edge, tracked with its own
spaced-repetition state.

Each learnable edge stores Stability (S), Difficulty (D), and last_review_time. Retrievability
is computed on demand: `R = (1 + t / (9 · S))^(-1)`.

## Theoretical grounding

* **Paired-associate learning**: memory is stored as cue→response associations.
* **Woźniak's memory complexity** (2005): composite stability follows `1/S = 1/S_a + 1/S_b`.
  Long items as single cards have stability collapsing toward zero. Decomposition into smaller
  cue→response pairs is theoretically required.

## Node types

| Node type        | Testable? | Example                       |
| ---------------- | --------- | ----------------------------- |
| **Phrase**        | Yes       | "For God so loved the world," |
| **Verse gist**    | No — latent, updated via coupling | [gist of Acts 2:3]  |
| **Reference**     | Yes       | "Acts 2:3"                    |
| **Club entry**    | Indirectly | "Acts 2:1 is in club 150"    |
| **Heading**       | Yes       | "All to the Glory of God"     |
| **Chapter gist**  | No — structural source node   | [gist of Acts 2]     |
| **Chapter ref**   | Yes       | "Acts 2"                      |

**Verse gist**: non-testable hub connecting reference, phrases, and chapter. Separates gist
memory ("what this verse is about") from verbatim memory ("the exact words"). No direct edges
between references and phrases — all paths route through the verse gist.

**Chapter gist**: structural source node for listing cards. Receives incoming edges from
verse gists, has outgoing edges to club entries and a bidirectional edge to the chapter ref.
Cannot be traversed into from club entries — prevents shortcut paths. Does not need FSRS state.

## Edge types

All learnable edges are tracked by FSRS. There are no hardcoded R=1.0 edges.

| Edge                                          | Direction | Learnable? |
| --------------------------------------------- | --------- | ---------- |
| phrase ↔ phrase (sequential)                   | bi        | yes        |
| phrase ↔ verse gist (hub)                      | bi        | yes        |
| verse gist ↔ reference                        | bi        | yes        |
| verse gist ↔ verse gist (chapter-consecutive)  | bi        | yes        |
| reference ↔ club entry                        | bi        | yes        |
| chapter gist ↔ chapter ref                    | bi        | yes        |
| verse gist → chapter gist                     | uni       | yes        |
| chapter gist → club entry                     | uni       | no (structural) |
| club entry → club entry (chain)               | uni       | yes        |
| verse gist → heading                          | uni       | yes        |
| heading ↔ heading (chain)                     | bi        | yes        |

### Directionality rationale

* **verse gist → chapter gist** (not reverse): given a verse, you recall its chapter. The reverse
  would let the chapter gist reach all verses, creating shortcuts between club entries and
  arbitrary verses.

* **chapter gist → club entry** (not reverse): needed for listing cards ("which 150 verses in
  Acts 2?"). The reverse is unnecessary — club_entry → ref → verse_gist → chapter_gist already
  exists as a path.

* **club entry → club entry** (forward only): the chain represents "what's the next 150 verse."
  Reverse traversal could be added later if needed.

* **verse gist → heading** (not reverse): given a verse, you recall which section it belongs to.
  The reverse (heading → verses) isn't needed — the primary cards show verses and ask for the
  heading, never the other way around. If "show heading, list verses" cards are needed later,
  heading → verse edges can be added.

* **heading ↔ heading** (bidirectional): sequential section ordering. Supports both "what
  section comes next?" and "what section came before?" No shortcut risk because headings have
  no outgoing edges to verses — they're sink nodes in the verse→heading direction.

## Graph structure

Two consecutive verses with club 150 membership:

```
                chapter_ref("Acts 2")
                        ↕
                   chapter_gist
                  ↑      ↑     ↓                       ↓
              verse1 ── verse2  club_150_entry(2:1) → club_150_entry(2:4)
              / | \     / | \          ↕                       ↕
            p1─p2─p3  p4─p5─p6     ref(2:1)                ref(2:4)
                          ↕                                    ↕
                       ref(2:1)                             ref(2:4)

note: ref(2:1) and ref(2:4) each appear once — shown twice here for layout clarity
verse gist → chapter gist edges are unidirectional (↑)
chapter gist → club entry edges are unidirectional (↓)
all other vertical edges (↕) are bidirectional
all horizontal edges (──) are bidirectional
club entry → club entry (→) is unidirectional
```

* Verse gist hub-connects (bi) to all its phrases
* Chapter-consecutive verse↔verse edges are bidirectional
* Verse gists point to the chapter gist (uni)
* Club entries connect to refs (bi) and chain forward (uni)

## Reference model

A verse's reference = chapter + verse number. The verse number can be recalled two ways:

**Direct recall**: verse_gist → ref is strong. "I just know this is Acts 2:3."

**Anchor-derived**: count the chapter-consecutive chain distance from a verse with a known
reference, then apply arithmetic. Any reachable verse→ref edge serves as an anchor.

```
Direct:      verse(2:3) → ref(2:3)                              just know it
Via anchor:  verse(2:3) → verse(2:2) → verse(2:1) → ref(2:1)   2 hops from anchor
             "Acts 2:1" + 2 = "Acts 2:3"                        arithmetic (free)
```

Every verse has a ref atom and a verse→ref edge. The edge may start weak — nearby anchors
provide backup. Over time, the direct edge strengthens and the learner transitions from counting
to instant recall. See anchor transfer in [review.md](review.md).

**Counting requires full-material knowledge**: a club-150 quizzer using club entries
(entry(2:1) → entry(2:4), 1 hop) doesn't know the chapter-distance is 3. Counting from ref(2:1)
to ref(2:4) requires the chapter-consecutive verse chain (3 hops through verses 2:2, 2:3). If
those edges are weak (unreviewed), the anchor path is naturally weak.

## Club structure

QuizMeet tiers: **full material** (all verses), **club 300** (specific 300), **club 150**
(specific 150, subset of 300). Most chapters have 3–7 club-150 and 6–14 club-300 verses.

### Per-verse club entries

```
chapter_gist ──→ club_150_entry(2:1) ──→ club_150_entry(2:4) ──→ club_150_entry(2:7)
                       ↕                        ↕                        ↕
                    ref(2:1)                 ref(2:4)                 ref(2:7)
```

Each club entry connects to its reference (bi) and chains to the next entry (uni). The chapter
gist points to entries (uni) for listing cards.

**Why separate atoms** (not verse↔verse edges):
* Avoids verse-chain shortcuts that give false anchor transfer credit
* Club sequence is meta-knowledge about the list, not content flow
* Keeps verse↔verse edges clean: only chapter-consecutive content flow

**Membership** is implicit: a verse with a club entry is in the club.

Club 300 entries include all 300 verses. A club-150 verse has both a club_150_entry and a
club_300_entry.

## Headings

Bible section headings (e.g., "All to the Glory of God" covering 1 Cor 10:23–11:1) provide
contextual grouping that crosses chapter boundaries. The heading text is both the name and
the gist — unlike verse references, heading names describe what the section is about.

Headings vary by translation (and even by print edition) — both the text and the verse ranges
differ. Heading atoms are per-translation.

```
heading("All to the Glory of God") ↔ heading("Do Not Cause Others to Stumble")
       ↑      ↑      ↑      ↑
  v(10:23) v(10:24) v(10:25) ... v(11:1)
```

* **verse gist → heading** (uni): every verse in the heading's range knows its heading
* **heading ↔ heading** (bi): sequential section ordering — supports "what comes next?" and
  "what came before?"
* **No heading → verse edges**: the primary use is verse → heading ("what section is this
  verse in?"), not heading → verses. Start/end verse numbers are metadata on the heading atom
  for the app to know the range — not graph structure the learner memorizes.

**Cards** (heading is always hidden):
* Show all phrases of a verse → ask for heading
* Show one verse reference → ask for heading
* Show a reference range (e.g., "10:23–11:1") → ask for heading
* Show a reference → ask for heading
* Show a heading → ask for next heading
* Show a heading → ask for previous heading

## Edge inventory

Per verse with N phrases:

| Edge                                | Directed count |
| ----------------------------------- | -------------- |
| phrase ↔ phrase (sequential)         | 2(N-1)         |
| phrase ↔ verse gist (hub)            | 2N             |
| verse gist ↔ ref                    | 2              |
| verse gist ↔ next verse (chapter)    | 2              |
| verse gist → chapter gist           | 1              |
| verse gist → heading                | 1              |
| **Base total**                       | **4N + 4**     |

Per club-member verse, add: ref ↔ club_entry (2–4) + club_entry → next (1–2) + chapter_gist →
entry (1–2) = up to 8.

Per heading, add: heading ↔ next heading (2).

For N=4: 20 base + up to 8 club = ~28 directed edges per verse.
500-verse season: ~12,000 directed edges. Each learnable edge stores 3 values. Trivially
tractable.

## Open questions

* **Chapter section boundaries**: material may not start at verse 1. Represent as properties on
  the chapter gist, or edges to specific boundary verses?
* **Reverse club chain**: add backward club_entry edges for "what was the previous 150 verse?"
* **Phrase boundaries for non-KJV**: transfer across translations or chunk each independently?
