# Each phrase is a memorisable chunk

That is the guiding principle. There are no rules, only signals; every verse is subjective.

A phrase is a _memorisable unit_ — a chunk a reciter could blank on while still sensing the specific
shape of the gap from what's left. The job of the split is to partition the verse into chunks each
doing a discrete job, so that forgetting one of them leaves a recognisable hole rather than a fuzzy
mid-thought blur.

Critically, this is **not** the same as "each phrase reads as a complete sentence." A 4-word framing
intro like _"but these are written"_ doesn't stand alone as prose, but it's a perfectly valid
memorisable chunk — it does a discrete job (introducing what follows) distinct from the content it
introduces. Partition by _function_, not by grammatical completeness.

Aim for the _best_ split, which is not always a different split. Two fragments doing the _same_ job
(setup and payoff of one thought) usually want to be one phrase: a 9-word complete clause beats 4 +
5 that severs the thought. Two fragments doing _different_ jobs (framing intro + the content it
introduces) usually want to be separate phrases, even when one is short. **Length is not a hard
rule.**

## Why split at all — the FSRS granularity argument

Each phrase carries its own FSRS recall state in the deck. The algorithm has a strong opinion on
what that should mean: bundling two memorisable pieces under one state actively _destabilises_ both.
The composite-memory stability follows roughly

```
S = (S_a × S_b) / (S_a + S_b)
```

— always lower than either piece alone, and approaching zero as you compose more pieces.
[Memory Complexity in the open-spaced-repetition wiki](https://github.com/open-spaced-repetition/awesome-fsrs/wiki/Spaced-Repetition-Algorithm%3A-A-Three%E2%80%90Day-Journey-from-Novice-to-Expert#memory-complexity)
has the derivation; the takeaway is that flashcard atoms should be atomic from the start, and the
algorithmic pressure runs toward _finer_ splits.

There's a counter-pressure from the reciter's side: each phrase has to be a unit the reciter can
blank, recover, and grade honestly. A "phrase" that can't be recovered from context can't receive a
clean `Again` / `Good` signal — its FSRS state becomes noise rather than information. That's the
floor on how fine you can go: an atom that nobody can grade independently is worse than a coherent
composite.

The recall test below is the operational test for whether a candidate phrase clears that floor. The
two pressures combined: split as finely as you can _while keeping every phrase recoverable_.

## Hard constraints

These three failures are blockers — the auditor flags them as `blockers` and the deck can't be
written until they're fixed:

* **Rejoin invariant.** `" ".join(phrases) == text` — exact match including HTML tags, punctuation,
  and quotation marks. If a split doesn't round-trip, it's wrong.
* **Word counts sum.** The per-verse `phraseWordCounts` must sum to the canonical token count from
  api.bible. Drift means the deck and canonical text disagree.
* **HTML tag balance inside each phrase.** Every `<b>`, `<i>`, `<span ...>` open inside a phrase
  must close inside the same phrase. A split that falls inside a tag fails this check.

## Signals (context, not rules)

These are cues the auditor surfaces and the splitter sees. Treat each as a question worth asking,
not a prohibition.

* **Cognitive weight.** Phrases dense with content words are heavier than equally long phrases thick
  with function words. `of the spirit of the world which is in him` is long but light;
  `judging righteous judgment by faithful witness` would be heavier at the same word count.
* **Parallel structure.** Coordinated items at the same syntactic level often want to land as
  sibling phrases of similar shape — `not many wise, / not many mighty, / not many noble`.
* **Weak-connector starts.** A phrase opening with `and`, `but`, `that`, `which`, `who` often
  signals it was glued back onto the previous one. Check whether the boundary should move or
  disappear.
* **Verb + content clause.** `that`, `what`, `how`, `whether` after a perception/speech verb
  (`know`, `see`, `tell`, `believe`, `understand`, …) usually introduces the _object_ of the verb,
  not a new clause. `"Do you not know"` / `"that we shall judge angels?"` is one unit, not two.
* **Restrictive relatives.** When `that`, `who`, or `which` follows a noun _without_ a preceding
  comma, the relative restrictively modifies the noun and reads as one unit. `"nothing was made"` /
  `"that was made."` severs it. A _non-restrictive_ relative (preceded by a comma) is the opposite —
  the comma is a real pause and a valid break.
* **Mid-clause endings.** A phrase that ends without any pause punctuation often wants to extend
  until it reaches a natural break.
* **Lopsidedness.** One phrase swallowing most of the verse while the rest are stubs often signals a
  missed boundary. Aim for relatively even chunks while still respecting clause boundaries.

## The recall test

Mentally blank each candidate phrase. Can the reciter sense the specific shape of what's missing
from what's left? If yes — the gap has a recognisable function (the verb, the content clause, the
relative modifier, the parallel sibling) — the boundary is doing useful work, because the blanked
piece is something a reciter could plausibly fail _without_ failing its neighbours. If the blanked
phrase leaves a fuzzy mid-thought gap that's hard to characterise, the two sides are one mental move
— they always succeed or fail together — and the boundary is in the wrong place.

The test is _not_ whether each phrase reads as a stand-alone English sentence. Memorisable units
include short framing phrases ("but these are written"), appositive chunks, and parallel siblings —
all of which are fine even when they don't make sense in isolation as prose. What matters is that
each chunk is doing a discrete job different from its neighbours.

This is the test both the splitter and the judge apply. The splitter uses it to construct its honest
best split (no stability bias — just the recall test). The judge uses it to compare two concrete
options and pick the better one. When the two options pass the test equivalently, the judge picks
the current split (option A); needless churn is bad. Stability lives in the judge's tie-break, not
in the splitter.

## Worked examples

Each tagged with the signal(s) that drove the decision.

### Long clause that needs a break — _parallel structure_

Bad:

```
["For you see your calling, brethren, that not many wise according to the flesh,",
 "not many mighty, not many <b>noble</b>,",
 "are called."]
```

Phrase 1 is 14 words. Break on the comma after `brethren,` so the parallel items each get a phrase:

```
["For you see your calling, brethren,",
 "that not many wise according to the flesh,",
 "not many mighty, not many <b>noble</b>,",
 "are called."]
```

### Stranded fragment — _weak-connector start, mid-clause ending_

Bad (1 Cor 12:11):

```
["But one",
 "and the same Spirit works all these things,",
 "<b>distributing</b> to each one individually as He wills."]
```

`"But one"` is two words ending mid-clause; phrase 2 opens with a weak connector that glues right
back onto it. The natural break is after the comma:

```
["But one and the same Spirit works all these things,",
 "<b>distributing</b> to each one individually as He wills."]
```

### Restrictive relative — _restrictive-relative boundary, mid-clause ending_

Bad (John 1:3):

```
["All things were made through Him,",
 "and without Him nothing was made",
 "that was made."]
```

`"that was made"` restrictively modifies `"nothing"` — no comma precedes it, and the emphatic
doubling reads as one breath. The boundary auditor flags this. Break only at the real pause:

```
["All things were made through Him,",
 "and without Him nothing was made that was made."]
```

### Verb + content clause — _verb-content-clause boundary_

`"Do you not know"` / `"that we shall judge angels?"` severs `know` from its content clause. Keep
the rhetorical question whole:

```
["Do you not know that we shall judge angels?",
 "How much more, things that pertain to this life?"]
```

### Whole-verse short verse — _cognitive weight_

`"For the kingdom of God is not in word but in power."` — 10 words, one self-contained idea, low
content-word density. One phrase is correct; forcing a break would weaken the unit.

### HTML markup — _hard constraint_

`"<b><i>asking</i></b>"` is one word, one indivisible unit. A split that opens a tag in one phrase
and closes it in another fails the HTML-balance blocker check. Always preserve markup byte-for-byte.
