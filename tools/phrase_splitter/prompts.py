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
2. *A chunk is one run*, usually 3 to 10 words, longer only when it
   has no pause point. Split long runs at their pause points; below
   about 10 words a cut has to earn its place.
3. *Each chunk start is a practised handoff.* Lead-ins whose exact
   wording matters keep their own chunk ("For this reason"), and a
   speech tag that opens a quotation stays separate from it ("The sick
   man answered Him,"). Don't merge a short phrase into its neighbour
   just because it is short. A tag that follows narrative stays with the
   narrative ("Afterward Jesus found him in the temple, and said to
   him,").
4. *Each chunk can fail on its own*, independently of its neighbours.
   Don't leave a fragment that only makes sense glued to the next
   phrase ("From the Jews / five times").
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

**Current split** (for context only — propose your honest best split,
not a defence of this one):
{current_split}
"""

_SIGNALS_BLOCK = """\

**Signals (auto-computed).**
{signals}

These are deterministic features of the current split — context, not
verdicts. Use them to spot patterns; don't echo them back.
"""

_OUTPUT_CONTRACT = """\

Now split this verse. Reply on one line with a JSON array of one to
three candidate splits, best first, each candidate a JSON array of
phrase strings, and nothing else. Offer more than one only when the
verse has a real choice (a coarser and a finer split that both meet the
criteria); a rater and a selector will compare them.

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
   inside a run.
2. A chunk is one run, usually 3 to 10 words; longer only when it has
   no pause point.
3. Each chunk start is a practised handoff: lead-ins whose wording
   matters and speech tags that open a quotation keep their own chunk;
   a tag that follows narrative stays with it.
4. Each chunk can fail on its own; no fragment that only makes sense
   glued to its neighbour.
5. A short word list is one chunk, apart from a lead-in of three or
   more words that can stand as a run; clause-list items preferably get
   a chunk each.
6. Parallel halves get matching cuts.

The signals block (``long_run`` with ``pause_points``,
``no_pause_cue``, ``boundary_severance``, ``lost_line_break``,
``parallel_asymmetry``, ``list_breaks``) is context, not a verdict;
some judgements have no surface cue.
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

Reply on one line with a JSON object and nothing else:
{{"score": <integer 1 to 10>, "pros": [<short strings>], "cons": [<short strings>]}}
A score of 10 meets every criterion; 1 breaks them badly. Name the
phrase a pro or con is about.
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
Weigh the ratings, but decide by the criteria: a decisive con can
outweigh a higher score. Reply on one line with a JSON object and
nothing else: {{"choice": "<candidate id>"}}
"""

_CHURN_GUARD = """
**Churn guard.** The candidate marked (current) is what the deck has
now. Keep it unless another candidate is clearly better under the
criteria; needless churn is bad.
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
