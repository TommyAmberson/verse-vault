# Path-posterior memory model

> **Status:** brainstorm with a chosen direction. The fundamental architectural choice — _what is
> the unit that carries FSRS state?_ — has two coherent answers, articulated in **Two architectural
> approaches**: model the memory of the material (state per memorable atom), or model the memory of
> specific tests (state per cue/target pair). **As of 2026-05 the project is pursuing Approach 2**
> (state per test) for the FSRS calibration efficiency, with the goal of capturing as much per-atom
> diagnostic value as possible through structure-driven cross-test propagation. See _Pursuing
> Approach 2_ for the active architecture; the cards-primary core of the doc is the math behind
> Approach 2 with "card" read as "test." The graded-thing variant near the end remains documented as
> the considered-but-not-pursued Approach 1.

## Contents

* [Motivation](#motivation)
* [Two architectural approaches](#two-architectural-approaches)
* [Pursuing Approach 2](#pursuing-approach-2)
* [FSRS-stateful test taxonomy (HSRS-aligned)](#fsrs-stateful-test-taxonomy-hsrs-aligned)
* [The three-layer model](#the-three-layer-model)
* [Notation](#notation)
* [Card state](#card-state)
* [Edge associations](#edge-associations)
* [Path posterior at review time](#path-posterior-at-review-time)
* [Edge updates via Bayesian inference](#edge-updates-via-bayesian-inference)
* [Card-to-card propagation](#card-to-card-propagation)
* [Multi-atom cards](#multi-atom-cards)
* [Verse-chunk layer (optional)](#verse-chunk-layer-optional)
* [Ground truth and drift prevention](#ground-truth-and-drift-prevention)
* [Variant: redesigned graph (graded-thing architecture)](#variant-redesigned-graph-graded-thing-architecture)
* [Open questions](#open-questions)

## Motivation

### What FSRS is actually built for

FSRS is a single-card single-grade single-update memory model: an atomic review event drives a (S,
D, t) update via empirically calibrated formulas. Its 21 parameters are fit to millions of Anki
reviews of approximately independent flashcards. It is gold for that regime.

### What verse-vault is actually doing

Verse-vault memorizes connected text, where:

1. **Items are sequenced.** Phrases of a verse are ordered; recall is traversal, not point-recall.
2. **Items share substrate.** Common phrasings recur across verses ("in the beginning", "and it came
   to pass"). Maximum interference baked into the content.
3. **Recall is hierarchical.** Users retrieve verse-as-chunk, which unfolds into phrases, which
   unfold into words.
4. **Each card touches many memorable units.** A full-recitation card tests every adjacency, gist,
   and ref-binding in the verse simultaneously.

None of this fits the atomic-card assumption FSRS was tuned for.

### Where the current edge-FSRS architecture struggles

The current architecture puts FSRS state on each edge of the memory graph and synthesizes credit
assignment to distribute card outcomes across edges. This has run into several structural issues:

* **Linear blending in stability space** for multi-grade updates produces pathological
  cancellations: `(Again, 0.5) + (Good, 0.5) ≈ 0` net change even when both observations carry
  information. (S1 in `docs/audit-fsrs6-2026-04-28.md`.)
* **Per-edge weight is unbounded across hidden atoms.** Hub edges participating in paths to multiple
  hidden atoms accumulate weights up to ~N. The FSRS update then applies "N full reviews' worth" of
  delta in one blend. (S2.)
* **`last_review_secs` is unconditionally reset** by any update, regardless of weight. A 5%-strength
  exposure update fully refreshes the decay clock, lying to the scheduler about how recently the
  edge was meaningfully reviewed. (S3.)
* **Out-of-app practice is invisible to history-trace memory models.** Quizzers practice constantly
  in many contexts; an algorithm that requires a complete observation record cannot recalibrate when
  reality contradicts prediction.
* **Edges cannot be directly tested in isolation.** Most edges in the graph (gist nodes, hub edges,
  ref-binding edges) cannot be probed without activating other edges, so HSRS-style "ground-truth"
  reviews of individual edges are mostly impossible.

These are not bugs in implementation; they are signs that the FSRS substrate is being asked to do
something it was not built for. Trying to patch them produces a growing collection of heuristics
with no unified theory.

### What this proposal does instead

This document proposes:

1. **Move FSRS state to cards**, where it has empirical calibration.
2. **Replace per-edge FSRS state with per-edge Hebbian-style association strengths**, which fit the
   cognitive role edges actually play.
3. **Use Bayesian inference over recall paths** at review time to attribute the observation across
   edges and propagate to related cards.

The path-posterior step is the mathematical contribution of the graph: it turns a card-level
observation into evidence about which edges fired, which propagates to other cards whose recall
flows through the same machinery. The audit issues dissolve because their preconditions
(FSRS-on-edges, partial-credit-on-FSRS) are removed.

## Two architectural approaches

A more fundamental framing of the choice in front of us, surfaced after working through the specific
options below: there are two genuinely different ways to think about what we're modelling, and the
rest of this document explores variants of each.

### Approach 1 — Model the memory of the material

Every memorable atom in the material has its own state. The graph **is** the user's memory model:
each phrase, each ref component, each containment relationship is a noun in the model and carries
its own state describing the user's current memory of it. Tests are tools designed to probe and
update specific atoms; scheduling has a dual goal of keeping the state accurate (alignment with
reality) and driving retention up (review).

This is what the current edge-FSRS implementation attempts: state lives on graph elements
(originally edges, possibly nodes/edges in the graded-thing variant), and the graph is a faithful
representation of what the user has memorized.

**Pros:**

* Conceptually clean — the model represents the material directly.
* One state per memorable atom; multiple card types updating the same state are just multiple
  observations of the same underlying memory.
* Diagnoses that "the user has forgotten this specific phrase" are first-class.
* Cross-card-type reuse: forward recall and reverse recall of the same phrase share state, which is
  cognitively defensible for verbatim text recall (the underlying memory is shared even if cuing
  differs).

**Cons:**

* FSRS was designed for the unit "test = state." Putting state on memorable atoms (rather than on
  tests) means each atom's state is updated by multiple test events with different cuing,
  difficulty, and grading semantics. The empirical FSRS calibration doesn't directly apply.
* Multi-atom card observations need partial-credit machinery (path posterior, AGG-FlowJoint) to
  attribute observations across atoms — substantial additional theory.
* The S1/S2/S3 audit issues are specific symptoms of FSRS-on-atoms with partial credit; the
  graded-thing variant fixes them but the underlying tension remains.

### Approach 2 — Model the memory of specific tests

Every distinct test has its own FSRS state. A "test" is a specific (cue, target) pair: "given this
prompt, produce this answer." Different cues for the same memorable atom are different tests with
different states. A single card review may run multiple tests (one per `(cue, hidden atom)` pair),
each updating its own FSRS state. The graph is **structural metadata** that captures relationships
between tests for cross-test propagation.

This matches FSRS's design: each test is one trackable thing, calibrated independently, with a
forgetting curve that fits empirical reality.

**Pros:**

* FSRS calibration applies directly. Each test has the same shape as an Anki card; the 21-parameter
  model is doing exactly what it was tuned for.
* No partial-credit problem: each test gets its own grade, its own update.
* Out-of-app practice handled correctly: state is per-test, recalibrates from observation gaps.
* Standard scheduling logic applies per-test.

**Cons:**

* State explodes: the same memorable atom can have many tests (different cues, different
  directions). Each test's state must be tracked and predicted.
* Cross-test propagation is needed to share evidence between related tests — otherwise the user has
  to review every cuing-direction independently.
* Empirically defensible cuing-dependent dissociation may be over-modelled for verbatim text recall,
  where the underlying memory is mostly shared across cues.

### The thread connecting them

These approaches differ on a single core question: **what's the unit that has FSRS state?**

* Approach 1: the unit is a memorable atom (phrase, ref component, containment relationship).
  Multiple card types updating the same atom share state.
* Approach 2: the unit is a test (cue + target pair). Different cuings of the same atom are
  different tests with different states; structure connects them for propagation.

The graded-thing variant near the end of this document is a refinement of Approach 1 (adding the
1-to-1-grading constraint to limit which atoms get state). The cards-primary architecture in the
core sections is more naturally Approach 2 if we read "card" as "test." Both are still being
explored; this section names the choice rather than resolving it.

For verse-vault specifically, the empirical question is whether cuing-direction asymmetries are
strong enough to justify per-test state. If forward recitation, reference identification, and
holistic recitation share substantial underlying memory (Approach 1 wins), per-atom state is more
parsimonious. If they're substantially dissociable (Approach 2 wins), per-test state captures real
behaviour the per-atom version misses.

The doc's exploration so far suggests verse memorization leans toward Approach 1 (shared memory
across cuings, with cuing being retrieval scaffolding rather than separate skills), but this is
worth simulating before committing.

## Pursuing Approach 2

**Decision (2026-05):** pursue Approach 2 for the FSRS calibration efficiency. The challenge is to
capture as much of Approach 1's per-atom diagnostic value as possible through structure-driven
cross-test propagation, rather than trying to build a partial-credit-on-atoms machinery that fights
FSRS's design.

The primary reason: Approach 1 requires inventing a partial-credit theory (the path posterior +
AGG-FlowJoint machinery, multi-atom aggregation, etc.) to handle one card review producing updates
across many state-bearing atoms. That theory is plausible but novel and unvalidated. Approach 2 lets
every FSRS state be exactly what FSRS was designed for: one test, one grade, one update. The novel
piece becomes "how do related tests inform each other" — which is a much better-bounded problem with
established analogues in knowledge tracing, Bayesian Knowledge Tracing, and graph-mediated belief
propagation.

### Architecture under Approach 2

**Tests are the unit of state.** Each test is a `(cue category, target)` pair with an FSRS state.

**Memory graph is metadata.** The graph (phrases, ref components, gist hub, containment edges,
adjacency edges, anchor/confusion edges) does **not** carry FSRS state. It's used for two things:

1. _Defining tests_: a test is generated for each meaningful `(cue category, target)` combination
   the card-type catalogue supports.
2. _Driving propagation_: when one test is updated, related tests are nudged. Relatedness is
   computed from memory-graph proximity (do their targets share neighbourhoods? do their cue sources
   overlap?).

**Cards are presentation.** A card is the UI/interaction layer that runs one or more tests in a
single review. A multi-target card (recitation, full ref-id) runs N tests in one review session;
each test produces its own grade and its own FSRS update.

**Propagation is the graph's contribution.** This is what Approach 2 must be principled about, since
it's the channel through which approach-1-style "the user has forgotten phrase X" insight becomes
available — derived from observing many tests, all of whose retrievabilities reflect the underlying
memory of phrase X.

### What is a test in verse-vault

Each test corresponds to a specific kind of probe of a specific atom of the material. Test
categories the doc has been gesturing at:

| Test category              | Cue source                        | Target                                        | Example test instance                        |
| -------------------------- | --------------------------------- | --------------------------------------------- | -------------------------------------------- |
| Phrase-from-chain          | preceding phrase / ref            | a Phrase                                      | "phrase 2 of John 3:16, given preceding cue" |
| Phrase-from-context        | surrounding phrases + ref         | a Phrase                                      | "phrase 2 fill-in-blank"                     |
| Ref-component-from-content | verse content                     | a ref component (book, chapter, verse-number) | "verse-number from content of John 3:16"     |
| Ref-component-from-sibling | adjacent ref component            | a ref component                               | "chapter from verse, John 3:16's chapter"    |
| Containment                | a ref component                   | its parent ref component                      | "chapter of John 3:16 → John 3"              |
| Verse-gist association     | content or ref                    | the binding                                   | "John 3:16: ref ↔ content binding"           |
| Heading association        | (TBD when heading taxonomy added) | ...                                           | ...                                          |

Each instance gets one FSRS state. For a 4-phrase verse with full ref machinery, that's roughly:

* 4 phrase-from-chain tests
* 4 phrase-from-context tests (one per phrase that could be hidden in fill-in-blank)
* 3 ref-component-from-content tests (book, chapter, verse-number)
* 2 containment tests (verse → chapter, chapter → book)
* 1 verse-gist association test

= ~14 tests per verse. For 100 verses, ~1400 test states. Comfortably manageable.

### What's gained vs. lost relative to Approach 1

**Gained:**

* Direct FSRS calibration. Each test is exactly the unit FSRS was tuned for. No new theory needed
  for the core update.
* Out-of-app practice handled automatically by FSRS's own state-recalibration property.
* No partial-credit-on-shared-state problem. Each grade in a multi-target review hits its own test's
  state cleanly.
* Standard scheduling logic per test.

**Lost (and how to recover via propagation):**

* _Per-atom diagnostics_: under Approach 1, "phrase X is weak" was a single fact. Under Approach 2,
  it's derived from observing that all tests targeting phrase X have low retrievability. Recovery:
  define a derived "atom mastery" metric that aggregates the FSRS retrievabilities of tests
  targeting it, used for scheduler decisions and UI displays. This isn't state, it's a query on test
  states.

* _Cross-cuing memory sharing_: if forward and reverse recall of phrase X share underlying memory
  cognitively, Approach 1 captures this for free (one state). Approach 2 has separate states.
  Recovery: graph-mediated propagation. When test "phrase X from chain" is updated, test "phrase X
  from context" gets a partial update via the shared-target graph edge. The strength of this
  propagation is the empirical question — if cuing dissociation is small, propagation should be
  aggressive (high coupling); if large, propagation should be weaker.

* _Total state count_: Approach 1 has fewer state items. Approach 2 multiplies by the number of test
  categories. The trade-off is per-state simplicity (FSRS-native) vs. fewer items (Approach 1).

### What this means for the rest of the doc

The cards-primary architecture in the core sections of this doc is essentially Approach 2 with
"card" read as "test." The path-posterior + log-odds-update + AGG-FlowJoint machinery from those
sections is the propagation layer — the formalism for how observation on one test/card informs
related tests/cards through the graph structure.

The graded-thing variant near the end is the principled Approach 1 alternative; it's preserved for
reference but is not the active direction.

The remaining open questions in the active design are now:

1. **Test categorisation granularity.** What counts as the same test category? Is "phrase from ref
   alone" the same test as "phrase from ref + p1"? (Probably yes — same underlying memory; chain
   length is just a cue richness factor.)
2. **Propagation strength between tests sharing target.** How strongly does observing "phrase X from
   chain" inform "phrase X from context"? Empirical / hyperparameter question.
3. **Propagation strength between tests sharing cue.** Probably weaker than shared-target
   propagation but non-zero.
4. **Discount for cuing-direction asymmetry.** If two tests target the same atom but with very
   different cue paths (e.g., forward recall vs. reverse recall), does propagation discount for
   that?
5. **Identifiability and state explosion management.** Some test instances may have very few
   observations (e.g., a fill-in-blank for a phrase that's almost always shown). Their FSRS states
   sit near priors. Does that matter? Should low-observation tests be deduplicated / merged with
   related tests for stability?

These are the questions the rest of the design needs to answer, now framed clearly as Approach-2
questions.

## FSRS-stateful test taxonomy (HSRS-aligned)

Under Approach 2, every distinct test gets its own FSRS state. The design preference is _maximize
the count of stateful tests_: more granular state means richer diagnostics and lets the FSRS
forgetting curve do its work on each cuing-direction independently. The cost is more state to track,
but FSRS state is small (roughly 16 bytes per test) and update math is local.

This section enumerates what tests verse-vault should have. The taxonomy aligns deliberately with
HSRS's "per-element FSRS state, propagated updates via probabilistic FSRS" pattern, generalised from
HSRS's tree topology to verse-vault's graph topology.

### Test taxonomy

For each verse with N phrases, the verse generates these tests:

**Phrase tests (verbatim recall):**

| Test                                | Cue source                     | Target                | Count |
| ----------------------------------- | ------------------------------ | --------------------- | ----- |
| Phrase-from-chain (forward)         | preceding phrase or ref        | a Phrase              | N     |
| Phrase-from-context (fill-in-blank) | ref + all other phrases        | a Phrase              | N     |
| Phrase-from-fragment                | partial cue (e.g., first word) | a Phrase              | N     |
| Phrase-recognition                  | a Phrase                       | which verse it's from | N     |

**Reference component tests:**

| Test                                     | Cue source                  | Target            | Count       |
| ---------------------------------------- | --------------------------- | ----------------- | ----------- |
| Book-from-content                        | verse content               | book name         | 1           |
| Chapter-from-content                     | verse content               | chapter number    | 1           |
| Verse-number-from-content                | verse content               | verse number      | 1           |
| Chapter-from-verse (containment)         | a VerseRef                  | parent ChapterRef | 1           |
| Book-from-chapter (containment)          | a ChapterRef                | parent BookRef    | per chapter |
| Verse-from-chapter (reverse containment) | a ChapterRef + verse number | a VerseRef        | 1           |
| Chapter-from-book (reverse containment)  | a BookRef + chapter number  | a ChapterRef      | per chapter |
| Book-name                                | book context (any)          | book name         | per book    |

**Verse-gist association tests:**

| Test                                 | Cue source   | Target                       | Count |
| ------------------------------------ | ------------ | ---------------------------- | ----- |
| Ref-to-content (forward association) | full ref     | "this binds to that content" | 1     |
| Content-to-ref (reverse association) | full content | "this binds to that ref"     | 1     |

**Heading tests** (if/when headings are added):

| Test               | Cue source | Target      |
| ------------------ | ---------- | ----------- |
| Passage-to-heading | a passage  | its heading |
| Heading-to-passage | a heading  | its passage |

For a 4-phrase verse with full ref machinery, this is roughly **4N + 8 = 24** tests per verse, plus
1-2 shared per chapter and per book. For a 100-verse memorisation, **~2400-3000 tests** total. At
~16 bytes per test for FSRS state, that's ~50KB of memory state — trivial storage.

### Per-test state (HSRS-aligned)

Each test carries:

```
struct TestState {
    stability: f32,                  // FSRS S
    difficulty: f32,                 // FSRS D
    last_seen_secs: i64,             // HSRS lastSeen — set on any update (direct or propagated)
    last_base_secs: i64,             // HSRS lastBase — used in forgetting curve, interpolated by weight
    last_root_secs: i64,             // last direct-grade observation (ground-truth anchor)
}
```

This matches HSRS's pattern faithfully:

* **`stability`, `difficulty`** are the usual FSRS state.
* **`last_seen`** advances whenever the test is touched (direct grade or propagation). Useful for
  "when was this last looked at?" diagnostics; not used in the forgetting curve.
* **`last_base`** is what the forgetting curve uses: `R(t) = forgetting_curve(S, D, t - last_base)`.
  For direct grades, `last_base` advances to `now`. For propagated updates, `last_base` interpolates
  linearly toward `now` proportional to the propagation weight (HSRS pattern). Soft updates produce
  soft clock advances, not full refreshes.
* **`last_root`** is the timestamp of the last direct grade (HSRS's `lastRoot` analogue). The
  scheduler uses staleness of `last_root` to bias toward direct observations of tests that have been
  getting only propagated updates, which prevents drift.

### Update semantics (HSRS-aligned)

Two kinds of updates:

**Direct grade.** Some card runs this test and the user produces a graded response.

```
1. Apply standard FSRS step:
   (S, D) ← FSRS_step(S, D, now - last_base, grade)
2. Refresh timestamps:
   last_seen ← now
   last_base ← now
   last_root ← now
```

This is exactly FSRS as designed. No partial-credit machinery, no inference. The test was directly
observed; its state is updated.

**Propagated update.** Some other test was directly graded, and this related test should be nudged.
Weight `w ∈ [0, 1]` reflects how strongly the observation about the other test informs this one.

```
1. Compute the next state under the same grade:
   (S', D') = FSRS_step(S, D, now - last_base, grade)
2. Compute current and next retrievabilities at now:
   R_now = R(S, D, now - last_base)
   R_next = R(S', D', now - last_base)
3. Linearly interpolate retrievabilities:
   R_blend = (1 - w) · R_now + w · R_next
4. Solve for stability that produces R_blend:
   S_blend = invert_R(R_blend, now - last_base)
5. Linearly interpolate difficulty:
   D_blend = (1 - w) · D + w · D'
6. Refresh timestamps:
   last_seen ← now
   last_base ← (1 - w) · last_base + w · now      (interpolated)
   last_root unchanged                              (this was not a direct observation)
```

This is HSRS's "probabilistic FSRS update with retrievability-space interpolation." Steps 1-4 are
the math we already adopted as Q2's resolution; steps 5-6 are the timestamp dual-pattern addition.
Together they form a complete propagated-update primitive.

Crucially: the propagation **doesn't produce a separate kind of state**. It's an FSRS-shaped update
with a weight. The state stays uniformly `(S, D, last_seen, last_base, last_root)` — no separate
"association strength" or "Hebbian weight" needed for graded tests. HSRS's insight is that all
updates can use this one uniform shape, parameterised by weight.

### Propagation: where weights come from

The remaining question is: when test A is directly graded, what weights do we use to propagate to
test B?

The weight should reflect "how much does observing A inform B?" — which is a function of:

* How much do A and B share targets in the memory graph? (Strongest signal: same target → high
  weight. Different targets in the same verse → moderate. Cross-verse → low.)
* How much do A's and B's cue sources overlap? (Shared cuing implies shared retrieval pathways.)
* How structurally similar are A and B in test category? (Two phrase-from-chain tests are more
  similar than a phrase-from-chain and a ref-component-from-content test.)

A reasonable propagation-weight rule:

```
w(A → B) = γ · target_overlap(A, B) · cue_overlap(A, B) · category_compatibility(A, B)
```

with `γ` a small global constant (~0.1-0.3), and the three factors all in `[0, 1]`. The specifics of
each factor are open questions — see below.

### What HSRS gives us

By aligning with HSRS, we inherit several things:

* **A proven update primitive** for partial observations (the retrievability-space interpolation).
* **A proven timestamp pattern** (`last_seen` / `last_base` / `last_root`) that handles the "soft
  updates shouldn't lie about freshness" problem (the original audit's S3) cleanly.
* **A proven scheduling pattern** (bias toward stale `last_root`) to prevent inferred-update drift.
* **An empirical pedigree**: HSRS is deployed and the math is calibrated. We can borrow parameter
  values as starting points rather than tuning from scratch.

### What we adapt rather than copy

HSRS's tree topology becomes verse-vault's graph topology. Specifically:

* HSRS has one grade per review (the user grades the whole tree); verse-vault has multiple grades
  per card review (one per test the card runs). This is just an extension — each grade in a
  multi-grade card review is processed independently as a direct update on its respective test.
* HSRS's Bayesian inference for "which leaf caused the failure" doesn't directly apply (we have
  direct grades). But the propagation weights between related tests serve a similar role:
  distributing observation evidence across the graph of tests.

### Implications for the rest of the doc

The cards-primary content in the body of this doc was already moving toward this architecture in a
roundabout way. With HSRS alignment baked in, several earlier sections simplify:

* **Path posterior, AGG-FlowJoint, partial-credit machinery** were all about handling multi-target
  observations under Approach 1 (state on memorable atoms). Under Approach 2 with this taxonomy,
  multi-target cards just produce multiple independent direct updates, one per target. The Bayesian
  path inference is no longer needed for the _direct_ update semantics.
* **Bayesian inference is still useful** — but for the propagation question (which related tests
  should be nudged, and by how much) rather than for the direct-update question. That's a much more
  bounded role.
* The **graded-thing variant** at the end of the doc is preserved as the Approach-1 alternative, but
  the active design is this section + HSRS-style propagation.

### Implications for memory complexity (atomicity)

The standard SuperMemo / FSRS-community recommendation is that "individual flashcards should be
atomic; complex knowledge should be decomposed into small independent pieces"
([awesome-fsrs wiki, Memory Complexity](https://github.com/open-spaced-repetition/awesome-fsrs/wiki/Spaced-Repetition-Algorithm:-A-Three%E2%80%90Day-Journey-from-Novice-to-Expert#memory-complexity)).
The argument: composite memory has effective stability `S_composite = ∏ S_component`, which decays
to zero as components multiply. Putting one FSRS state on "the whole verse" suffers exactly this
problem: any one phrase failure breaks the whole, and the composite stability is much lower than any
individual phrase's stability.

**Crucial distinction: the recommendation is about FSRS _state_, not _cards_.** Composite cards
(holistic recitation, multi-phrase fill-in-blank) are valuable for several reasons:

* **Efficiency**: one card review produces many test-grade events at once, less UI / setup overhead
  per test.
* **Realism**: holistic recitation mirrors how quizzers actually use the knowledge in competition or
  practice.
* **Sequential structure**: recitation tests the phrase chain, not just isolated phrases. The user
  produces phrase 2 _after_ phrase 1, exercising the adjacency machinery in a way fill-in-blank
  doesn't.

The architecture supports composite cards naturally because **cards (presentation) and tests (FSRS
state) are decoupled**:

* A composite card is a UI / interaction unit that runs many tests in one review.
* Each test the card runs has its own atomic FSRS state, updated by its own grade.
* A holistic recitation card running ~8 tests per 4-phrase verse fires 8 independent direct updates,
  each on its own atomic state.

This is the best of both: efficient practice (composite cards) without the brittle composite-
stability problem (atomic FSRS state). Single-FSRS-state-per-card systems (standard Anki, naive
verse-as-card setups) suffer the SuperMemo issue; this architecture doesn't because the FSRS state
isn't on the card, it's on the tests the card runs.

### Sibling interference and scheduling

A separate issue, often confused with memory complexity but actually distinct: **back-to-back
testing of related tests primes the second observation via working-memory carryover**. After testing
forward (`ref → content`), the content is briefly in working memory; testing reverse
(`content → ref`) shortly after measures "can you do this 2 minutes after activation?" rather than
"can you do this from cold memory?"

The honest assessment of this issue:

**The mechanism is real but short-lived.** Working-memory traces decay in seconds to minutes; even
meaningful priming is mostly gone within an hour. Anki's conventional 24-hour sibling burial is much
longer than necessary to clear the contamination — it's community heuristic, not derived from
cognitive psychology.

**The contamination is probably small for verbatim text.** Unlike vocab cards where the cue binds
tightly to a single answer, verbatim recall involves sequential production work. Even under priming,
reciting 4 phrases in order is non-trivial; the grade isn't trivially inflated.

**FSRS averages over noise.** A few mildly-inflated observations don't permanently corrupt state;
the next cold-memory test recalibrates. The system is self-correcting in the long run.

**Practical recommendation:** a short cooldown between sibling tests, much shorter than Anki's
24-hour burial. Some plausible defaults:

* "Don't schedule strong / inverse siblings in the same session" (clears working-memory carryover
  for any reasonable session length).
* Configurable minimum gap of, say, 30 minutes for fine-grained control.
* Possibly nothing for cue-overlap and containment siblings, where the contamination is weaker.

This is a noise source the architecture knows about; the right intervention strength is empirical
and probably small. Treat it as a scheduler-policy knob to be tuned with data, not as a hard
architectural constraint.

**Sibling categories** (for scheduler reference):

| Sibling type            | Definition                                                   | Example                                                                |
| ----------------------- | ------------------------------------------------------------ | ---------------------------------------------------------------------- |
| **Strong sibling**      | Tests with the same target                                   | "Phrase 2 from chain" and "Phrase 2 from context"                      |
| **Inverse sibling**     | Tests with cue and target swapped                            | Forward `ref → content` and reverse `content → ref` for the same verse |
| **Cue-overlap sibling** | Tests sharing significant cue content                        | Two phrase tests of the same verse with overlapping cue phrases        |
| **Containment sibling** | Tests on related ref components or containment relationships | "Verse-number from content" and "Verse-number-from-chapter"            |

**Cooldown policy (proposed default):**

* Strong / inverse siblings: short cooldown (e.g., 30 minutes or "session-end").
* Cue-overlap siblings: very short cooldown or none.
* Containment siblings: none by default.

**Soft alternative:** if a sibling is overdue and the cooldown blocks it, optionally schedule anyway
but treat the grade as a partial observation (smaller weight in the FSRS update), acknowledging
contamination without losing the review opportunity.

Importantly, sibling cooldown is **distinct from cross-test propagation**. Propagation moves state
between related tests on a _direct grade event_. Cooldown prevents _new direct grade events_ from
happening too close together. Both mechanisms address related-but-different concerns:

* Propagation: "observation on test A should partially update test B even if B isn't directly
  tested" (saves review time, shares evidence).
* Cooldown: "observation on test B is partially contaminated if test A was just tested" (small noise
  reduction in observations).

Both are documented; cooldown is a much weaker intervention than initially proposed. Whether it's
worth implementing at all is an empirical question, not a settled architectural commitment.

### Composite memory: scaffolding from constituents

A real cognitive effect that the architecture should capture explicitly: **some elements are
composite in the sense that their recall depends on recalling their constituents**. The clearest
example is headings: "The Beatitudes" is much easier to recall when you know the verses it labels;
much harder when you don't know any. But the same principle applies elsewhere — the verse-gist
association is scaffolded by phrase recall + ref-component recall, containment relations are
scaffolded by knowing the endpoints, etc.

This is the same composite-stability phenomenon the SuperMemo memory-complexity argument warns
about, applied at the prediction layer rather than the state-storage layer. We addressed storage by
keeping FSRS state atomic; we now need to address prediction by computing composite retrievability
from constituents.

**Asymmetric scaffolding.** The cognitive effect is one-directional:

* **Components → composite: strong.** Knowing a phrase makes the verse's binding easier; knowing the
  verses makes the heading recallable.
* **Composite → components: weak.** Knowing "The Beatitudes is a heading in Matthew 5" doesn't help
  you produce verse 3 word-for-word.

The architecture must reflect this asymmetry in both prediction and propagation.

#### Compositional retrievability prediction

For a composite element `C` with self-state retrievability `R_self(C, t)` and constituents
`c_1, ..., c_n` (with retrievabilities `R(c_i, t)`), the **effective retrievability** for scheduling
purposes is:

```
R_eff(C, t) = combine(R_self(C, t), scaffolded(R(c_1, t), ..., R(c_n, t)))
```

Adopted form: **noisy-OR combine with max-component scaffolding** (Option A from the design
discussion):

```
scaffolded(C, t) = max_i  (R(c_i, t) · binding_strength(c_i, C))
combine(a, b)    = 1 - (1 - a) · (1 - b)
```

Interpretation: the user can recall C through _any_ successful path — direct memory of C, or through
any constituent whose binding to C is strong enough. Multiple paths multiply the chances of success
rather than averaging them. Captures the cognitive intuition that "remembering The Beatitudes" can
succeed via direct heading-text memory or via any one of the constituent verses cuing the heading
association.

Alternatives considered:

* _Bounded by components_: `R_eff = min(R_self, mean(R(c_i)) · scaffold_factor)`. Cleaner
  semantically (composite is bounded by components on average), but loses the multi-path benefit and
  is overly pessimistic when the user has a strong direct memory.
* _Additive in log-odds space_: aligns with the log-odds Hebbian update form, treats each source as
  independent evidence. Mathematically clean but harder to interpret.

#### Asymmetric propagation

When components are reviewed, composites get partial updates reflecting the predicted retrievability
change:

```
on direct grade of c_i:
  Standard FSRS step on c_i.
  For each composite C containing c_i:
    Recompute R_eff(C, t) with c_i's updated state.
    If R_eff(C, t) changed by ΔR:
      Apply HSRS-style probabilistic FSRS update to C with weight w ∝ |ΔR|.
```

When composites are reviewed, components get _very small_ updates (essentially zero):

```
on direct grade of C:
  Standard FSRS step on C's self-state.
  For each component c_i:
    Apply tiny partial FSRS update with weight ε (small, possibly zero).
```

The asymmetry is enforced by the propagation magnitudes, not just by the prediction math. Reviews of
constituents lift composite states substantially; reviews of composites barely lift constituent
states.

#### Which elements are composites?

The graph structure uses **VerseGist as a stateful intermediate node** representing the user's
memory of the verse's meaning / identity (distinct from verbatim phrases and the citation triple).
This bridges the verbatim layer (phrases) and the identifier layer (refs, headings) — a verse gist
is what the user "knows about" the verse independent of remembering its exact wording or its
citation.

Cognitively, the VerseGist is real: people can know "John 3:16 is the verse about God loving the
world and giving His Son" without remembering the exact wording, and can know the wording without
confidently knowing the citation. The gist is its own memorable thing.

**Refs are themselves bindings, not standalone identities.** The user's memory of "John 3:16 is
verse 16" isn't a memory of "the number 16" as an isolated fact — numbers exist independently of
memory. What's memorable is the _binding_ of the verse's gist to its position in the chapter. So
VerseRef is itself a composite, not a primary identity:

* **VerseRef** = "this VerseGist is verse N of this ChapterRef." A binding with the position number
  as a value.
* **ChapterRef** = "this chapter is chapter M of this BookRef." A binding with the chapter number as
  a value. (Optionally has a ChapterGist constituent for famous chapters known as units — Psalm 23,
  Romans 8 — but most chapters don't need a separate gist.)
* **BookRef** = the book's name as a primary identity (the name _is_ the identity, no further parent
  context needed).

This collapses what we previously called "verse-gist association" into VerseRef itself: knowing the
citation IS knowing the binding between gist and position-in-chapter. The two were describing the
same memory.

Working list for verse-vault under HSRS-state:

| Composite                             | Constituents                                        | Position value |
| ------------------------------------- | --------------------------------------------------- | -------------- |
| **VerseGist**                         | Phrases of the verse                                | n/a            |
| **VerseRef**                          | VerseGist + ChapterRef                              | verse number   |
| **ChapterRef**                        | BookRef (+ optional ChapterGist for known chapters) | chapter number |
| **BookRef**                           | (primary identity, not a composite)                 | n/a            |
| **HeadingPassageAssociation**         | The VerseGists in the passage range                 | n/a            |
| **HeadingHierarchy (parent → child)** | Parent + child heading nodes                        | n/a            |

The hierarchy of composites means scaffolding flows transitively up multiple levels:

```
Phrases of verse v ──→ VerseGist of v ──→ VerseRef of v ──→ (already covers the citation binding)
                                  ├─→ HeadingPassageAssociation (where v is in the passage)
                                  
ChapterRef of c ──→ VerseRef of v (where v is in chapter c) — sibling support
BookRef ──→ ChapterRef ──→ VerseRef — parent support
```

So when a phrase is reviewed:

1. Phrase update → VerseGist propagation.
2. VerseGist update → VerseRef propagation (gist is a constituent of the citation binding).
3. VerseGist update → HeadingPassageAssociation propagation (gist is a constituent of the passage
   binding).

When ChapterRef is reviewed (e.g., "what chapter is this?" produces the chapter number):

1. ChapterRef update directly.
2. ChapterRef update → VerseRef propagation (chapter is a constituent of the verse-citation binding)
   for every VerseRef in the chapter.

When BookRef is reviewed:

1. BookRef update directly.
2. BookRef update → ChapterRef propagation for every chapter in the book.
3. ChapterRef updates → VerseRef propagation transitively.

This is cleaner than the previous flat "heading → all phrases" composite structure. The
HeadingPassageAssociation composes over verse-level abstractions (~10 gists for a 10-verse passage)
rather than over individual phrases (~30+ phrases). The citation hierarchy composes over
higher-level groupings (book → chapter → verse), each level a stateful binding.

#### Why refs need to be bindings

The user observation that motivated this framing: **a person can remember a verse was verse 16 but
forget what chapter or book it was in**, and vice versa. These are dissociable memories. Under
standalone-identity refs, capturing this dissociation is awkward — there's no place to hang "I know
the verse number but not which chapter."

Under composite-binding refs, the dissociation is captured cleanly:

* Strong VerseGist + weak ChapterRef + a moderate VerseRef binding-state = "I know what the verse
  says and roughly know the verse number, but couldn't tell you which chapter."
* Weak VerseGist + strong ChapterRef + weak VerseRef = "I can't recall the verse content but know
  it's in this chapter; the binding (which verse number) is just gone."
* Strong all of (gist, chapter, ref binding) = full citation recall.

Each is a different state pattern. Direct grades on each component (via dedicated card types) update
them independently. Failures isolate to specific components, which is exactly what we want for
scheduling and remediation.

A natural rule: an element is a composite if it represents a _binding_, _relation_, or _aggregation_
over other stateful elements. Standalone elements (a phrase, a book name, a heading text) are not
composites — their retrievability is just `R_self`. VerseGist is a composite (it aggregates phrases
into a verse-level memory).

Composite elements still have FSRS state of their own; the compositional prediction _augments_ their
stored state rather than replacing it. A user who has memorized "The Beatitudes" as a label-passage
binding directly (via heading-recall cards) builds up the composite's self-state; a user who has
only memorized the constituent verses (via phrases → gist → heading propagation) builds up
scaffolded retrievability. The combine function lets either path produce high effective
retrievability.

#### Gist-related card types

Under the 1-to-1 grading rule, VerseGist needs at least one card type that grades it directly.
Plausible candidates (which match real quizzer practices):

| Card              | Cue                         | Target         | Direct grade target     |
| ----------------- | --------------------------- | -------------- | ----------------------- |
| Gist-from-content | verse content (paraphrased) | gist statement | VerseGist               |
| Topic-to-verse    | topic / theme description   | verse identity | VerseGist + binding     |
| Gist-from-ref     | ref                         | gist statement | VerseGist + binding     |
| Verse-from-gist   | gist description            | ref            | binding (and VerseGist) |

If verse-vault decides not to support gist-targeted card types, VerseGist could be downgraded to a
structural-only intermediate (no FSRS state, just a propagation conduit). The cleaner option is to
support gist cards — they correspond to real quizzer questions and provide direct observations of
the gist node, anchoring its state against drift.

#### Why this generalizes

The same machinery handles all composites uniformly. No special-case "heading logic" or "binding
logic" — every composite has the same shape (self-state + constituent scaffolding + asymmetric
propagation), differentiated only by what its constituents are. The two-level hierarchy through
VerseGist is just one example of the general principle: composites can be constituents of larger
composites, and the propagation rules compose recursively. This is what makes HSRS-state attractive:
one set of mechanics covers verses, gists, ref components, containments, bindings, headings, and any
future content type.

## The three-layer model

Three layers of state, each with a distinct role and update rule:

```
┌─────────────────────────────────────────────────────────────┐
│ verse-chunk states (optional)                               │
│ - per-(verse, direction) FSRS state                         │
│ - updated by full-recitation observations                   │
│ - regularizes constituent card states                       │
└─────────────────────────────────────────────────────────────┘
            ↑                          ↓ (regularize)
┌─────────────────────────────────────────────────────────────┐
│ card states                                                 │
│ - per-card FSRS state                                       │
│ - updated directly on review                                │
│ - updated partially by propagation from related reviews     │
└─────────────────────────────────────────────────────────────┘
            ↑                          ↓ (read)
┌─────────────────────────────────────────────────────────────┐
│ path posterior (transient — recomputed each review)         │
│ - Bayesian inference over which paths fired                 │
│ - bridges card observation to edge/related-card updates     │
└─────────────────────────────────────────────────────────────┘
            ↑                          ↓
┌─────────────────────────────────────────────────────────────┐
│ edge associations                                           │
│ - scalar association strength a_e ∈ [0, 1] per edge         │
│ - Hebbian-style update via posterior weight                 │
│ - no FSRS dynamics, slow optional decay                     │
└─────────────────────────────────────────────────────────────┘
```

The verse-chunk layer is optional and additive; the core architecture is cards + edges + path
posterior.

## Notation

| Symbol          | Meaning                                                                                               |
| --------------- | ----------------------------------------------------------------------------------------------------- |
| `c`             | a card                                                                                                |
| `e`             | an edge in the memory graph                                                                           |
| `π`             | a path: an ordered sequence of edges from a card's shown atoms to one of its hidden atoms             |
| `Π_c`           | the set of all paths for card `c` (typically up to some hop limit)                                    |
| `a_e`           | association strength of edge `e`, in `[0, 1]`                                                         |
| `R(π)`          | path probability under current associations: `R(π) = ∏_{e ∈ π} a_e`                                   |
| `S_c, D_c, t_c` | FSRS stability, difficulty, last-review-time of card `c`                                              |
| `R_c(t)`        | retrievability of card `c` at time `t`, computed from `(S_c, D_c, t_c)` via the FSRS forgetting curve |
| `g`             | a grade in `{Again, Hard, Good, Easy}` ↔ `{1, 2, 3, 4}`                                               |
| `α`             | Hebbian rate for edge association updates                                                             |
| `γ`             | propagation rate for card-to-card updates                                                             |
| `β`             | (in chunk layer) chunk influence rate for nudging constituent cards/edges                             |
| `λ_decay`       | (optional) slow decay rate for unused edge associations                                               |

## Card state

Each card carries full FSRS state:

```
struct CardState {
    stability: f32,             // S_c
    difficulty: f32,            // D_c
    last_seen_secs: i64,        // t_c — set on any touch
    last_root_secs: i64,        // last direct-review timestamp
}
```

The `last_root_secs` field tracks the most recent observation where this card was the explicit
subject of a review (rather than nudged via propagation). It serves the role HSRS gives `lastRoot` —
anchoring the state estimate to ground-truth observations and informing scheduler bias toward
stale-ground-truth cards.

### Direct review update

When card `c` is reviewed at time `t` with grade `g`:

```
(S_c, D_c) ← FSRS_step(S_c, D_c, t - t_c, g)
t_c ← t
last_root_secs ← t
```

Standard FSRS dynamics with the existing 21-parameter model. No partial credit, no path inference
involved here — `c` was directly observed.

### Propagated update

When another card `c'` is reviewed and the path posterior implicates shared structure with `c`, `c`
receives a partial FSRS update:

```
(S_c, D_c) ← FSRS_step_with_weight(S_c, D_c, t - t_c, g, w_propagation)
t_c ← interpolate(t_c, t, w_propagation)        // see "timestamp handling"
// last_root_secs unchanged — this was not a direct observation
```

The form of `FSRS_step_with_weight` is itself a design choice — see _Card-to-card propagation_
below.

### Timestamp handling

Direct reviews fully advance both `t_c` (for the forgetting curve) and `last_root_secs` (for
ground-truth tracking). Propagated updates partially advance `t_c` (proportional to propagation
weight) and leave `last_root_secs` alone.

The interpolation rule for partial updates follows HSRS:

```
t_c ← (1 - w) · t_c + w · t_now
```

with `w` being the effective propagation weight in `[0, 1]`.

## Edge associations

Each edge in the graph carries a single scalar:

```
struct EdgeAssociation {
    strength: f32,              // a_e ∈ [0, 1]
    last_used_secs: i64,        // optional, for slow decay
}
```

No `(S, D)`, no forgetting curve. Edge association tracks "how often does activation flow through
this connection during successful recall." It is a property of the _connection's reliability_, not
of the user's recall state.

### Why no forgetting curve on edges

FSRS's forgetting curve is empirically tuned to the dynamics of _item recall_ in human memory. Edge
association strength is a different kind of quantity — closer to ACT-R's `S_ji` associative weights,
which are updated by co-occurrence rather than time-based decay.

If two phrases are repeatedly recalled in succession, the edge between them is _real_ — its
association strength should remain high regardless of when it was last used. If they are _never_
recalled together, the edge should weaken — but slowly, over many failed observations, not via a
power-law decay clock.

This matches the ACT-R framing: chunk activations decay (FSRS-like); chunk-to-chunk associations are
learned from co-occurrence and persist unless contradicted (Hebbian-like).

### Hebbian update form

Adopted form: **log-odds (Bayesian conjugate update).**

Treat `a_e` as the parameter of a Bernoulli "edge fires successfully when activated" distribution.
Maintain its log-odds:

```
λ_e := log(a_e / (1 - a_e))
a_e := σ(λ_e) = 1 / (1 + exp(-λ_e))
```

The update rule (combining with the surprise-based form from _Edge updates via Bayesian inference_):

```
λ_e ← λ_e + α · post_e · surprise
```

where `surprise = observed_R - expected_R` is signed. No explicit saturation factor — the sigmoid's
own diminishing derivative at extremes provides natural bounding.

**Why this form:** equivalent to the Bayesian conjugate update on a Beta-Bernoulli model with
implicit prior count proportional to `α`. The log-odds parameterization is the natural scale on
which evidence is additive: each observation contributes a fixed log-odds increment regardless of
the current value, which matches how Bayesian beliefs actually update under Bernoulli observations.
This composes cleanly if we later want to:

* run principled inference (variational, MCMC) on the association parameters,
* combine slow decay with the update (decay is multiplicative on `λ_e`),
* derive priors from content-similarity metadata (Anchor/Confusion edge classes set initial `λ_e`).

**Alternative forms considered and rejected:**

* _Saturating linear_ (`a_e ← a_e + α · post_e · surprise · saturate(a_e, sign(surprise))` with
  `saturate(a, +) = (1 - a)`, `saturate(a, -) = a`): functionally similar to log-odds for moderate
  `a_e` values but lacks the conjugate-Bayesian provenance. Slightly faster per update; less
  graceful at extremes; doesn't compose as cleanly with downstream Bayesian operations. Cheaper but
  less principled.
* _EMA toward target_ (`a_e ← (1 - α · post_e) · a_e + α · post_e · target`): collapses to a special
  case of saturating linear with binary target, or becomes unbounded if `target` is continuous.
  Provides no advantages.

### Optional slow decay

Edge associations may decay slowly between updates if not used. In log-odds form, decay is a
multiplicative shrinkage of `λ_e` toward 0 (which is `a_e = 0.5`, a maximum-uncertainty prior):

```
λ_e ← λ_e · exp(-(t_now - t_last_used) / TAU)
```

with `TAU` on the order of months. Models the cognitive intuition that unused connections drift back
toward "we don't know" rather than back toward "definitely doesn't fire" — an unused edge is
forgotten, not actively negated.

This composes cleanly with the log-odds update: decay shrinks log-odds toward zero between reviews,
the surprise update pushes them back when reviews provide new evidence. Equivalent to a Bayesian
model where the prior gradually reasserts itself in the absence of observations.

Optional and can be deferred.

## Path posterior at review time

The path posterior is intermediate computation in the single Bayesian update on edge associations
(see _Edge updates via Bayesian inference_). It is computed fresh at each review and not stored.
This section sets up the prior, likelihood, and posterior; the next section uses them to derive the
edge update.

### Path enumeration

For card `c`, enumerate all paths from its shown atoms to its hidden atoms, up to a hop limit. The
existing `path::enumerate_paths` machinery already does this. For a multi-hidden-atom card, paths
are enumerated per-hidden-atom and the per-atom posteriors handled separately (see _Multi-atom
cards_).

### Prior

Without observation, a path's probability under the current edge associations is:

```
P(π) ∝ R(π) = ∏_{e ∈ π} a_e
```

Normalize across `Π_c`:

```
P(π) = R(π) / Σ_{π' ∈ Π_c} R(π')
```

This prior says: "before observing the grade, the path most likely to have carried recall is the one
with the highest product of association strengths." Strong, short paths dominate; long or weak paths
get little prior weight.

### Likelihood

`P(g | π)` — given that the user actually used path `π`, what is the probability of observing grade
`g`? Adopted form (graded outcomes peaked at the path-strength they're most consistent with):

```
P(Again | π) ∝ (1 - R(π))²
P(Hard  | π) ∝ R(π) · (1 - R(π))
P(Good  | π) ∝ R(π)²
P(Easy  | π) ∝ R(π)^k       // with k ≥ 2; sharpens toward strongest paths
```

Each likelihood peaks at the path-strength most consistent with that grade:

* **Again** peaks at low `R` — failures are most likely on weak paths.
* **Hard** peaks at intermediate `R` ≈ 0.5 — effortful-but-successful recall most likely came
  through a path of middling strength.
* **Good** peaks at high `R` — clean success implies a strong path fired.
* **Easy** peaks at very high `R` — effortless recall implies a very strong path.

This is the cleanest closed-form likelihood with no free parameters beyond `k` for Easy. It captures
the empirical claim that a Hard grade is genuinely _informative_ about which path fired (not just an
alternative grading of the same path), which becomes important in the next section.

**Alternative likelihood forms considered and rejected:**

* _Bernoulli with Hard mapped to soft-success_ (`P(Hard | π) = R(π)`): treats Hard the same as Good
  for attribution, losing the information that effortful recall implies a not-fully-strong path.
  Simpler but loses signal.
* _Sigmoid threshold:_ `P(success | π) = σ(k · (R(π) - τ))` with parameters `τ, k`. Realistic but
  adds free parameters per likelihood with no obvious advantage over the closed-form bell-curve
  shapes above.
* _Multinomial logistic:_ `P(g | π) ∝ exp(β_g · R(π) + α_g)` with parameters fit per-grade. Most
  flexible, but requires data to fit and is hardest to reason about. Worth revisiting once user data
  exists.

### Posterior

By Bayes:

```
P(π | g) = P(g | π) · P(π) / Σ_{π' ∈ Π_c} P(g | π') · P(π')
```

This is normalised across `Π_c`. The path posterior is _not_ a separate semantic step; it appears as
an intermediate quantity when we compute the Bayesian update on edge associations (see below).

After observed success, the posterior concentrates on paths whose strength is consistent with
success. After observed failure, on paths whose strength is consistent with failure. After Hard, on
paths of intermediate strength. The posterior is asking "which path is most likely to have fired
given _both_ what we knew before and what we just observed?"

## Edge updates via Bayesian inference

There is one operation here, not two: **adjust each `a_e` given the observed grade, marginalising
over which path actually fired**. The path posterior `P(π | g)` from the previous section is
intermediate computation in this single update; it is not a separate "attribution" step.

### The single update we want

Treat each `a_e` as a parameter we're learning. The Bayesian update is:

```
prior:        current value of a_e
likelihood:   P(g | {a_e}) = Σ_π P(g | π) · P(π | {a_e})
posterior:    new a_e proportional to prior · likelihood
```

The likelihood marginalises over paths because we don't observe which path fired — only the grade.

### The gradient form

For a small step on `a_e`, the gradient of the log-posterior is what determines the update direction
and magnitude. By the standard EM identity:

```
∂/∂a_e  log P(g | {a_e})  =  E_{P(π | g, {a_e})} [ ∂/∂a_e log P(g, π | {a_e}) ]
```

i.e. the gradient is the path-posterior-weighted expectation of the per-path gradient. This is where
the path posterior `P(π | g)` enters: as a _weight_ in the gradient computation, not as a separate
computation we do for some other purpose.

For each edge `e`, the per-path gradient simplifies (under our chosen likelihood form):

```
∂/∂a_e log P(g, π | {a_e}) = (∂/∂a_e log R(π)) · (something depending on g and R(π))
                            = (1{e ∈ π} / a_e)  · (something depending on g and R(π))
```

The bracketed `something` reduces to a signed surprise-like quantity: positive for grades that are
"better than this path's R would predict", negative for grades that are "worse than this path's R
would predict". For our likelihood:

| Grade | Per-path gradient sign on `a_e` (for `e ∈ π`)                                |
| ----- | ---------------------------------------------------------------------------- |
| Easy  | strongly positive                                                            |
| Good  | positive                                                                     |
| Hard  | sign depends on `R(π)` — _negative_ if `R(π) > 0.5_, positive if`R(π) < 0.5` |
| Again | strongly negative                                                            |

This is the user-side intuition mathematically: **a Hard grade on a path the model thought was
strong (`R(π) > 0.5`) decrements that path's edges**, because the strong-path hypothesis predicts
Good or Easy — Hard is evidence against that path's strength estimate. Conversely, Hard on a path
the model thought was weak _reinforces_ those edges.

### Practical update rule

The exact gradient is well-defined but somewhat fiddly to compute. The following log-odds
Hebbian-style approximation is equivalent to a Beta-Bernoulli conjugate update and captures the same
qualitative behaviour:

```
expected_R = Σ_π P(π | {a_e}) · R(π)         // model's predicted recall strength for this card
observed_R = grade_to_score(g)                // {Easy: 1.0, Good: 0.85, Hard: 0.6, Again: 0.0}
surprise   = observed_R - expected_R          // signed; can be negative

post_e := Σ_{π : e ∈ π} P(π | g)              // marginal posterior that edge e was used

λ_e ← λ_e + α · post_e · surprise              // log-odds update
a_e := σ(λ_e)                                 // map back to [0, 1]
```

The sigmoid's diminishing derivative at extremes provides natural saturation: an edge near `a_e = 1`
requires a much larger surprise to push further, but can come back from extremes when contradicted.
No explicit clamps. See _Edge associations / Hebbian update form_ for why log-odds.

This rule has the right qualitative properties:

| Predicted      | Observed | Surprise  | Effect on high-posterior edges                          |
| -------------- | -------- | --------- | ------------------------------------------------------- |
| Strong (R≈0.9) | Easy     | +0.10     | Small reinforcement                                     |
| Strong         | Good     | -0.05     | Tiny correction (Good is barely below "perfect strong") |
| Strong         | **Hard** | **-0.30** | **Decrement** — model overestimated                     |
| Strong         | Again    | -0.90     | Strong decrement                                        |
| Weak (R≈0.3)   | Easy     | +0.70     | Strong reinforcement                                    |
| Weak           | Good     | +0.55     | Reinforcement                                           |
| Weak           | Hard     | +0.30     | Reinforcement (better than predicted)                   |
| Weak           | Again    | -0.30     | Decrement                                               |

The path posterior `P(π | g)` enters via `post_e` — edges only get updated to the extent they're
likely to have actually been used. Edges on paths the posterior says probably didn't fire get small
updates regardless of surprise.

### Why this is principled

After many reviews, the Hebbian-style update with surprise weighting converges toward the same fixed
point as the exact Bayesian update: `a_e` settles where its current value best predicts observed
grades for cards depending on edge `e`. Specifically, `a_e` converges toward the rate at which
recall flowing through `e` succeeds, which is exactly the cognitive content we want for a
graph-association strength.

The math is local — no joint posterior over all edges, no convergence loops. Each review's posterior
involves only `c`'s paths, computed in one pass, and the gradient (or its approximation) is applied
once per edge.

### Multi-atom cards

When `c` has multiple hidden atoms with separate grades, the posterior is computed per-atom and the
per-edge posteriors are summed across atoms. The update applies once per edge with the aggregated
weight. _Care needed:_ aggregated `post_e` across atoms can exceed 1 if an edge appears in paths to
many atoms — see the multi-atom section for handling.

## Card-to-card propagation

For each card `c'` other than `c`, compute a propagation weight from `c`'s review to `c'` based on
the path posterior. This admits multiple options.

### Option P1 — posterior-weighted edge alignment

For each path `π'` in `c'`'s path set, compute the fraction of its edges that have non-trivial
posterior weight from `c`'s review:

```
align(π', post) = Σ_{e ∈ π'} post_e / |π'|
```

Then:

```
prop(c → c') = Σ_{π' ∈ Π_{c'}} R(π') · align(π', post) / Σ_{π' ∈ Π_{c'}} R(π')
```

This is "the expected fraction of `c'`'s recall that flows through edges `c` actually used (per the
posterior), weighted by `c'`'s path probabilities."

`prop(c → c') ∈ [0, 1]`. A card `c'` whose dominant recall paths share many high-`post_e` edges with
`c` gets large propagation. A card whose recall flows through entirely different edges gets
near-zero propagation.

### Option P2 — KL divergence between posteriors

Compute `c'`'s prior (no observation) and `c'`'s posterior under `c`'s observation propagated
through edge associations. Take a divergence between them:

```
prop(c → c') = 1 - exp(-KL(P_prior(π' ∈ Π_{c'}) ‖ P_posterior(π' ∈ Π_{c'})))
```

Cards whose path distributions shift substantially under `c`'s observation get high propagation.
Cards whose distributions barely move get low propagation. More principled than P1 but requires a
second posterior computation per related card per review — substantially more expensive.

### Option P3 — Bayesian update on `c'`'s state directly

Treat `c`'s observation as evidence about the hidden recall reliability of edges shared with `c'`,
then propagate to `c'` via the FSRS update rule directly. This is closest to belief propagation but
local: no iteration, just one update step from the observed card to each neighbour.

### Applying the propagation

Whichever computation produces `prop(c → c')`, the update to `c'`'s state takes the same shape:

```
(S_{c'}, D_{c'}) ← FSRS_step_with_weight(S_{c'}, D_{c'}, t - t_{c'}, g, γ · prop(c → c'))
t_{c'} ← (1 - γ · prop(c → c')) · t_{c'} + (γ · prop(c → c')) · t
// last_root_secs unchanged
```

`γ` is a small global rate (e.g. 0.1–0.2) that controls how much propagation moves `c'` per
related-card review. Several propagated reviews accumulate; consistent signals from many directions
converge `c'`'s state toward the truth without ever directly observing `c'`.

### `FSRS_step_with_weight` — what does partial-strength mean for FSRS?

The standard FSRS step computes one full update. For propagation we want a fractional version. Two
natural definitions:

**Option W1 — interpolation in retrievability space (HSRS-style):**

```
1. Compute next state under full grade: (S', D') = FSRS_step(S, D, Δt, g)
2. Compute current and next retrievability at time t:
   R_now = R(S, D, Δt),  R_next = R(S', D', Δt)
3. Linearly interpolate retrievabilities:
   R_blend = (1 - w) · R_now + w · R_next
4. Solve for stability that produces R_blend at Δt:
   S_blend = invert_R(R_blend, Δt)
5. Linearly interpolate difficulty:
   D_blend = (1 - w) · D + w · D'
```

This is the math HSRS uses for its own probabilistic FSRS update. Bounded, geometrically sensible,
no spurious cancellations. Recommended.

**Option W2 — direct linear blend in stability/difficulty space:**

```
S ← S + w · (S' - S)
D ← D + w · (D' - D)
```

Simpler but reproduces the S1 cancellation pathology if multiple propagations with opposing grades
arrive on the same card before being flushed. Not recommended.

**Option W3 — accumulate weights, defer single update:**

Buffer all propagated updates received between direct reviews; aggregate them into one effective
grade-weight pair; apply Option W1 once at the next direct review. Avoids per-propagation
interpolation cost but delays the schedule effect.

**Recommended:** Option W1 applied immediately on each propagation. The math is HSRS-validated,
computational cost is modest, and the schedule stays current.

## Multi-atom cards

A card with multiple hidden atoms (e.g., full recitation with N phrases hidden) produces N grade
observations in one review. The naive aggregation — sum per-atom posteriors and apply per-atom
surprises additively — gets the wrong answer in two important cases (shared edges in failed
recitations, downstream edges in chain failures). The right model treats edges as participants in a
noisy-AND graphical model under an _activation-flow_ assumption, with joint inference across atoms
to handle shared edges correctly.

### Two firing models

A subtle modeling choice that has large consequences:

* **Probabilistic-firing model.** Every edge fires or not at every review independently with
  probability `a_e`. Path success = all edges fired. Each edge's update is informed by every review.
* **Activation-flow model.** Activation propagates from sources. An edge is _tested_ only if
  upstream activation reaches it. If an upstream edge fails, downstream edges in that path weren't
  tested at all — we have no information about them.

The activation-flow model is more cognitively plausible and produces the right behaviour in
upstream-failure cases. **Adopted: activation-flow.**

### Activation-flow blame distribution for a single failed atom

For a failed path `π = e_1 → e_2 → ... → e_n` (in activation order), the failure happens at the
first edge that didn't fire. Bayesian inference gives the marginal probability that the failure was
at edge `e_i`:

```
P(failure at e_i | path failed) = (∏_{j<i} a_j) · (1 - a_i) / (1 - ∏_j a_j)
```

The corresponding "tested AND failed" probability per edge is:

```
P(reached AND failed | path failed) = same as above for each e_i
```

(They sum to 1 across the path.)

For a 2-edge path with `a_1 = 0.5` and `a_2 = 0.7`:

* `e_1`: blame = `(1-0.5) / (1-0.35) = 0.5/0.65 ≈ 0.77`
* `e_2`: blame = `0.5·(1-0.7) / 0.65 ≈ 0.23`

The first edge gets more blame because it was definitely tested; the second edge gets less because
it was only tested with probability `a_1`.

### Joint inference for shared edges

The crucial extension: when one edge appears in multiple atoms' paths, its "did it fire this review"
outcome is a single shared event. Joint inference over all observed atom outcomes gives a posterior
that's much sharper than per-atom analysis.

For each shared edge `e_s`:

```
P(e_s fired | observations) computed via Bayes:
  P(e_s fired | atoms 1..K outcomes) ∝ P(outcomes | e_s fired) · P(e_s fired)
                                      = P(outcomes | e_s fired) · a_{e_s}
```

`P(outcomes | e_s fired)` is the joint probability of all atom outcomes given that the shared edge
fired (computed by treating each atom's local edges independently given that activation reached the
shared edge).

`P(outcomes | e_s didn't fire)` = 1 if all atoms via `e_s` failed (paths blocked), 0 otherwise.

A successful atom passing through `e_s` forces P(`e_s` fired) = 1. Unanimous failure across atoms
via `e_s` drives P(`e_s` fired) toward 0.

### Worked example: all 4 phrases fail

Card `shown={ref}, hidden={p1, p2, p3, p4}`, paths `ref → gist → p_k`. Suppose `a_{ref→gist} = 0.5`,
`a_{gist→p_k} = 0.7` for all `k`. All 4 atoms fail.

**Configurations consistent with all-fail:**

* Scenario 1: `ref→gist` failed (prob `(1-0.5) = 0.5`). All `gist→p_k` not tested.
* Scenario 2: `ref→gist` fired AND all 4 `gist→p_k` failed (prob `0.5 · 0.3⁴ ≈ 0.004`). All
  `gist→p_k` tested-and-failed.

**Posterior:**

* P(scenario 1 | all fail) ≈ `0.5 / 0.504 ≈ 0.992`
* P(scenario 2 | all fail) ≈ `0.004 / 0.504 ≈ 0.008`

**Marginal updates:**

* `ref→gist`: P(failed) ≈ 0.99 → strong negative update.
* `gist→p_k`: P(tested-and-failed) ≈ 0.008 → essentially no update.

This is the right behaviour: the shared edge absorbs the blame; the per-phrase edges don't move
because they almost certainly weren't reached.

### Worked example: 1 pass, 3 fail

Card `shown={ref}, hidden={p1, p2, p3, p4}`. Atom 2 passes; atoms 1, 3, 4 fail.

**Step 1.** Atom 2's success forces P(`ref→gist` fired) = 1 and confirms `gist→p2` (it was the
firing edge).

**Step 2.** With `ref→gist` known to have fired, atoms 1, 3, 4 failures must be due to their
respective `gist→p_k` edges. Each of `gist→p_1`, `gist→p_3`, `gist→p_4` was reached and failed —
full-weight negative updates.

**Result:**

* `ref→gist`: confirmed-fired. Small positive update from p2's success surprise.
* `gist→p_2`: confirmed-fired. Small positive update.
* `gist→p_1`, `gist→p_3`, `gist→p_4`: full negative updates (reached and failed).

The shared edge is exonerated by the single success; failed-phrase edges are localized as the
specific bottlenecks.

### Adjacency edges (chains)

Adjacency edges enter the path enumeration via the source-set-expansion rule (passed atoms join the
source set for subsequent atoms — already implemented in the existing `credit.rs`). They're not
special; they're just additional edges in the path enumeration.

For a recitation card where p1 passes, p2 passes, p3 fails, p4 passes:

* p1 success: confirms `ref→gist`, `gist→p1`.
* p2 success: paths from `{ref, p1}` include `p1 → p2` (1 hop adjacency) and `ref → gist → p2` (2
  hops via gist). Dominant path determined by relative association strengths under the likelihood;
  for healthy chains, adjacency wins. Confirms whichever wins, plus all upstream edges.
* p3 failure: paths from `{ref, p1, p2}` include `p2 → p3` and `ref → gist → p3`. With shared edges
  confirmed, blame falls on `gist→p3` and `p2→p3` proportional to weakness — both are unconfirmed,
  both are reached (their predecessors fired), both compete for the failure attribution.
* p4 success: paths from `{ref, p1, p2}` (p3 excluded — failed). No chain through p3. Only
  `ref → gist → p4`. Confirms `gist→p4`.

Outcome: failure of p3 localizes between two specific edges — the gist-binding for p3 and the
transition from p2 to p3. As more reviews accumulate, the system identifies which is the actual
bottleneck.

### Edge case: all phrases fail (chain context)

If no phrase succeeds, source-set-expansion doesn't add any sources beyond `{ref}`. Adjacency paths
can't form because their sources require successful predecessors. Only `ref → gist → p_k` paths are
enumerated. As in the worked example above, blame concentrates on `ref→gist`; `gist→p_k` edges
receive essentially no update (they probably weren't reached); adjacency edges aren't on any
surviving path and receive no update at all.

This is correct: chain failures are only diagnosable when at least some chain succeeded — you can
only blame an adjacency edge for a missed transition if you got to its source phrase in the first
place.

### Per-card propagation with multi-atom cards

For card-to-card propagation, the relevant per-edge weight is
`P(edge e fired this review | observations)` — the same posterior computed above. Edges with high
posterior of having fired provide informative signal for related cards; edges that probably weren't
tested don't propagate.

### Why this resolves the magnitude concern

Under the original framing, "hub edges in many atoms" raised the worry that they'd accumulate
disproportionately strong updates. Under AGG-FlowJoint:

* Confirmed-fired hub edges (across multiple successes) get one positive update event's worth, not N
  updates. Confirmation is a binary fact, not an accumulating count.
* Failed-atom contributions to hub edges are dampened by the joint inference: if all atoms via the
  hub fail, the hub gets one strong negative update (not N moderate ones); if some atoms pass, the
  hub is exonerated and gets zero negative contribution.

The "more atoms = more evidence" intuition is preserved for per-atom edges (they each get their own
observation) but corrected for shared edges (they get one shared observation, not N correlated
ones).

### Computational cost

For typical card structures (paths up to 5 hops, 4-5 hidden atoms per recitation card, one shared
root edge), the joint inference is cheap:

* Per-atom: O(|paths|) for posterior computation. Existing path enumeration.
* Joint analysis: enumerate the small number of "configurations" of shared-edge firings (most cards
  have one or two shared edges); compute the conditional likelihood of observations under each.
  O(2^k) for `k` shared edges, with `k` typically ≤ 3.

For pathological cases (dense graphs, many shared edges), variational approximation or sequential
conditional inference makes this tractable.

### Fallback: AGG-Structural heuristic

If the full joint inference is too expensive in some context, a graceful fallback is the simpler
AGG-Structural rule:

1. Process successes; mark edges on dominant successful paths as confirmed-fired.
2. For each failed atom, distribute blame across unconfirmed edges in its path proportional to
   `(1 - a_e) / Σ (1 - a_e')`.
3. Apply log-odds updates with these weights.

This captures most of the structural inference (confirmed edges absorb successes; failures localize
on unconfirmed edges) without the full joint analysis. It systematically over-decrements per-atom
edges in all-fail cases relative to AGG-FlowJoint, but it's a reasonable approximation when joint
inference is impractical.

## Verse-chunk layer (optional)

The verse-chunk layer adds holistic recitation tracking. It is additive to the core architecture and
can be deferred or omitted.

### Motivation

Most edges in verse-vault cannot be tested in isolation — gist nodes aren't displayable, hub edges
participate in many paths, ref-binding edges always involve their constituents. HSRS-style
ground-truth observations of individual edges are impossible.

But the _verse as a whole_ can be tested via full recitation. That observation is genuine ground
truth at the chunk level: did the user recite this verse correctly? It can anchor the system against
inferred-update drift.

### Per-direction chunk state

A "chunk" here is a (verse, retrieval direction) pair:

```
struct VerseChunkState {
    verse_ref: NodeId,
    direction: Direction,       // Forward, Reference, Completion
    stability: f32,
    difficulty: f32,
    last_recitation_secs: i64,
}
```

Where `Direction` distinguishes:

* _Forward:_ `ref → text` recitation.
* _Reference:_ `text → ref` attribution.
* _Completion:_ mid-verse continuation given a partial cue.

These are cognitively dissociable retrieval skills with different forgetting curves. Treating them
separately matches the empirical psychology (Tulving's encoding-specificity, asymmetric
paired-associate learning).

### Update: predict-vs-observe in retrievability space

When the user does a full recitation review (the chunk's "direct observation"):

1. **Predict the chunk's retrievability** under current constituent card states. Several aggregation
   rules:

   * _Product over spine:_ `R_chunk = ∏_{c ∈ spine} R_c(t)` (assumes independent failures of each
     link in the verse spine — recommended starting point).
   * _Minimum:_ `R_chunk = min_{c ∈ spine} R_c(t)` (weakest-link).
   * _Weighted product:_ weight each link by importance / position.

2. **Observe chunk retrievability from grade:**

   ```
   R_observed = { 0.0 if Again, 0.7 if Hard, 0.9 if Good, 1.0 if Easy }
   ```

   (Or, with per-phrase outcome data from the UI, derive `R_observed` from the proportion of phrases
   recalled correctly — much more informative.)

3. **Compute discrepancy:**
   ```
   ΔR = R_observed - R_chunk_predicted
   ```

4. **Apply chunk-level FSRS step** to the chunk's own state with grade `g_chunk`.

5. **Distribute the discrepancy across constituent edges** as a small nudge in retrievability space,
   weighted toward bottleneck edges:

   ```
   for each edge e in spine:
     R_e = R(a_e)              // approximate edge retrievability from association
     bottleneck_weight_e ∝ (1 - R_e)
     edge_ΔR_e = β · ΔR · bottleneck_weight_e (normalised)
     R_e_new = clamp(R_e + edge_ΔR_e, 0.001, 0.999)
     a_e ← invert_R(R_e_new)
   ```

   `β` small (0.05–0.15). Caps total per-recitation nudge magnitude.

### Cross-direction regularization

Reviewing one direction is _weak_ evidence for the others:

```
delta_main = full update on this direction's chunk
delta_cross = γ_cross · delta_main applied to other directions
```

with `γ_cross` small (0.05–0.10). Reflects shared underlying knowledge between forward / reference /
completion without claiming they're identical skills.

### Why edge-only vs chunk-only doesn't suffice

* _Edge-only:_ you cannot observe edges directly, so updates are always inferred. Drift can
  compound.
* _Chunk-only:_ you lose per-edge granularity for diagnostic and propagation purposes.
* _Combined:_ chunk observations anchor the system; per-edge associations carry diagnostic and
  propagation signal. They cross-check each other.

## Ground truth and drift prevention

In the original edge-FSRS architecture, the audit raised a concern that inferred-update drift could
accumulate without correction (S3 territory). Several mechanisms in this proposal address it:

### 1. Direct card observations

Cards are first-class state holders. Every direct review is a real observation of that card's
recall. `last_root_secs` tracks ground-truth events. Drift on a card cannot continue indefinitely —
the next direct review measures reality and the FSRS state update absorbs the discrepancy.

This is the same out-of-app-practice property FSRS itself has, which the edge-FSRS architecture
didn't have for edges (since edges can't be directly observed in isolation).

### 2. Hebbian convergence on edges

Edge associations updated by the path posterior have a clean probabilistic interpretation: `a_e`
converges toward the true success rate of recall flowing through edge `e`. Bayesian convergence
under reasonable assumptions: many noisy observations → posterior → truth.

No ground truth needed at the edge level — the law of large numbers does the work, _provided_ the
posterior is unbiased. The posterior is unbiased by construction (it's exact Bayesian inference on
the likelihood model), so the convergence holds.

### 3. Chunk-level ground truth

The optional verse-chunk layer provides direct holistic observations. Recitation events are real
ground truth at the verse level, independent of whether any individual edge was directly tested.
Chunk states regulate constituent edges via the retrievability-space nudge.

### 4. Scheduler bias toward stale ground truth

The scheduler can prefer cards with old `last_root_secs` even when propagation has been keeping
their state estimates fresh. This ensures each card receives periodic direct observations to anchor
against drift.

### Why this beats history-trace models

ACT-R-style history-trace models compute current state from a complete list of past observations.
They cannot recover from observation gaps (out-of-app practice) without explicit reconciliation
logic. This proposal — like FSRS — uses summary state plus Bayesian-flavoured updates, which absorb
observation discrepancies naturally.

The graph adds structure (which cards are related) without requiring a complete event history.

## Variant: redesigned graph (graded-thing architecture)

> **Status:** active brainstorm. The earlier sections of this doc describe a "cards-primary"
> architecture: cards carry FSRS state, edges carry Hebbian associations, the graph is mostly the
> structure that was inherited from the previous edge-FSRS implementation. This section explores a
> more substantial rethink under three deliberate constraints. It is sibling to (not replacing) the
> cards-primary architecture; both are documented while the design space is still open.

### The constraints

Three commitments that shape this variant:

1. **A thing with FSRS state must be 1-to-1 with grade events.** Every FSRS-stateful element in the
   graph must correspond to something the user can directly grade. No FSRS state on internal
   scaffolding that never receives a direct observation. This rules out FSRS state on
   structural-only nodes (e.g., hierarchical scaffolding without dedicated card types) and on edges
   that no card type tests.

2. **Both nodes _and_ edges can carry FSRS state**, depending on whether some card type grades them
   directly. The architecture is not "FSRS on cards" or "FSRS on nodes" or "FSRS on edges" — it's
   "FSRS on the things that get graded, regardless of whether those are nodes or edges." Things that
   don't get graded are pure structure / connection weights.

3. **Anchors and confusion edges are content-similarity-driven, hybrid of explicit and ignored.**
   For pairs of similar nodes/edges above some similarity threshold, include explicit Anchor or
   Confusion edges with content-derived priors. Below threshold, ignore (no implicit cross-talk,
   avoiding combinatorial explosion). This is option **C** from earlier in the design discussion.

The cards-primary architecture also satisfies (1) and (2) trivially — only cards are graded, and
only cards have FSRS state — but it loses the granularity benefit of node-level / edge-level state.
This variant explores making the state-bearing units finer-grained while preserving the
1-to-1-grading invariant.

### What gets graded in verse-vault

The graded things are the atoms the user must produce or recognise correctly. For each card type,
the grades it produces are:

| Card type                                | Grades produced                                                                                                            |
| ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Reference identification (content → ref) | Book, Chapter, Verse-number (three independent grades — each part of the ref produced by the user is graded separately)    |
| Fill-in-blank (one phrase hidden)        | The specific Phrase                                                                                                        |
| Holistic recitation (full ref + content) | Each Phrase, Book, Chapter, Verse-number, _and_ the verse-gist association (the binding between this content and this ref) |

Three structural insights:

1. **References decompose into three separate graded atoms.** Book, Chapter, and Verse-number are
   independent memories — a user might know the book name confidently while being shaky on the verse
   number, or vice versa. They're modelled as three distinct graded nodes, not as a single conjoined
   "ref" identity.
2. **Phrase grades are local to the specific phrase.** Whether produced via fill-in-blank or as part
   of a full recitation, a phrase getting a grade updates _that phrase's_ state. A recitation card
   produces N phrase grades, one per hidden phrase.
3. **The "verse-gist association" is a separate graded thing.** It represents the binding between
   the verse's content and its citation. Holistic recitation grades it directly: did you produce the
   right content for this ref, _and_ did you correctly bind them together? Knowing the phrases and
   knowing the ref-parts independently isn't enough — you also need to associate them.

### Graph elements

**Graded nodes (carry FSRS state):**

| Node       | Granularity                                                                  | Updated by                           |
| ---------- | ---------------------------------------------------------------------------- | ------------------------------------ |
| Phrase     | one per phrase                                                               | Fill-in-blank, recitation            |
| BookRef    | one per book                                                                 | Reference identification, recitation |
| ChapterRef | one per chapter                                                              | Reference identification, recitation |
| VerseRef   | one per verse (the verse-number specifically, in the context of its chapter) | Reference identification, recitation |

**Graded edges (carry FSRS state):**

| Edge                                | Granularity     | Updated by                       |
| ----------------------------------- | --------------- | -------------------------------- |
| VerseRef ↔ ChapterRef (containment) | one per verse   | "What chapter is this verse in?" |
| ChapterRef ↔ BookRef (containment)  | one per chapter | "What book is that chapter in?"  |
| Verse-gist association              | one per verse   | Holistic recitation              |

The verse-gist association edge is the thing that gets graded when a recitation correctly binds a
body of content to a reference. It connects the verse's content (the set of phrases) to the
reference (the book/chapter/verse triple). It's an edge rather than a node because it represents a
_relationship_ between two existing identities.

The containment edges between ref components are graded by dedicated "what's this thing's parent?"
cards. They capture the user's memory of the hierarchical relationship — separable from the identity
of either endpoint. A user can have a strong VerseRef identity ("verse 16") with a weak VerseRef ↔
ChapterRef containment ("forgot which chapter, but I remember the verse number"), or vice versa.

**Structural elements (no FSRS state, propagation only):**

| Element                                           | Role                                                                               |
| ------------------------------------------------- | ---------------------------------------------------------------------------------- |
| VerseGist node (if retained as a hub)             | Connects phrases to the verse's identity; can be a structural hub or absent        |
| Phrase ↔ Phrase adjacency edges (forward)         | Sequence; participates in propagation but not directly graded                      |
| Phrase ↔ VerseGist (membership)                   | Connects phrases to the verse hub                                                  |
| Anchor edges (cross-verse, content-similarity)    | Hybrid (option C): explicit edges for high-similarity pairs only                   |
| Confusion edges (cross-verse, content-similarity) | Hybrid (option C): explicit edges for high-similarity-divergent-continuation pairs |

Structural elements have **association weights** (Hebbian-updated, log-odds form per Q2), used in
path probabilities and propagation. They don't have FSRS dynamics because they're not directly
graded.

> Containment edges between ref components (`VerseRef ↔ ChapterRef`, `ChapterRef ↔ BookRef`) are
> moved out of "structural" because containment is dissociable from identity — a user can know "this
> is verse 16" while having forgotten which chapter or book it's in. Those edges are graded by
> dedicated cards ("what chapter is this verse in?", "what book is that chapter in?") and carry
> their own FSRS state.

### Notes on what's _not_ graded

A few things excluded from the grading taxonomy worth flagging:

* **Adjacency edges are not directly graded.** Continuation cards ("what comes after p2?") are
  essentially fill-in-blank for the next phrase — they grade the phrase node, not the adjacency
  edge. The adjacency edge is structural, exercised by propagation only.
* **VerseGist as a node is not directly graded.** "Did you understand this verse's meaning?" isn't a
  card type in this taxonomy. The verse's holistic mastery is _derived_ from the states of its
  constituent graded atoms (phrases, ref-parts, association edge), not tracked as a separate hub
  state.
* **Membership edges (VerseGist ↔ Phrase) are not directly graded.** Phrase recall is graded; the
  membership relationship is structural.

The architectural invariant stays clean: every graded thing has a one-to-one correspondence with a
grade event from some card type, and only graded things carry FSRS state.

### What state actually looks like per element

**Graded elements (nodes or edges with FSRS state):**

```
struct GradedState {
    stability: f32,
    difficulty: f32,
    last_updated_secs: i64,            // any update — direct or propagated
    last_directly_graded_secs: i64,    // last direct-grade observation
}
```

The two timestamps are the HSRS pattern: `last_updated` advances on every update (full or partial);
`last_directly_graded` only advances on direct grades, and is the scheduler's ground-truth-staleness
signal.

For graded elements, retrievability `R(t) = forgetting_curve(S, D, t - last_updated)` doubles as the
**association strength** for path-probability computations. A graded element doesn't need a separate
"association weight" — its FSRS retrievability already provides one with rich dynamics.

**Structural elements (no FSRS state):**

```
struct StructuralState {
    association_log_odds: f32,         // λ — current association strength
    association_variance: f32,         // σ² under VI; optional under deterministic heuristics
    last_used_secs: i64,
    prior_log_odds: f32,               // type-specific prior, content-derived for Anchor/Confusion
}
```

Updated by Hebbian rules (log-odds conjugate update from Q2). No FSRS dynamics; slow decay toward
the prior between updates.

### Update flow for a card review

1. **Grade events.** The card produces one or more `(target, grade)` pairs, where `target` is either
   a graded node or a graded edge.
2. **Direct updates.** For each grade event, apply a standard FSRS step to `target.GradedState`.
   Refresh both `last_updated_secs` and `last_directly_graded_secs`.
3. **Path posterior.** Compute the path posterior for the card review (same machinery as the
   cards-primary architecture, but with `R(t)` of graded elements + association strengths of
   structural edges as the input weights).
4. **Propagation.** Walk from each directly-graded element through its outgoing edges. For each
   reachable graded element, apply a partial FSRS step weighted by the propagation weight. Refresh
   `last_updated_secs` (interpolated proportional to weight); leave `last_directly_graded_secs`
   alone.
5. **Hebbian updates** on structural-edge association strengths from observed co-occurrence patterns
   (same as before).

### How nodes and edges interact under propagation

A grade event on a Phrase node propagates to:

* Adjacent Phrase nodes via adjacency edges (graded or structural).
* The Verse node via membership edges.
* Other Phrases in the same verse via Verse → Phrase pathways.
* Cross-verse similar Phrases via Anchor / Confusion edges.

A grade event on an adjacency edge propagates to:

* The source and target Phrase nodes (the grade event implies both were activated).
* Other adjacency edges in the same verse (correlated as part of the verse's recall sequence).
* Possibly the Verse node (a successful continuation implies activation reached this point in the
  sequence).

The propagation rule respects the noisy-AND / activation-flow analysis from the multi-atom section:
graded edges act as both observable elements and as connections between graded nodes. Mathematically
there's no special-case logic — the same path-posterior + AGG-FlowJoint machinery applies, just with
more elements that can be the "directly graded" focal points.

### Anchor and Confusion under option C

Computed at content-authoring time (or precomputed once per translation):

1. **Lexical similarity:** n-gram overlap between phrases / verses.
2. **Semantic similarity:** content embeddings (small model, offline).
3. **Continuation analysis:** for high-similarity pairs, do the continuations diverge or match?

Producing two thresholds:

* High similarity + matching continuations → **Anchor**: explicit edge between the similar elements,
  with a high-prior association strength reflecting the similarity score. Reviews of one pull the
  other along.
* High similarity + divergent continuations → **Confusion**: explicit edge with a _negative_
  coupling prior — reviews of one should _suppress_ the other in propagation (lateral inhibition).
  Used by interleaving / discrimination card scheduling.
* Below threshold → no explicit edge. Cross-verse interactions are absent for these pairs.

Anchor and Confusion edges are structural (no FSRS state) — they're not directly tested by any card
type. They participate in the propagation network with their content-derived priors, shrinking back
toward those priors via slow decay between updates.

### What this variant gives you

**Compared to cards-primary:**

* Finer-grained state. Each phrase has its own (S, D), separable from the verse it lives in.
  Per-phrase mastery is tracked individually.
* More natural handling of card types that test specific connections (continuation, ref-
  identification, hierarchy queries) — those become directly-graded edges/nodes rather than derived
  from broader card outcomes.
* Hub variables (Verse) are explicit, fixing mean-field VI's blind spot for shared structure.
* Cross-verse interference (Anchor, Confusion) is integrated into the graph rather than living in
  side-band metadata.

**Compared to the original edge-FSRS architecture:**

* FSRS state is only where directly observable, not on every edge in the graph. The S1/S2/S3 audit
  issues don't recur because they were specific to FSRS-on-everything.
* Edge associations and FSRS retrievabilities serve different roles cleanly: FSRS for graded
  elements (what the user is being directly tested on), Hebbian for structural connections (how the
  graph propagates information).

### What's still open under this variant

Several earlier open questions have been resolved by the explicit grading taxonomy:

* ~~**Verse vs. VerseGist as graded nodes.**~~ Neither is graded. Holistic mastery is derived from
  constituent atoms (phrases, ref-parts, association edge). VerseGist may be retained as a
  structural hub or absorbed into the membership pattern, but doesn't carry FSRS state either way.
* ~~**Continuation-card grading.**~~ Continuation cards grade the next-Phrase node (same as
  fill-in-blank). Adjacency edges are not directly graded.
* ~~**Discrimination-card grading.**~~ Discrimination targets the verse-gist association edge — the
  binding between content and ref.
* ~~**Holistic recitation grading.**~~ Per-phrase grades + ref-part grades (book, chapter,
  verse-number) + verse-gist association grade. No additional aggregate verse-level grade.

What remains genuinely open:

* **Cold-start values:** new content has no observation history. Each graded element needs default
  FSRS state (per FSRS standard); each structural edge needs an initial association strength (from
  type-specific prior). Anchor / Confusion edges get priors derived from content-similarity scores.
* **Direction of edges:** adjacency stays directional (sequence is asymmetric). Hierarchy edges are
  weakly directional (parent → child differs from child → parent in cognitive role). Anchor /
  Confusion edges are symmetric (similarity is). Membership edges (VerseGist ↔ Phrase) are
  essentially symmetric / structural.
* **Identifiability under VI:** if some structural edge always co-occurs with the same set of graded
  elements in every observation (e.g., a membership edge that's never the focal element of any
  path), the variational posterior won't distinguish its association weight from neighbouring
  contributions. Worth checking once card types are pinned down.
* **Recitation card variants:** the holistic recitation card type produces many grades at once.
  Variants of recitation cards (e.g., "recite from the second phrase onward") would produce subsets
  of these grades. Need to specify the full card-type catalogue before finalizing what each one
  grades.
* **Where the verse-gist association edge attaches:** the binding edge has two endpoints. One is the
  verse content (the set of phrases, possibly via a structural hub node); the other is the reference
  (which itself is decomposed into book/chapter/verse parts — does the association edge attach to
  the VerseRef node, or to the chapter-level / book-level separately, or to all three?). Probably
  attaches to the VerseRef as the "leaf" of the ref-chain, with the hierarchy edges providing
  structural propagation up to chapter and book.
* **Cross-reference between this taxonomy and the path posterior math:** the existing math assumes
  paths terminate at "hidden atoms." Under the graded-thing variant, a card review produces grades
  at multiple targets simultaneously (e.g., recitation grades phrases _and_ ref-parts _and_ the
  binding). The path posterior + AGG-FlowJoint machinery generalizes fine, but the bookkeeping needs
  to be explicit about which graded element each grade belongs to.

### Relation to the cards-primary architecture

This variant is _not_ a strict superset or refinement of the cards-primary architecture — it's a
sibling. The fundamental modeling commitment is different:

* Cards-primary: a card is the unit of memory; the graph is for propagation.
* This variant: nodes and edges are the units of memory; cards are events that grade them.

Both architectures could implement the same set of card types and produce qualitatively similar
predictions, but their state-bearing units are different and their growth paths diverge. Worth
comparing on simulation data once both are prototyped.

## Open questions

To answer iteratively as the architecture is prototyped:

1. ~~**Likelihood form for Hard grade.**~~ **Resolved.** The likelihood is
   `P(g | π) ∝ R(π)^a · (1 - R(π))^b` with `(a, b)` matched to the grade — Again at `(0, 2)`, Hard
   at `(1, 1)`, Good at `(2, 0)`, Easy at `(k, 0)` for `k ≥ 2`. Each grade peaks at the
   path-strength most consistent with that outcome. Crucially, the original "two steps" framing
   (path attribution then parameter update) was wrong — there is one Bayesian update on `a_e` that
   marginalises over paths; the path posterior is intermediate computation in that single update.
   Hard given a model-predicted-strong path automatically decrements that path's edges because the
   Hard observation is unlikely under the strong-path hypothesis. The surprise-based Hebbian rule
   (`Δa_e ∝ post_e · (observed_R - expected_R) · saturate`) is the practical approximation of the
   exact gradient. See _Edge updates via Bayesian inference_ for the derivation.

2. ~~**Hebbian update form.**~~ **Resolved.** Adopted: log-odds (Bayesian conjugate) update.
   `λ_e ← λ_e + α · post_e · surprise`, with `a_e = σ(λ_e)`. Equivalent to a Beta-Bernoulli
   conjugate update with implicit prior count proportional to `α`. Chosen over saturating-linear for
   the principled provenance, graceful behaviour at extremes, and clean composition with downstream
   Bayesian operations (slow decay as multiplicative log-odds shrinkage; content-derived priors as
   initial `λ_e`; future variational/MCMC inference if desired). The slight overhead of
   sigmoid/logit conversions is acceptable given the goal is a principled memory model, not a
   minimal SRS. See _Edge associations / Hebbian update form_.

3. ~~**Multi-atom aggregation.**~~ **Resolved.** Adopted: **AGG-FlowJoint** — activation-flow model
   with joint inference across atoms. Per-atom-independent aggregation gets the wrong answer in two
   important cases (shared edges in failed recitations, downstream edges in chain failures). Under
   activation-flow, an edge is _tested_ only if upstream activation reaches it; if upstream fails,
   downstream parameters shouldn't update on that observation. Joint inference for shared edges (one
   "did `ref→gist` fire" event across all atoms) produces sharp posteriors: a single success forces
   the shared edge confirmed; unanimous failure drives it strongly toward "didn't fire" while
   leaving per-atom downstream edges essentially untouched. Fallback for tractability:
   AGG-Structural heuristic (confirm successes, distribute failure blame proportional to weakness
   across unconfirmed edges). See _Multi-atom cards_.

4. **Card-to-card propagation form.** P1 (posterior-weighted edge alignment) is recommended for
   simplicity; P2 (KL divergence) is more principled but expensive. Worth comparing on synthetic
   data before committing.

5. **Hyperparameter values.** `α` (Hebbian rate), `γ` (propagation rate), `β` (chunk influence),
   `γ_cross` (cross-direction), `λ_decay` (edge association decay). Need either hand-tuning against
   simulation or data-driven fitting.

6. **Should difficulty propagate?** HSRS says no — only direct reviews update D. This proposal
   currently inherits that. Worth revisiting whether soft propagation of difficulty makes sense for
   verse-vault's domain (where item-difficulty interpretation is hazier).

7. **Retrievability inversion stability.** Option W1 requires inverting the FSRS retrievability
   function. This is monotonic and well-defined but numerically delicate near the bounds. Need
   bounds checking wherever `invert_R` is called.

8. **Recitation grade granularity.** Should the chunk-level grade be a simple Again/Hard/Good/Easy,
   or per-phrase pass/fail (much more informative)? UI design choice with significant data-quality
   implications.

9. **Cold-start for new cards.** Initial card state and edge associations need defaults. FSRS
   already defines initial `(S, D)` per grade; for edges, a uniform `a_e = 0.5` is reasonable but
   could be refined (e.g., higher for structurally-mandatory edges like adjacency, lower for
   cross-verse anchor edges).

10. **Interaction with the discrimination / interleaving mechanism** (the InterferenceMap proposal).
    Confusion-pair cards generated from the InterferenceMap would have unusual path structure (cues
    from one verse, hidden atom from another). The path posterior for such cards needs to account
    for this — probably requires explicit modeling of the `Confusion` relation as a
    negative-correlation prior.

11. **Does the chunk layer pull its weight?** It adds complexity. Need to verify on simulation that
    holistic recitation observations measurably reduce drift relative to a card-only architecture.

12. **Is association decay needed at all?** The Hebbian update naturally moves associations toward
    observed reliability. Decay adds an additional pull toward zero for unused edges. Whether this
    is cognitively right or just produces unhelpful "all edges weaken over time" behaviour is
    unclear without simulation.

13. **Path enumeration cost.** Multi-atom cards with many shown atoms can produce many paths. The
    hop limit and path-count caps need to bound this without losing important paths. Existing
    `MAX_HOPS = 5` is probably fine but should be sanity-checked.

14. **What replaces anchor transfer?** Current anchor transfer scopes cross-verse paths to ref nodes
    in the same chapter with distance decay. Under the new architecture, this would be encoded as
    `Anchor` edge types (per the InterferenceMap) feeding into the path enumeration with appropriate
    prior weights. Whether the existing `decay_multiplier` semantics are preserved or refactored is
    open.

15. **Migration strategy** (out of scope for this doc but flagged): moving from edge-FSRS state to
    per-card FSRS + per-edge associations requires either re-initializing all state or deriving the
    new representation from existing state. Either way is a one-time cost.
