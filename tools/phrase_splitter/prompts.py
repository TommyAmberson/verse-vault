"""LLM prompts shared by the splitter and the skill.

The split prompt is the main quality lever. Iterate on the wording and
the example set here; the CLI and the skill both import these constants
so iterations land in one place.
"""

SPLIT_PROMPT_HEADER = """\
You are splitting a Bible verse into memorisation phrases.

**Goal.** Produce a split where each phrase stands alone as a phrase —
a chunk a reciter can hold in working memory and that lands as a
self-contained unit of meaning. There are no rules, only guidelines.
Every verse is subjective; aim for the *best* split, which sometimes
means leaving a long clause whole.

**Guiding principle.** Completeness of thought beats size. A 9-word
phrase that finishes a thought is better than 4 + 5 that severs it.
Read each phrase aloud in isolation: does it land, or does it feel
suspended?

**Hard constraints.**

- Joining the phrases with single spaces must reproduce the verse
  verbatim. If your draft doesn't round-trip, fix it before answering.
- The word counts must sum to the canonical verse length.
- HTML tags (``<b>...</b>``, ``<i>...</i>``, ``<span ...>...</span>``)
  stay balanced inside each phrase — never split inside a tag.

**Signals (context, not rules).** Treat these as cues, not commands:

- *Cognitive weight* — a phrase reads better when the content words
  fit a reciter's working memory. Long all-content phrases get harder;
  long mostly-function phrases (``of the spirit of the world which is
  in him``) often stay fine.
- *Parallel siblings* — coordinated items at the same syntactic level
  often want to land as sibling phrases of similar shape (``not many
  wise, / not many mighty, / not many noble``).
- *Weak-connector starts* — a phrase opening with ``and``, ``but``,
  ``that``, ``which``, ``who`` often signals the phrase was glued back
  onto the previous one; check whether they should rejoin.
- *Verb + content clause* — ``know that``, ``see how``, ``believe
  whether`` often signal a verb separated from its object, which the
  recitation usually wants whole.
- *Restrictive relatives* — when ``that``, ``who``, ``which`` follow a
  noun *without* a preceding comma, the relative restrictively modifies
  the noun and reads as one unit; severing it usually feels wrong.
- *Mid-clause endings* — a phrase that ends without any pause
  punctuation (``...and was buried``) often wants to extend until it
  reaches a natural break.
- *Lopsidedness* — one phrase that swallows most of the verse while
  the rest are stubs often signals a missed boundary.

**Worked examples.**

Input:
    Paul, called to be an apostle of Jesus Christ through the will of God, and <b>Sosthenes</b> our brother,
Output:
    ["Paul, called to be an apostle of Jesus Christ",
     "through the will of God,",
     "and <b>Sosthenes</b> our brother,"]
(Parallel siblings; weak-connector start on the last phrase reads as
the natural continuation.)

Input:
    For the kingdom of God is not in word but in power.
Output:
    ["For the kingdom of God is not in word but in power."]
(Single continuous clause; size is fine because each piece would feel
suspended.)

Input:
    For you see your calling, brethren, that not many wise according to the flesh, not many mighty, not many <b>noble</b>, are called.
Output:
    ["For you see your calling, brethren,",
     "that not many wise according to the flesh,",
     "not many mighty,",
     "not many <b>noble</b>,",
     "are called."]
(Parallel siblings; the verb-clause signal applies but the parallel
items make the larger structure read more cleanly as five phrases.)

Input:
    Do you not know that we shall judge angels? How much more, things that pertain to this life?
Output:
    ["Do you not know that we shall judge angels?",
     "How much more, things that pertain to this life?"]
(Verb + content clause stays whole; rhetorical question ends at the
question mark.)

Input:
    All things were made through Him, and without Him nothing was made that was made.
Output:
    ["All things were made through Him,",
     "and without Him nothing was made that was made."]
(Restrictive relative: ``that was made`` attaches to ``nothing``.)
"""

_CURRENT_SPLIT_BLOCK = """\

**Current split.**
{current_split}

The current split is one option. If it already passes the stand-alone
test — each phrase landing as a self-contained unit — return it
verbatim. Change boundaries only when the new split is *clearly* better
(each phrase stands alone more cleanly), not merely defensible. The
goal is the best split, not a different split.
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


# Deprecated. Folded into ``SPLIT_PROMPT`` with the stability clause; the
# evaluator's ``call_judge`` is the only remaining caller and is itself
# removed in the same refactor. Kept here only so the deletion happens
# in the same commit that drops the caller.
JUDGE_PROMPT = """\
You are auditing a memorisation split of a Bible verse. Reply with a
single JSON object on one line:
{{"verdict": "ok" | "needs_resplit", "reasons": ["...", "..."]}}.

Verse: {ref}
Text: {text}
Current split:
{phrases_block}
"""
