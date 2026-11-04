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

### 3. Each chunk start is a practised handoff

Handoffs are where a reciter blanks or picks the wrong connector, so a lead-in whose exact wording
matters keeps its own chunk even when it is short.

* Kept (John 5:16): `For this reason / the Jews persecuted Jesus,`. Merging hides wording that is
  easy to misquote.
* A speech tag that opens a quotation stays separate from it:
  `The sick man answered Him, / “Sir, …`.
* A tag that follows narrative stays with the narrative. Kept (John 5:14):
  `Afterward Jesus found him in the temple, and said to him,`; splitting off `and said to him,`
  makes a throwaway chunk.

### 4. Each chunk can fail on its own

No fragment that only makes sense glued to its neighbour.

* Rejected (2 Corinthians 11:24): `From the Jews / five times I received forty stripes minus one.`
  Agreed instead: `From the Jews five times / I received forty stripes minus one.`

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

Both split or both whole; the mirror is what carries the reciter through.

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

The audit (`tools/evaluate_phrases.py`) reports deterministic signals for each split; the splitter
and judge prompts show them. They are context, not rules. Names and shapes are fixed in
`specs/008-recitation-splits/contracts/signals.md`:

* `long_run`, with the phrase's `pause_points` (each with the cue that marks it: `punct`,
  `relative`, `content_clause`, `line_break`, `list`, `parse`, or the weak `coordinator` and
  `preposition`).
* `no_pause_cue`: a cut with no punctuation before it and no clause edge after it. A short
  sentence-opening lead-in is exempt.
* `boundary_severance` (`verb_content`, `bare_relative`, `stranded_stub`): a cut at a known cue
  inside a short run.
* `lost_line_break`, `parallel_asymmetry`, `list_breaks` (`word_list_cut`, `lead_in_merged`,
  `clause_items_merged`), `missing_split`.

Some judgements have no surface cue. "Into the pool / when the water is stirred up" looks just like
the accepted "a certain man was there / who had an infirmity", so no signal catches it; the criteria
above have to.

## The judge's tie-break

The judge compares the current split (A) against a proposal (B) and picks B only when it is clearly
better under these criteria. When the two are equivalent, it keeps A: needless churn is bad.
