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

Now split this verse. Reply with a single JSON array of strings on one
line, nothing else.

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


JUDGE_PROMPT = """\
You are picking the better of two memorization phrase splits for a
Bible verse, for word-perfect Bible-quizzing recitation.

**What makes a split good.** A reciter says a verse in runs,
stretches said in one go; errors cluster at the handoffs between runs
and at swapped words inside them. Each phrase carries its own recall
state, so the better split matches the runs:

1. Cuts fall where you would naturally pause reciting aloud, never
   inside a run.
2. A chunk is one run, usually 3 to 10 words; longer only when it has
   no pause point.
3. Each chunk start is a practised handoff: lead-ins whose wording
   matters and speech tags that open a quotation keep their own chunk.
   Merging a short phrase into its neighbour is not an improvement in
   itself: if its wording could slip on its own, it earns its chunk.
4. Each chunk can fail on its own; no fragment that only makes sense
   glued to its neighbour.
5. A short word list is one chunk, apart from a lead-in that can stand
   as a run: a lead-in of three or more words ("to whom pertain",
   "Therefore I take pleasure") is its own chunk, not the head of the
   list's first line. Clause-list items preferably get a chunk each.
6. Parallel halves get matching cuts.

**How to read the signals.** Each option carries a signal block:
``long_run`` (a phrase running past one run, with its
``pause_points``), ``no_pause_cue`` and ``boundary_severance`` (a cut
inside a run), ``lost_line_break`` (a poetry line joined into a
phrase), ``parallel_asymmetry``, ``list_breaks``, and a composite.
Lower composite generally means fewer issues, but signals are context,
not verdicts. The criteria decide.

**Hard constraints.** Both options have already been validated for
rejoin, word-count sum, and HTML tag balance; you don't need to
re-check.

**Pick rule.** Prefer Option A (the current split) by default:
needless churn is bad. Pick B only when it is *clearly* better under
the criteria, not merely defensible.

**Verse.**
    {verse_text}

**Option A (current).**
{option_a_split}

Signals A:
{signals_a}

**Option B (proposed).**
{option_b_split}

Signals B:
{signals_b}

Reply with exactly one character — `A` or `B` — and nothing else.
"""


def format_judge_prompt(
    verse_text: str,
    option_a_split: str,
    signals_a: str,
    option_b_split: str,
    signals_b: str,
) -> str:
    """Render ``JUDGE_PROMPT`` for a single verse comparison.

    ``option_a_split`` / ``option_b_split`` are pre-rendered bullet
    blocks (one phrase per line); ``signals_a`` / ``signals_b`` are
    the same compact text blocks the splitter prompt sees, generated
    by ``tools/split_phrases.py:_render_signals``."""
    return JUDGE_PROMPT.format(
        verse_text=verse_text,
        option_a_split=option_a_split,
        signals_a=signals_a,
        option_b_split=option_b_split,
        signals_b=signals_b,
    )
