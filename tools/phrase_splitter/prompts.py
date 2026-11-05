"""LLM prompts shared by the splitter and the skill.

The split prompt is the main quality lever. Iterate on the wording and
the example set here; the CLI and the skill both import these constants
so iterations land in one place.
"""

SPLIT_PROMPT_HEADER = """\
You are splitting a Bible verse into memorization phrases for Bible
quizzing.

**Goal: word-perfect recitation.** Quizzers recite verses word for
word; knowing the gist is not enough. The wording of a lead-in ("For
this reason" against "Therefore") is often exactly what slips. A
reciter says a verse in *runs*, stretches said in one go, and errors
cluster at the handoffs between runs and at swapped words inside
them. Each phrase carries its own recall state, so a good split
matches the runs.

**Criteria.**

1. *Cut where you would naturally pause reciting aloud.* A cut inside
   a run feels wrong ("into the pool / when the water is stirred up").
   Punctuation is evidence of a pause, not the test. Pauses with no
   comma: after a long subject or fronted object, before its verb ("He
   who eats My flesh and drinks My blood / abides in Me,"; a short
   subject keeps its verb: "And the posts of the door were shaken / by
   the voice"); before a completing phrase of four or more words in a
   run of 14 or more words ("were shaken / by the voice of him who cried
   out,"), while a run of up to 13 stays whole ("do not eat it for the
   sake of the one who told you,"); before a relative or "that" clause
   of four or more words.
2. *A chunk is one run*, about one breath, usually 3 to 10 words,
   longer only when it has no pause point. Split long runs at their
   pause points; below about 10 words a cut has to earn its place. The
   number of chunks in a verse is not a criterion.
3. *Each chunk start is a practised handoff.* A lead-in of three or
   more words whose exact wording matters keeps its own chunk ("For
   this reason"), and a speech tag that opens a quotation stays
   separate from it ("The sick man answered Him,"). A tag that follows
   narrative stays with the narrative ("Afterward Jesus found him in
   the temple, and said to him,"). A short chunk that is a handoff is
   not a stub.
4. *Each chunk can fail on its own*: the reciter could blank or
   misquote it while getting its neighbours right. This is a test of
   recall, not grammar: a lead-in, a subject or a clause opener passes
   it without being a sentence. A chunk fails it only when its wording
   is forced by the chunk before it ("But one / and the same") or it is
   too slight to be a handoff ("From the Jews / five times").
5. *Lists.* A word list (items of 1 to 3 words, no verb of their own)
   is itself the memory item: one chunk, with a lead-in that can stand
   as a run kept out of it ("Therefore I take pleasure / in
   infirmities, in reproaches, in needs, in persecutions, in
   distresses,"). Split a word list only when it is longer than one
   run or its items lengthen partway. A lead-in of three or more words
   ("to whom pertain") stands as its own run. Short lists, fixed groups
   ("Shadrach, Meshach, and Abed-Nego") and lead-ins that can't stand
   alone ("that any people, nation, or language") stay together. In a
   clause list, each item preferably gets its own chunk.
6. *Parallel halves get matching cuts*: both split or both whole
   ("that no one speaking by the Spirit of God calls Jesus accursed, /
   and no one can say that Jesus is Lord except by the Holy Spirit.").

Punctuation, meaning and grammar are evidence of where pauses fall,
not criteria in themselves. Dashes and commas usually mark a breath;
a relative clause or a "that" clause often starts a new run in a long
sentence. In poetry, each line is usually its own run.

**Hard constraints.**

- Joining the phrases with single spaces must reproduce the verse
  word for word. A dash between words may stay at the end of a phrase
  ("and come forth—"). If your draft doesn't round-trip, fix it before
  answering.
- HTML tags (``<b>...</b>``, ``<i>...</i>``, ``<span ...>...</span>``)
  stay balanced inside each phrase; never split inside a tag.

**Worked examples** (agreed by the maintainer).

Input:
    Nevertheless, the Lord raised up judges who delivered them out of the hand of those who plundered them.
Output:
    ["Nevertheless, the Lord raised up judges",
     "who delivered them out of the hand of those who plundered them."]
(Criterion 2: a long run split at its relative clause.)

Input:
    The sick man answered Him, “Sir, I have no man to put me into the pool when the water is stirred up; but while I am coming, another steps down before me.”
Output:
    ["The sick man answered Him,",
     "“Sir, I have no man to put me into the pool when the water is stirred up;",
     "but while I am coming,",
     "another steps down before me.”"]
(Criteria 1 and 3: the speech tag is its own handoff; "into the pool
when the water is stirred up" is one run; the comma before "another"
is a real breath.)

Input:
    For this reason the Jews persecuted Jesus, and sought to kill Him, because He had done these things on the Sabbath.
Output:
    ["For this reason",
     "the Jews persecuted Jesus,",
     "and sought to kill Him,",
     "because He had done these things on the Sabbath."]
(Criterion 3: the lead-in's wording is easy to misquote, so it keeps
its own chunk.)

Input:
    That it may give seed to the sower And bread to the eater,
Output:
    ["That it may give seed to the sower",
     "And bread to the eater,"]
(Poetry: the capital "And" marks a line break.)

"""


_CURRENT_SPLIT_BLOCK = """\

**Current split** (for context only: propose your honest best split,
not a defence of this one):
{current_split}
"""

_SIGNALS_BLOCK = """\

**Signals (auto-computed).**
{signals}

These are deterministic features of the current split: context, not
verdicts. Use them to spot patterns; don't echo them back.
"""

_OUTPUT_CONTRACT = """\

Now split this verse. Reply on one line with a JSON array of one to
three candidate splits, best first, each candidate a JSON array of
phrase strings, and nothing else. A rater and a selector will compare
them, so give them a real choice of granularity:

- Your best split comes first.
- If any phrase of it has more than 10 words, add a finer candidate
  that cuts each such phrase once at its clearest pause point: a comma,
  semicolon or dash; the start of a relative or "that" clause of four
  or more words; the end of a long subject or fronted object, before
  its verb; the start of a completing phrase of four or more words,
  only in a phrase of 14 or more words; a
  capitalized "And" or "But" that marks a poetry line. Leave at least
  four words on each side. Cut a word list only where its items
  lengthen or it outgrows a run; never sever a relative clause of three
  words from its noun, a short completion from its verb ("put me into
  the pool"), or a pronoun head from its preposition ("/ to those
  who", not "to those / who"). If no phrase can be cut that way, offer
  the one candidate.
- If your best split has a chunk of three or four words that is not a
  lead-in, a speech tag or a list item, you may add a coarser candidate
  that merges it into its neighbour.

Candidates must differ from each other, and each must round-trip to the
verse word for word.

Verse:
    {verse_text}
"""


def format_split_prompt(
    verse_text: str,
    current_split: str | None = None,
    signals: str | None = None,
) -> str:
    """Render ``SPLIT_PROMPT_HEADER`` + optional current-split + optional
    signals + the output contract. ``current_split`` is a rendered
    block of phrase text (one per line, typically with a leading
    bullet); ``signals`` is a free-form block emitted by the features
    layer."""
    parts = [SPLIT_PROMPT_HEADER]
    if current_split:
        parts.append(_CURRENT_SPLIT_BLOCK.format(current_split=current_split))
    if signals:
        parts.append(_SIGNALS_BLOCK.format(signals=signals))
    parts.append(_OUTPUT_CONTRACT.format(verse_text=verse_text))
    return "".join(parts)


# Backward-compatible single-string export. Callers that don't have a
# current split or signals to inject can keep using ``SPLIT_PROMPT`` as
# a plain ``.format(verse_text=...)`` template.
SPLIT_PROMPT = SPLIT_PROMPT_HEADER + _OUTPUT_CONTRACT


# The criteria in brief, shared by the rating and selection prompts so
# both steps judge by the same list.
_CRITERIA_SUMMARY = """\
A reciter says a verse in runs, stretches said in one go; errors
cluster at the handoffs between runs and at swapped words inside them.
Quizzing is word-perfect, so the wording of a lead-in matters. A good
split matches the runs:

1. Cuts fall where you would naturally pause reciting aloud, never
   inside a run. Punctuation is evidence of a pause, not the test.
   Pauses with no comma: after a long subject or a fronted object,
   before its verb ("He who eats My flesh and drinks My blood / abides
   in Me,"); a short subject keeps its verb ("And the posts of the door
   were shaken / by the voice"). The breath before a completing phrase
   of four or more words in a run of 14 or more words ("were shaken / by
   the voice of him who cried out,"); up to 13 words the run stays whole.
   The start of a relative or "that"
   clause of four or more words ("told the Jews / that it was Jesus").
   A short completion stays with its verb ("put me into the pool").
2. A chunk is one run, about one breath, usually 3 to 10 words, longer
   only when it has no pause point of the kinds in 1. Over 10 words a
   run with a pause point should be cut there; under 10 a cut has to
   earn its place. The number of chunks in a verse is not a criterion.
3. Each chunk start is a practised handoff. A lead-in of three or more
   words whose wording can slip keeps its own chunk ("For this
   reason"); a speech tag that opens a quotation is separate from it;
   a tag that follows narrative stays with it. A short chunk that is a
   handoff is not a stub.
4. Each chunk can fail on its own: the reciter could blank or misquote
   it while getting its neighbours right. This is a test of recall,
   not of grammar: a lead-in, a subject or a clause opener passes it
   without being a sentence. A chunk fails it only when its wording is
   forced by the chunk before it ("But one / and the same") or when it
   is too slight to be a handoff of its own.
5. A word list (items of 1 to 3 words, no verb of their own) is one
   chunk, cut only where it outgrows a run or its items lengthen. A
   lead-in of three or more words that can stand alone stays out of
   it; one that can't ("that any") stays in. Clause-list items
   preferably get a chunk each.
6. Parallel halves, two clauses of the same shape, get matching cuts:
   both split or both whole. Two clauses that merely share a
   conjunction are not parallel halves, and a long half with a pause
   point is still cut.

The signals section lists the audit's flags under the criterion each
one tests, marked strong or weak. They are hints, not verdicts: a weak
flag on a cut at one of the pauses in 1 is not a con.
"""

RATE_PROMPT = """\
You are rating one memorization phrase split of a Bible verse for
word-perfect Bible quizzing. Rate it on its own merits against the
criteria; don't imagine other splits.

{criteria}
**Verse.**
    {verse_text}

**Split.**
{split}

**Signals.**
{signals}

Judge every cut and every chunk against the six criteria. A con is a
criterion the split breaks, named by number and phrase ("1: phrase 2
cuts inside a run at 'pool / when'"). These are not cons: a chunk of
three or four words that is a handoff; a cut with no punctuation at a
pause named in criterion 1; a phrase that ends mid-clause; the number
of chunks; a weak flag on its own. A run over 10 words is a con when it
holds a pause point; one of 11 to 13 words with none is at most a note.

Use the whole scale. 9 or 10: no criterion broken. 7 or 8: a note only
(a long run with just a weak pause point, two short clause items
merged). 4 to 6: one clear break (a cut inside a run, a lead-in or
opening speech tag merged away, a word list cut between items, a run
over 10 words left whole at a clear pause point, one of two parallel
halves cut). 1 to 3: more than one clear break. Don't write a con and
then call it acceptable: either it costs points or it is not a con.

Reply on one line with a JSON object and nothing else:
{{"score": <integer 1 to 10>, "pros": [<short strings>], "cons": [<short strings>]}}
"""

SELECT_PROMPT = """\
You are choosing the best memorization phrase split of a Bible verse
for word-perfect Bible quizzing, from candidates that have each been
rated on their own.

{criteria}
**Verse.**
    {verse_text}

**Candidates.**
{options}
{guard}
Decide by the criteria. The scores are one rater's view of each
candidate alone; the raters did not compare them.

1. Set aside any candidate with a con that is a clear break: a cut
   inside a run, a lead-in or opening speech tag merged away, a word
   list cut between items, a run over 10 words left whole at a clear
   pause point, one of two parallel halves cut. Check each con against
   the verse first; a con that is not one of the criteria (a short
   handoff called a stub, a long subject cut from its verb, a chunk
   count, a phrase ending mid-clause) carries no weight.
2. Among the rest, prefer the candidate whose remaining cons are fewest
   and mildest.
3. If two are still level, prefer the one with more phrases (the
   maintainer's tie-break): a cut that lets a slip be caught on one
   side alone is worth having.

Reply on one line with a JSON object and nothing else:
{{"choice": "<candidate id>"}}
"""

_CHURN_GUARD = """
**Churn guard.** The candidate marked (current) is what the deck has
now. Keep it unless another candidate removes a clear break that the
current one has and adds none. A higher score on its own, a tie, or a
gap of a point or two is not a reason to change, and step 3 does not
apply: when nothing is clearly better, answer with the current id.
"""


def format_rate_prompt(verse_text: str, split: str, signals: str) -> str:
    """Render ``RATE_PROMPT`` for one candidate. Nothing in it says
    whether the split is the deck's current one."""
    return RATE_PROMPT.format(
        criteria=_CRITERIA_SUMMARY, verse_text=verse_text, split=split, signals=signals
    )


def format_select_prompt(verse_text: str, options: list, churn_guard: bool) -> str:
    """Render ``SELECT_PROMPT``. Each option is a dict with ``id``,
    ``split`` (rendered bullets), ``score``, ``pros``, ``cons`` and
    ``current``."""
    blocks = []
    for o in options:
        label = f"Candidate {o['id']}" + (" (current)" if o["current"] else "")
        pros = "; ".join(o["pros"]) or "none"
        cons = "; ".join(o["cons"]) or "none"
        blocks.append(
            f"**{label}**, score {o['score']}\n{o['split']}\n  pros: {pros}\n  cons: {cons}\n"
        )
    return SELECT_PROMPT.format(
        criteria=_CRITERIA_SUMMARY,
        verse_text=verse_text,
        options="\n".join(blocks),
        guard=_CHURN_GUARD if churn_guard else "",
    )
