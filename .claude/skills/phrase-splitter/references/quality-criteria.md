# Splits for word-perfect recitation

The decks serve Bible quizzing, which is word-perfect: knowing the gist is not enough. The wording
of a lead-in ("For this reason" against "Therefore") is often exactly what slips.

A reciter says a verse in _runs_, stretches said in one go. Errors cluster in two places: at the
handoffs between runs (a blank, the wrong connector, skipping ahead) and inside a run (a word
swapped for a near-synonym or for the wording of a similar verse). Each phrase carries its own FSRS
recall state, so the split decides what is practised as one unit. **A good split matches the runs.**

These criteria were agreed with the maintainer over a review of about 50 verses across years 3 to 8.
That review is committed as `tools/phrase_splitter/reference_set.json` (word counts, with rejected
alternatives) and `tools/evaluate_phrases.py --calibrate` scores the audit against it.

## How phrases are reviewed

Each phrase is reviewed in two modes, and the split is the partition both operate on.

* **PhraseFill** (`CardKind::PhraseFill`, `crates/core/src/card.rs`). The verse is shown with one
  phrase blanked; the reciter recovers it, and the grade updates that phrase's state.
* **Recitation** (`CardKind::Recitation`). Only the reference is shown; the reciter recites the
  whole verse, and one grade is decomposed across every phrase's state.

A boundary is only worth having where the reciter could fail one side and not the other. Bundling
two runs under one state lets a slip in one drag down the other; cutting inside a run makes a
throwaway chunk that is recalled, or not, together with its neighbour.

## The criteria

### 1. Cut where you would naturally pause reciting aloud

A cut inside a run feels wrong, because the reciter's run passes straight through it.

Rejected (John 5:7): `“Sir, I have no man to put me into the pool / when the water is stirred up;`.
"To put me into the pool when the water is stirred up" is said in one go.

Punctuation is evidence of a pause, not the test. Three pauses recur in the agreed splits with no
comma to mark them:

* **After a long subject or a fronted object, before its verb.** Agreed (John 6:56):
  `He who eats My flesh and drinks My blood / abides in Me, / and I in him.`; (1 Samuel 17:25):
  `and it shall be that the man who kills him / the king will enrich with great riches,`; (Exodus
  12:40): `… who lived in Egypt / was four hundred and thirty years.`. A short subject keeps its
  verb: rejected (Isaiah 6:4) `And the posts of the door / were shaken by the voice …`, agreed
  `And the posts of the door were shaken / by the voice of him who cried out,`.
* **Before a completing phrase that is itself a run** (four or more words) in a long run. Agreed
  (Psalm 32:8): `I will instruct you and teach you / in the way you should go;`. A short completion
  stays with its verb: `to put me into the pool` (John 5:7).
* **Before a relative or "that" clause of four or more words**, with or without a comma. Agreed
  (John 5:15): `The man departed and told the Jews / that it was Jesus who had made him well.`. A
  relative of three words is not severed from its noun (`the one who told you`).

### 2. A chunk is one run

Usually 3 to 10 words, longer only when there is no pause point. Pressure to split is strongest on a
long run that contains a pause point; below about 10 words a cut has to earn its place.

Agreed (Judges 2:16), a 17-word run split at its relative clause:

```
Nevertheless, the Lord raised up judges
who delivered them out of the hand of those who plundered them.
```

Agreed (John 5:15), split at a "that" clause:

```
The man departed and told the Jews
that it was Jesus who had made him well.
```

Kept whole (John 5:7): `“Sir, I have no man to put me into the pool when the water is stirred up;`,
17 words with no natural pause.

Pressure to cut grows with length, not with the number of chunks: seven chunks of eight words are
seven runs, not an over-split. Length is measured by breath, which the audit estimates in syllables
(`in infirmities, in reproaches, …` is 10 words but about 20 syllables). Over about 10 words, a run
holding a pause of any kind in criterion 1 should be cut there; a run of 11 to 13 words with no
pause stays whole.

### 3. Each chunk start is a practised handoff

Handoffs are where a reciter blanks or picks the wrong connector, so a lead-in whose exact wording
matters keeps its own chunk even when it is short.

* Kept (John 5:16): `For this reason / the Jews persecuted Jesus,`. Merging hides wording that is
  easy to misquote.
* A speech tag that opens a quotation stays separate from it:
  `The sick man answered Him, / “Sir, …`.
* A lead-in of three or more words whose wording can slip is a chunk, not a stub, whether or not it
  is a sentence: `For this reason` (John 5:16), `Now therefore, behold,` (Exodus 3:9). A short chunk
  that is a handoff is never a fault in itself.
* A tag that follows narrative stays with the narrative. Kept (John 5:14):
  `Afterward Jesus found him in the temple, and said to him,`; splitting off `and said to him,`
  makes a throwaway chunk.

### 4. Each chunk can fail on its own

The reciter could blank or misquote this chunk while getting its neighbours right. That is a test of
recall, not of grammar: a lead-in, a subject, a fronted object or a clause opener passes it without
being a sentence, because its wording can slip on its own. A chunk fails it only when its wording is
forced by the chunk before it (`But one / and the same`) or when it is too slight to be a handoff of
its own.

* Rejected (2 Corinthians 11:24): `From the Jews / five times I received forty stripes minus one.`
  Agreed instead, weakly: `From the Jews five times / I received forty stripes minus one.`

A verse that starts mid-sentence is the exception: its opening words are where a reciter picks the
verse up, so a short opening can be a handoff of its own. John 5:29 continues 5:28's "all who are in
the graves will hear His voice", and `and come forth / those who have done good, …` is acceptable
there, though the maintainer kept the verse at two phrases.

### 5. Lists

Two kinds, told apart by what the items are.

* **Word list**: each item is a word or a short noun phrase (1 to 3 words) with no verb of its own.
  The list itself is the memory item (which items, in what order), so it is one chunk. A lead-in
  that can stand as a run is kept out of it:

  ```
  Therefore I take pleasure
  in infirmities, in reproaches, in needs, in persecutions, in distresses,
  for Christ’s sake.
  ```

  A lead-in that can't stand alone stays with the list (`that any people, nation, or language`).
  Split a word list only when it is longer than one run or its items lengthen partway (Romans 9:4,
  cut after `the covenants,` where `the giving of the law` begins). Short lists and fixed groups
  (`Shadrach, Meshach, and Abed-Nego`) rarely need their own chunk; a colon before a list tips
  toward one (`And Noah begot three sons: / Shem, Ham, and Japheth.`).

* **Clause list**: each item has its own verb or is a run in itself. Each item preferably gets its
  own chunk (Hebrews 4:12,
  `piercing even to the division of soul and spirit, / and of joints and marrow,`); merging two
  short items is acceptable but slightly worse.

### 6. Parallel halves get matching cuts

Parallel halves are two clauses of the same shape, usually with mirrored wording. Both split or both
whole; the mirror is what carries the reciter through. Two clauses that merely share an `and` are
not parallel halves, and a long half with a pause point is still cut.

Kept (1 Corinthians 12:3), both halves whole:

```
Therefore I make known to you
that no one speaking by the Spirit of God calls Jesus accursed,
and no one can say that Jesus is Lord except by the Holy Spirit.
```

Rejected: the same with only the second half cut before `except by the Holy Spirit.`

## Evidence, not criteria

Punctuation, meaning and grammar are evidence of where pauses fall. Commas, semicolons and dashes
usually mark a breath. A relative clause (`who`, `which`, `in which`) or a `that` clause often
starts a new run in a long sentence. In NKJV poetry each line is usually its own run, and a
capitalized `And` or `But` in the middle of a phrase marks a line that was joined (Isaiah 55:10,
`That it may give seed to the sower / And bread to the eater,`).

"Amen" or "Selah" standing alone is fine.

## Hard constraints

These are blockers; the audit refuses a deck that breaks them.

* **Rejoin.** The phrases' words, in order, are the canonical verse's words. Replies are checked
  token by token (whitespace or em dash), with curly and straight quotes treated alike, so a phrase
  may end on a dash (`and come forth—`).
* **Word counts sum** to the canonical token count from api.bible.
* **HTML tags balance inside each phrase.** A split never falls inside `<b>`, `<i>` or `<span>`.

## Signals

The audit (`tools/evaluate_phrases.py`) computes deterministic signals for each split; names and
shapes are fixed in `specs/008-recitation-splits/contracts/signals.md`. The LLM prompts never see
the numbers. They get plain-language flags, each under the criterion it tests and marked strong or
weak:

* **Criterion 1**: a cut at a known cue inside a short run (strong: a verb cut from its clause, a
  short relative cut from its noun, a stranded fragment); a cut with no punctuation and no clause
  opener (weak: it can't see the pause after a long subject or fronted object, or before a
  completing phrase, so a cut there is fine); a poetry line joined into a phrase (strong).
* **Criterion 2**: a phrase running past one breath, with the pause cues inside it. Strong when a
  cue is punctuation, a relative or "that" clause, a line break, a list start or a parse edge; weak
  when the only cues are "and" or a preposition, in which case staying whole may be right.
* **Criterion 5**: a short word list cut between items (strong); a standalone lead-in merged with
  its list, or two clause-list items in one phrase (weak).
* **Criterion 6**: parallel halves cut differently (strong).

Criteria 3 and 4 have no signals. Some judgements have no surface cue at all: "into the pool / when
the water is stirred up" looks just like the accepted "a certain man was there / who had an
infirmity", so no signal catches it; the criteria above have to.

## Choosing between splits

Each candidate is rated on its own, then a selector picks. Candidates with a clear break of the
criteria are set aside first; then the fewest and mildest remaining cons win. When two are still
level, the maintainer's tie-break picks the one with more phrases: a cut that lets a slip be caught
on one side alone is worth having. On an existing deck the churn guard comes first: the current
split stays unless another candidate removes a clear break and adds none.
