# Feature Specification: Recitation-Based Phrase Splits

**Feature Branch**: `feat/recitation-splits`

**Created**: 2026-11-04

**Status**: Draft

**Input**: User description: "Recitation-based phrase splitting for the phrase-splitter tooling.
Goal: splits that serve word-perfect Bible-quizzing recitation. Replace the current
grammar/meaning-centred criteria with six agreed recitation criteria, add free deterministic auditor
signals plus an optional dependency-parse signal, rewrite the splitter and judge prompts around the
criteria with worked examples from a user-reviewed reference set, show NKJV em dashes to the LLM,
commit the reference set and a calibration check. Re-splitting the decks is out of scope."

## Background

Each year deck stores a verse's memorization phrases as word counts over the canonical NKJV text.
Every phrase carries its own review state, so the split decides what the learner practises as one
unit. The current tooling judges splits by grammar and meaning, and its auditor rates the decks as
nearly clean (3 to 8 verses per deck above 0.3), while the maintainer finds many splits poor for
recitation.

Bible quizzing is word-perfect. Knowing the gist is not enough, and the wording of a lead-in ("For
this reason" against "Therefore") is often exactly what slips. A reciter says a verse in _runs_,
stretches said in one go, and errors cluster at the handoffs between runs and at swapped words
inside them. A good split matches the runs.

The maintainer and Claude reviewed about 40 verses across every phrase-split deck and agreed these
criteria:

1. **Cut where you would naturally pause reciting aloud.** A cut inside a run feels wrong ("into the
   pool / when the water is stirred up").
2. **A chunk is one run**, typically 3 to 10 words, longer only when it has no pause point. Pressure
   to split is strongest on long runs that contain a pause point; below about 10 words a cut must
   earn its place.
3. **Each chunk start is a practised handoff.** Lead-ins whose exact wording matters keep their own
   chunk, and speech tags ("Jesus said to him,") stay separate from the quotation.
4. **Each chunk can fail on its own**, independently of its neighbours.
5. **Lists.** A _word list_ (items of 1 to 3 words, no verb of their own) is itself the memory item:
   one chunk, with the lead-in kept out when the lead-in can stand as a run. Split it only when it
   is longer than one run or its items lengthen partway. Short lists, fixed groups ("Shadrach,
   Meshach, and Abed-Nego") and lead-ins that cannot stand alone ("that any") stay together; a colon
   before a list tips toward a cut. In a _clause list_ each item preferably gets its own chunk;
   merging two short items is acceptable but slightly worse.
6. **Parallel halves get matching cuts**: both split or both whole.

Punctuation, meaning and grammar are evidence of where pauses fall, not criteria in themselves.

## User Scenarios & Testing _(mandatory)_

### User Story 1 - The audit surfaces the splits that hurt recitation (Priority: P1)

The maintainer runs the phrase audit on a year deck and gets a worklist led by the verses whose
splits break the recitation criteria: long runs left whole despite a pause point, cuts inside a run,
lost poetic line breaks, mismatched parallel halves. Short lead-in and speech-tag phrases are no
longer pushed toward merging.

**Why this priority**: Every later step (the LLM splitter, rater and selector) only sees what the
audit surfaces. Today the audit misses most of the problems, so nothing downstream can fix them.

**Independent Test**: Run the audit on each deck and compare its worklist with the reference set; it
delivers value on its own as a review list even before any prompt changes.

**Acceptance Scenarios**:

1. **Given** Judges 2:16 split as a single 17-word phrase, **When** the audit runs with default
   settings, **Then** the verse appears on the worklist with a signal naming the pause point before
   "who delivered them".
2. **Given** Isaiah 55:10 with "That it may give seed to the sower And bread to the eater," as one
   phrase, **When** the audit runs, **Then** it reports a lost poetic line break before "And".
3. **Given** John 5:16 with "For this reason" as its own phrase, **When** the audit runs, **Then**
   no signal pushes that phrase to merge with its neighbour.
4. **Given** a split whose parallel halves are cut differently (one half split, its mirror whole),
   **When** the audit runs, **Then** it reports the asymmetry.
5. **Given** a deck checkout without the optional parsing extra installed, **When** the audit runs,
   **Then** it completes using the punctuation and word-based signals and says the parse signal was
   skipped.

---

### User Story 2 - The LLM steps propose, rate and pick splits by the criteria (Priority: P1)

For each worklist verse, the splitter (Haiku or Sonnet) proposes one to three distinct candidate
splits. A rater rates every candidate and the current split one at a time, without knowing which is
current: pros, cons and a score against the recitation criteria. A selector (Sonnet) reads all the
candidates with their ratings and picks the best. With the churn guard on, it keeps the current
split unless another candidate is clearly better. Every step reads the recitation criteria, sees
worked examples drawn from the reference set, sees the verse with its em dashes, and sees the new
signals.

**Why this priority**: The audit finds problems; the LLM steps fix them. A single proposal has to
land at exactly the right granularity, which a cheap model often misses (it under- or over-splits);
several candidates rated separately let the choice happen downstream, and rating each split on its
own avoids the position bias of an A/B comparison.

**Independent Test**: Run the splitter on the reference-set verses with the current split hidden and
compare its candidates with the agreed and acceptable splits; run the rater and selector on
candidate sets built from the reference set's agreed, acceptable and rejected splits.

**Acceptance Scenarios**:

1. **Given** the prompt for John 5:29, **When** it is rendered for the LLM, **Then** the verse text
   shows "come forth—those who" with the dash, while the word counts used to apply the split are
   unchanged.
2. **Given** a reference verse's agreed split, its acceptable alternatives and its rejected
   alternatives as candidates, **When** they are rated and the selector picks, **Then** it picks the
   agreed split or an acceptable one.
3. **Given** the churn guard is on and the current split already meets the criteria, **When** the
   selector compares it with equivalent candidates, **Then** it keeps the current split.
4. **Given** a splitter reply with the same split twice, or a candidate identical to the current
   split, **When** candidates are collected, **Then** duplicates are rated once.

---

### User Story 3 - The reference set calibrates the tooling (Priority: P2)

The reviewed verses live in the repository with their agreed splits, rejected alternatives and
confidence levels. A calibration check reports how well the audit's signals agree with them, so
later tuning is measured rather than guessed.

**Why this priority**: Without a fixed reference, each change to signals or prompts is judged by
feel, which is how the current tooling drifted from what the maintainer wants.

**Independent Test**: Run the calibration check and read its report: per-verse agreement and an
overall score.

**Acceptance Scenarios**:

1. **Given** the reference set, **When** the calibration check runs, **Then** it reports, for each
   verse, whether the audit flags the current deck split where the agreed split differs, and whether
   it stays quiet where they match.
2. **Given** a reference entry marked unresolved, **When** the calibration check runs, **Then** the
   entry is excluded from the score.
3. **Given** a reference entry whose text no longer rejoins to the canonical verse, **When** the
   check runs, **Then** it fails with the offending reference named.

---

### Edge Cases

* A verse that is entirely one short run (under about 6 words) stays whole and draws no signal.
* A long run with no pause point at all (for example, a 14-word clause with no comma, relative word
  or clause edge) is reported as long but with no suggested cut point; criterion 2 allows it.
* A speech tag inside narrative ("found him in the temple, and said to him,") does not by itself
  demand a separate chunk; the tag rule applies to tags that open a quotation, not to every verb of
  speech.
* Poetry lines that legitimately begin mid-sentence with a lowercase word are not misreported as
  lost line breaks; only capitalized line-initial words mid-phrase count.
* A capitalized word that starts a sentence after terminal punctuation is not a lost line break.
* A verse with HTML markup (bold or italic keyword annotations) keeps its markup intact in prompts
  and in applied splits.
* The em dash is shown to the LLM but is not a word, so a proposal that rejoins with or without the
  dash applies to the same word counts.

## Requirements _(mandatory)_

### Functional Requirements

* **FR-001**: The documented split criteria (the quality-criteria reference, the splitter, rater and
  selector instructions, and the skill) MUST state the six recitation criteria above and the
  word-perfect goal, and MUST replace the grammar- and meaning-centred guidance where it conflicts.
* **FR-002**: The worked examples in that documentation MUST come from the reference set, including
  at least one rejected alternative per criterion where one exists.
* **FR-003**: The audit MUST report a long run containing a pause point (internal comma, relative
  word, "that" after a verb of speech or perception, or the start of a list) and name the candidate
  cut position.
* **FR-004**: The audit MUST report a lost NKJV poetic line break (a capitalized line-initial word
  in the middle of a phrase).
* **FR-005**: The audit MUST report parallel sibling phrases that are cut asymmetrically.
* **FR-006**: The audit MUST report a cut that falls where there is no pause cue (no punctuation and
  no clause edge on either side).
* **FR-007**: The audit MUST detect word lists and clause lists and report splits that break them
  against criterion 5.
* **FR-008**: The audit MUST NOT push short lead-in or speech-tag phrases toward merging with their
  neighbours.
* **FR-009**: The audit's composite score MUST weight the new signals so that, at the default
  threshold, every reference verse marked agreed whose deck split differs appears on the worklist.
* **FR-010**: The audit MAY use an optional dependency-parse signal to find pause points that
  punctuation misses; without it installed the audit MUST still run and MUST say that the signal was
  skipped.
* **FR-011**: The splitter, rater and selector prompts MUST present the recitation criteria, the new
  signals, and the verse text with NKJV em dashes preserved.
* **FR-012**: Applying a split MUST keep the existing word-count convention; showing em dashes to
  the LLM MUST NOT change any stored word count or any rejoin check.
* **FR-013**: With the churn guard on, the selector MUST keep the current split unless another
  candidate is clearly better under the criteria; with it off, the selector picks the best candidate
  outright.
* **FR-014**: The reference set MUST be committed to the repository with, per verse: reference,
  deck, agreed phrase word counts, acceptable alternatives, confidence (agreed, weak or unresolved),
  an optional note, and rejected alternatives where they were discussed.
* **FR-015**: A calibration check MUST score the audit against the reference set and run as part of
  the tooling's test suite, failing when a reference entry's word counts no longer match the
  canonical token count.
* **FR-016**: The deck files MUST NOT change as part of this feature.
* **FR-017**: The splitter MUST be able to return between one and three distinct candidate splits
  per verse; each is validated against the canonical words before rating, and duplicates (of each
  other or of the current split) are dropped.
* **FR-018**: The rater MUST rate each candidate, and the current split, in a separate call that
  does not reveal which split is current, returning pros, cons and a score against the recitation
  criteria. When rating runs in batches, a batch never holds two candidates of the same verse.
* **FR-019**: The selector MUST see every candidate for a verse with its rating, know which is the
  current split, and return exactly one choice.
* **FR-020**: Applying MUST write only verses whose chosen split differs from the current one; this
  replaces the A/B judge step.

* **FR-021**: Rating prompts MUST present the audit's findings as plain-language flags grouped under
  the criterion each one tests, shown only when a signal passes its threshold, each marked strong or
  weak with its known blind spot, and MUST NOT show raw signal values or the composite score. One
  table owns each signal's criterion, threshold, strength rule and wording; the thresholds and
  strengths are set from the reference set.
* **FR-022**: The long-run signal MUST measure a phrase's length in syllables rather than words.
* **FR-023**: The no-pause-cue signal MUST exempt a short lead-in that starts after any pause
  punctuation, not only at a sentence start; the parse MUST treat the end of a long subject or of a
  fronted object as a pause, except before a predicate of one or two words.
* **FR-024**: The parse model MUST be selectable (the small model or the transformer model), and the
  audit MUST report which ran.
* **FR-025**: When candidates are equally good, the selector MUST prefer the one with more phrases;
  with the churn guard on, this applies only after the current split has been found not clearly
  better.

### Key Entities

* **Reference verse**: a reviewed verse with its agreed split, confidence level, note, and any
  rejected alternatives. The calibration ground truth.
* **Signal**: a deterministic feature of a split (per phrase or per boundary) reported by the audit
  and shown to the LLM steps. Context, not a rule.
* **Worklist**: the verses the audit surfaces above the threshold, ordered by score, that the
  splitter, rater and selector consume.

## Success Criteria _(mandatory)_

### Measurable Outcomes

* **SC-001**: At the default threshold, the audit surfaces 100% of reference verses marked agreed
  whose deck split differs from the agreed split.
* **SC-002**: The calibration report lists every reference verse whose kept split the audit flags,
  with the signal that fired, so each false alarm is visible and reviewable rather than hidden in a
  rate.
* **SC-003**: Run on the held-out reference verses with the current split hidden, the splitter
  offers a candidate matching the agreed or an acceptable split on more verses than the single-split
  prompt it replaces (the measured baseline); the selector's final pick is reported alongside.
* **SC-004**: Given a reference verse's agreed, acceptable and rejected splits as candidates, rated
  and then selected with the churn guard off, the selector never picks a rejected split, and picks
  the agreed or an acceptable split for every verse marked agreed.
* **SC-007**: With the churn guard on and the current split equal to the agreed one, the selector
  keeps the current split for every verse marked agreed.
* **SC-005**: The audit over every phrase-split deck finishes in under a minute without the optional
  extra, and under five minutes with it.
* **SC-006**: Every reference entry still matches the canonical token count, every applied split
  still rejoins to the canonical text, and there are zero word-count changes caused by the em-dash
  display.

## Assumptions

* The maintainer's review of about 40 verses is representative enough to calibrate against; more
  verses (notably Psalms and long Old Testament narrative) can be added later without changing the
  design.
* The optional parsing extra is installed in a local environment for the tools, not added to the
  app's dependencies; the app and the deck format are untouched.
* Local LLMs were considered and set aside by the maintainer; the LLM steps run as Claude Code
  subagents, with the model chosen per step and per run. Each step is measured on the reference set
  (SC-003, SC-004) with both Haiku and Sonnet, so a run can go all-Haiku when tokens are short, all-
  Sonnet when they aren't, or mix per step where Haiku falls short.
* Re-splitting the decks with the new tooling is follow-up work, done deck by deck with one commit
  per deck, outside this feature.
* Short "Amen" and "Selah" phrases standing alone are acceptable and draw no signal.
