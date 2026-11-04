# Research: Recitation-Based Phrase Splits

Prototypes behind these decisions ran during specification against all six phrase-split decks (years
3 to 8, 4,151 verses). Their findings are summarized here; the throwaway scripts are not part of the
feature.

## R1. Pause points inside a phrase

**Decision**: A phrase's _pause points_ are the token positions where a reciter would naturally
pause, found from:

* trailing pause punctuation on an internal token (`,` `;` `:` `—`);
* a relative word starting a clause after a noun (`who`, `whom`, `whose`, `which`, and a preposition
  followed by `which` or `whom`, as in "in which", "to whom");
* `that`, `what`, `how` or `whether` after a verb of speech or perception (the existing
  `CONTENT_CLAUSE_VERBS` list);
* a lost poetic line break (R2);
* the start of a word list (R5).

Each pause point records its kind, so signals and prompts can name the candidate cut ("pause before
'who delivered them'").

**Rationale**: Every agreed change in the reference set cuts a long run at one of these cues:
relative words (Judges 2:16, John 5:5, Exodus 12:40, John 5:28), `that` clauses (John 5:15, Luke
17:11, Genesis 2:9), internal commas (Hebrews 4:12, Romans 6:19), lists (Romans 9:4). The existing
`bare_relative` and `verb_content` heuristics already recognize two of these cues, but only to
_forbid_ cutting there.

**Alternatives considered**: Corpus rarity (inverse document frequency, numbers and proper nouns as
"hard details"). Prototyped: it surfaced unsplit verses carrying numbers and names, but it models
_meaning_ difficulty. The maintainer's word-perfect clarification made it the wrong axis, and it
could not place cuts. Dropped.

## R2. Lost poetic line breaks

**Decision**: A token mid-phrase whose word is capitalized, follows a token without terminal
punctuation, and is a conjunction, subordinator, preposition or article (`And`, `But`, `For`, `Or`,
`Nor`, `Yet`, `So`, `That`, `When`, `Though`, `The`, `In`, …) marks a lost NKJV line break.
Capitalized personal pronouns, `I`, and content words never count.

**Rationale**: NKJV capitalizes the first word of every poetry line, and the HTML-to-text step joins
lines with spaces, so "the sower And bread to the eater" (Isaiah 55:10) is a line break in disguise.
NKJV also capitalizes pronouns and titles referring to God (`He`, `Him`, `You`, `Your`, `Lord`,
`Spirit`), so a plain "capital mid-sentence" test would fire on most of the New Testament. Limiting
the test to function words avoids those.

**Alternatives considered**: Reading line structure from the api.bible HTML (`q1`/`q2` paragraph
classes). More exact, but it would thread a second representation through the cache and tokenizer
for a signal the function-word test already gets right on the sampled poetry. Revisit only if
calibration shows misses.

## R3. Long runs and the end of merge pressure

**Decision**: Replace `word_overload`, `cognitive_overload` and `stub_phrase` with one phrase
signal, _long run_: zero up to 10 words, ramping to full strength by 16 words, at full weight when
the phrase has at least one pause point and at a fraction of it when it has none (criterion 2 allows
a long run with no pause point). Remove `stub_phrase` from the composite score and from the signal
payload.

**Rationale**: Criterion 2 and the reference set: every accepted split had a long run with a cue;
every short-phrase cut the maintainer doubted came from a run already under about 10 words. The stub
signal pushed short lead-ins and speech tags toward merging, which the word-perfect rule rejects
(FR-008). Content-word counting measured meaning load, not recitation runs.

**Alternatives considered**: Keeping the old signals at reduced weight. Rejected under Principle
VII: a signal with no role in the criteria is clutter in every prompt.

## R4. Boundaries: cuts inside a run

**Decision**: A boundary signal _no pause cue_ fires when the previous phrase does not end in pause
or terminal punctuation **and** the next phrase does not start at a clause edge (a conjunction,
subordinator, relative word, preposition plus relative, quotation opener, or lost line break), and
the previous phrase is not a short sentence-opening lead-in ("For this reason / the Jews persecuted
Jesus,": lead-ins keep their own chunk under FR-008 even without a comma). The existing
`verb_content` and `bare_relative` kinds become length-gated: they fire only when the two phrases
together are a short run (under about 10 words), because cutting a long run at those cues is exactly
what the reference set wants.

**Rationale**: The length gate follows the reference set: "judges / who delivered them" and "told
the Jews / that it was Jesus" are accepted cuts at exactly the cues the current auditor penalizes,
in runs of 15 words and more.

**Known limit**: The rejected cut "into the pool / when the water is stirred up" (John 5:7) has no
punctuation, but `when` is a subordinator, so no surface rule separates it from accepted cuts such
as "a certain man was there / who had an infirmity". Deterministic signals will not catch it. The
verse still reaches the worklist through its last phrase ("but while I am coming, another steps down
before me." has an internal comma, so the long-run signal must start below 10 words when a comma is
present; calibration sets the exact ramp), and the splitter and judge prompts carry the "cut where
you'd pause" criterion with this verse as a worked example.

**Alternatives considered**: Dependency arcs crossing the boundary, with clause-level arcs counted
as seams. Prototyped with spaCy: it caught "For this reason" severed from its verb and the John
12:17 subject orphaned from "bore witness", but misread archaic syntax (John 5:19). Kept as the
optional signal, not the primary one.

## R5. Lists

**Decision**: A _word list_ is three or more comma- or conjunction-separated items of one to three
tokens each with no verb among them; a _clause list_ is coordinated items that each carry a verb or
run past three tokens. Signals:

* a word list cut internally while it fits in one run (about 10 words or fewer), unless the items
  lengthen at the cut (Romans 9:4) or a colon precedes the list;
* a word list sharing a phrase with a lead-in of three or more words that could stand as its own run
  ("Therefore I take pleasure in infirmities, …"); weak, since short lead-ins stay attached;
* two clause-list items merged into one phrase; weak.

Fixed groups ("Shadrach, Meshach, and Abed-Nego") are word lists of three, which the rules already
leave alone.

**Rationale**: Criterion 5 as the maintainer refined it, with 2 Corinthians 12:10, Romans 9:4,
Daniel 3:29 and Genesis 6:10 as cases.

**Alternatives considered**: A hand list of fixed groups. Unnecessary: three-item lists draw no
split signal on their own.

## R6. Optional dependency-parse signal

**Decision**: spaCy with `en_core_web_sm`, loaded only when importable, adds pause points at the
start of adverbial, relative and complement clauses and at the subject–predicate boundary of a long
subject (Exodus 12:40 "… who lived in Egypt / was four hundred and thirty years"). The parse runs
once per verse, since clause structure needs the whole verse, and its pause points are attached to
the phrases that contain them. Without spaCy, the audit runs on R1 to R5 and the report says the
parse signal was skipped. Install instructions go in `tools/README.md`; no dependency is added to
the pnpm or Cargo workspaces.

**Rationale**: The subject–predicate pause has no surface cue, and the reference set has several.
The small model runs over every deck in about a minute on CPU.

**Alternatives considered**: `en_core_web_trf` (transformer, more accurate on archaic syntax, needs
PyTorch). The calibration check can compare the two by model name; the default stays `sm` unless
calibration shows `trf` earns the install. Local LLMs were declined by the maintainer.

## R7. Em dashes in prompts

**Decision**: Prompts show the verse text with NKJV em dashes, rebuilt from the same stripped
chapter text the tokenizer reads. Validation of LLM replies compares token sequences produced by the
existing tokenizer (whitespace or em dash), with curly-quote folding, instead of comparing bytes, so
a reply that keeps, drops or spaces a dash applies to the same word counts.

**Rationale**: The tokenizer splits on `—` to match the deck's word counts (`apibible._tokenise`),
so today's prompt text silently drops every dash and the LLM loses a pause cue ("and come
forth—those who"). Comparing tokens rather than bytes reuses the tokenizer that already defines the
word-count convention, and makes the separate curly-quote splice unnecessary.

**Alternatives considered**: Keeping byte comparison and teaching it about dashes. Two rejoin rules
for one question; rejected.

## R8. Reference set and calibration

**Decision**: The reference set is committed as JSON next to the tooling, holding references, deck
paths, agreed `phraseWordCounts`, confidence (`agreed`, `weak`, `unresolved`), an optional note, and
rejected alternatives as word counts. Calibration is a mode of the existing audit CLI that, for each
entry, loads the deck and the api.bible cache, checks every split still sums to the canonical token
count, and reports whether the audit flags the deck split where the agreed split differs and stays
quiet where the maintainer kept it, naming the signals that fired. A unit test runs the calibration
when the cache is present and skips otherwise.

**Rationale**: Word counts, not text, because the decks themselves store only counts and the NKJV
terms forbid systematic extraction; the calibration report renders text from the cache for reading.
A mode of the audit CLI reuses its deck and cache loading (Principle VII).

**Alternatives considered**: Storing phrase text (readable in the diff, but a growing copy of NKJV
in the repository). A standalone calibration script (duplicates the audit's loading).

## R9. Measuring the LLM steps (SC-003, SC-004)

**Decision**: Before the prompt rewrite, run the current splitter prompt on the reference verses
with `--no-current` and record exact-match counts per model; repeat after the rewrite. For the
judge, emit judge prompts pairing each agreed split with each of its rejected alternatives (both
orders) and require the agreed side every time. Results go in the pull request body, not the
repository.

**Rationale**: The spec drops invented percentages; a measured baseline and the maintainer's own
rejections are the yardsticks.

**Alternatives considered**: Automating the LLM runs in the test suite. The LLM steps run as Claude
Code subagents by design and cost tokens; they stay a manual, per-change measurement.

## R10. Working from a worktree

**Decision**: The tools resolve the api.bible cache at `packages/api/data/verse-vault.db` relative
to the working directory, which a fresh worktree lacks. The quickstart links the canonical clone's
cache file into a real `packages/api/data/` directory in the worktree, which git already ignores; no
code change.

**Rationale**: A link serves the CLIs and the calibration test alike, without adding a path option
or environment variable that only a test would read (Principle VII). `--db` remains for one-off use.

## R11. Parallel halves

**Decision**: Split the verse at its main pauses (`;`, `:`, sentence ends, and commas followed by a
coordinating conjunction) into segments. Two adjacent segments are _parallel halves_ when they open
with the same one or two words after any leading conjunction ("no one … / and no one …"), or share a
run of three or more words in the same order ("… did not escape … / … shall we not escape …",
"presented your members as slaves of … / present your members as slaves of …"). For each pair,
`parallel_asymmetry` fires when one half contains a phrase boundary and the other does not, scaled
by how close in length the halves are (a 5-word half beside a 15-word one is not a real mirror).

**Rationale**: Criterion 6 and its cases: 1 Corinthians 12:3 (both halves kept whole, the half-split
draft rejected), Hebrews 12:25 (both halves split the same way), Romans 6:19 (the mirrored "present
your members as slaves" lines). Shared openings and shared word runs are the surface marks of NKJV
parallelism; meaning-level parallels without shared words are left to the LLM steps.

**Alternatives considered**: Comparing part-of-speech patterns via the parse. Needs spaCy for a
stdlib signal and over-matches ordinary coordinated clauses; rejected.

## R12. Propose, rate, select

**Decision**: Replace the A/B judge with three LLM steps. The splitter returns one to three distinct
candidate splits per verse, best first. Each candidate, and the current split, is rated in its own
call that does not say which split is current: pros, cons and a score from 1 to 10 against the
recitation criteria. A selector reads every candidate's text and rating for the verse, knows which
is current, and returns one choice; with the churn guard on it keeps the current split unless
another is clearly better. Candidates get ids in an order that does not reveal the current split,
and identical splits are rated once.

**Rationale**: Measured on the reference set (41 agreed verses, half held out from prompt tuning), a
single Haiku proposal lands at the wrong granularity in both directions depending on the prompt: the
current prompt misses 21 of the held-out cuts, a length rule overcorrects into 9 to 11 extra cuts,
and a stricter procedure swings back to 17 misses. Several candidates move the granularity decision
downstream. The A/B judge missed only agreed splits placed in position B, a bias from comparing two
labelled options; rating each split alone removes the position and removes knowledge of which is
current until the final pick.

**Alternatives considered**: Rating all candidates in one call (cheaper, but candidates anchor each
other). A deterministic pick from the highest score (free, but ties and a decisive con need
judgement).

## R13. Model per step

**Decision**: Measure each step with Haiku and with Sonnet, on the reference set: the splitter by
how often one of its candidates matches the agreed or an acceptable split (SC-003), the rater and
selector by SC-004 with candidate sets built from agreed, acceptable and rejected splits. A step
that falls short on Haiku runs on Sonnet in a mixed setup; the skill records the measured options
(all-Haiku, all-Sonnet, or mixed) and the maintainer picks per run by token budget.

**Rationale**: The maintainer's aim is a cheap pipeline. Per-step measurement shows which step, if
any, needs the stronger model.
