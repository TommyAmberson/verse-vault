"""LLM prompts shared by the splitter and the skill.

The split prompt is the main quality lever. Iterate on the wording and
the example set here; the CLI and the skill both import these constants
so iterations land in one place.
"""

SPLIT_PROMPT_HEADER = """\
You are splitting a Bible verse into memorisation phrases.

**Goal.** Partition the verse into chunks the reciter can forget
and recover independently. A phrase is a *memorisable unit* — a
chunk doing a discrete job different from its neighbours. Partition
by function, not prose-completeness: a 4-word framing intro is a
valid phrase, and phrases needn't read as complete sentences in
isolation. There are no rules, only guidelines; the best split
sometimes leaves a long clause whole.

**How phrases are reviewed.** Each phrase ends up reviewed in two
modes:

- *PhraseFill* — the whole verse is shown with one phrase blanked.
  The reciter recovers that phrase from surrounding context, and the
  grade updates that phrase's FSRS state directly.
- *Recitation* — only the verse reference is shown. The reciter
  recites the whole verse from memory, and one grade is decomposed
  across every phrase's FSRS state.

The split is the partition both modes operate on. PhraseFill demands
each phrase be recoverable from context; Recitation demands each
phrase be a real memory unit whose recall state means something on
its own.

**The recall test (operational).** Mentally do a PhraseFill on each
candidate phrase: blank it, look at what's left. If the gap has a
recognisable shape — a verb, a content clause, a relative modifier,
a parallel sibling — the boundary is doing useful work; the blanked
piece is a distinct unit that could fail without its neighbours. If
blanking leaves a fuzzy mid-thought gap, the two sides are one
mental move and the boundary is in the wrong place.

**Why split at all.** Each phrase carries its own FSRS recall
state. The split's job is to put boundaries at real memory seams —
points where the reciter could plausibly fail one side without the
other. Both directions away from that have costs.

*Under-splitting* (boundaries too coarse) bundles separable memories
under one state. Composite stability follows roughly ``S = (S_a ×
S_b) / (S_a + S_b)`` and approaches zero as more pieces compose; the
shared state decays prematurely for both. This hurts Recitation
most — the decomposed grade can't cleanly attribute failure when two
distinct things share one phrase, polluting the state of the piece
the reciter actually had down cold.

*Over-splitting* (boundaries too fine) creates phrases too small to
be coherent memorisable units. A sub-clause the reciter can't
recover from context produces noise on PhraseFill rather than
signal. Awkward, unnatural cuts break review flow. And two pieces
the reciter would always succeed or fail *together* are intertwined
enough to be one memory unit; giving them separate states produces
noisy reviews on either side of a boundary that isn't a memory
boundary.

Aim for granularity that matches the verse's actual memory
structure — neither finer nor coarser.

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

**How phrases are reviewed.** Each phrase ends up reviewed in two
modes: *PhraseFill* (the whole verse is shown with one phrase
blanked, the reciter recovers it from context, grade updates that
phrase's FSRS state directly) and *Recitation* (only the verse
reference is shown, the reciter recites the whole verse, one grade
is decomposed across every phrase's FSRS state). The split is the
partition both modes operate on.

**Why split at all.** Each phrase carries its own FSRS recall
state. The better split has boundaries at real memory seams —
neither finer (boundaries fall mid-thought, intertwined pieces get
separate states, hurting PhraseFill) nor coarser
(independently-forgettable chunks share one state, and composite
stability ``S = (S_a × S_b) / (S_a + S_b)`` decays prematurely for
both, hurting Recitation).

**The recall test (deciding criterion).** Mentally do a PhraseFill
on each phrase in each option: blank it, look at what's left. An
option whose blanks leave a recognisable shape — each phrase a
distinct unit that could fail without its neighbours — is better
than one whose blanks leave fuzzy mid-thought gaps.

**How to read the signals.** Each option carries a signal block —
composite score, per-phrase content-word load and stub flags,
boundary severance kinds (``verb_content``, ``bare_relative``,
``stranded_stub``), length balance. Lower composite generally means
fewer flagged issues, but signals are context, not verdicts: a
single high signal can reflect a deliberate trade-off (a stub
parallel sibling, an ``and``-start continuing a coordinated list).
The recall test decides; signals point at where to look.

**Hard constraints.** Both options have already been validated for
rejoin, word-count sum, and HTML tag balance — you don't need to
re-check.

**Pick rule.** Prefer Option A (the current split) by default —
needless churn is bad. Pick B only when it is *clearly* better
under the recall test, not merely defensible.

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
