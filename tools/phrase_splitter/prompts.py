"""LLM prompts shared by the splitter and the skill.

The split prompt is the main quality lever. Iterate on the wording and
the example set here; the CLI and the skill both import these constants
so iterations land in one place.
"""

SPLIT_PROMPT_HEADER = """\
You are splitting a Bible verse into memorisation phrases.

**Goal.** Partition the verse into chunks the reciter can forget and
recover. A phrase is a *memorisable unit* — a chunk a reciter could
blank on while still sensing the specific shape of the gap from the
rest. Partition by *function*, not by prose-completeness. A 4-word
framing intro is a valid phrase if it does a discrete job different
from its neighbours; phrases don't have to read as complete sentences
in isolation.

There are no rules, only guidelines. Every verse is subjective; aim
for the *best* split, which sometimes means leaving a long clause
whole.

**Why split at all.** Each phrase carries its own FSRS recall
state. The split's job is to match phrase boundaries to memory
boundaries — the points where the reciter could plausibly fail one
side without the other.

*Under-splitting* — bundling two memorisable pieces under one state
— has two costs. Composite memory stability follows roughly ``S =
(S_a × S_b) / (S_a + S_b)``, always lower than either piece alone
and approaching zero as you compose more pieces; two separable
memories then share one prematurely-decaying state instead of each
carrying their own. And the FSRS value for a composite stops
representing any one memory's actual strength — the reciter who
half-knows a clause grades it on whichever piece they can't yet
recall, polluting the state of the piece they had down cold.

*Over-splitting* has its own costs. Too many phrases means more
cards to review without proportional information gain. A phrase too
small to be a coherent memorisable unit — a sub-clause the reciter
can't grade independently — produces noise rather than signal.
Awkward, unnatural cuts break review flow and confuse the reciter
about where they are in the verse. And two pieces that the reciter
would always succeed or fail *together* are intertwined enough to
be one memory unit; separate states on them produce noisy reviews
on either side of a boundary that isn't a memory boundary.

Aim for the sweet spot: as fine as the memory structure actually
is, no finer.

**Guiding principle.** Group by job. Two fragments doing the *same*
job — setup and payoff of one thought — usually want to be one
phrase: a 9-word complete clause beats 4 + 5 that severs the thought
mid-stream. Two fragments doing *different* jobs — a framing intro
and the content it introduces, or a subordinate setup and its main
clause — usually want to be separate phrases, even when one is
short.

**The recall test.** Mentally blank each candidate phrase. Can the
reciter sense the specific shape of what's missing? If yes, the
boundary is doing useful work — the blanked piece is a distinct
memorisable unit that could fail or succeed without its neighbours.
If a blanked phrase leaves a fuzzy mid-thought gap, the two sides
are one mental move and the boundary is in the wrong place.

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
You are picking the better of two memorisation phrase splits for a
Bible verse.

**Why split at all.** Each phrase carries its own FSRS recall
state. The better split is the one whose phrase boundaries match
the verse's memory boundaries — the points where the reciter could
plausibly fail one side without the other.

*Under-splitting* (boundaries too coarse) bundles two separable
memories under one state. Composite stability follows roughly
``S = (S_a × S_b) / (S_a + S_b)``, approaching zero as more pieces
are composed; the shared state decays prematurely and stops
representing any one memory's true strength.

*Over-splitting* (boundaries too fine) creates phrases too small to
be coherent memorisable units — sub-clauses the reciter can't grade
independently, awkward cuts that break review flow, or pieces the
reciter would always succeed or fail *together* (intertwined enough
to be one memory unit). It also multiplies cards without
proportional information gain.

The better option is the one closer to the actual memory structure:
neither finer (boundaries fall mid-thought, intertwined pieces get
separate states) nor coarser (independently-forgettable chunks
share one state).

**The recall test.** Mentally blank each phrase in each option. An
option whose blanks leave a recognisable shape (each phrase is a
distinct memorisable unit that could fail without its neighbours) is
better than one whose blanks leave mid-thought blurs (the two sides
are one mental move).

**How to read the signals.** The signal block under each option is
deterministic features of that option — composite score, per-phrase
content-word load and stub flags, boundary severance kinds
(``verb_content``, ``bare_relative``, ``stranded_stub``), length
balance. Lower composite generally means fewer flagged issues, but
signals are context, not verdicts: a single high signal can reflect a
deliberate trade-off (a stub parallel sibling, a deliberate
``and``-start that continues a coordinated list). Read the recall
test as the deciding criterion; the signals just point at where to
look.

**Hard constraints.** Both options have already been validated for
rejoin, word-count sum, and HTML tag balance — you don't need to
re-check.

**Tie-breaking.** When the two options are genuinely equivalent under
the recall test, prefer the current split (Option A) — needless
churn is bad. Pick B only when it is *clearly* better, not merely
defensible.

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
