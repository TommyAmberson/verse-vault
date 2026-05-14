"""LLM prompts shared by the evaluator (``--llm-judge``) and the re-splitter.

The split prompt is the main quality lever; iterate on the wording and the
example set here. Helpers and CLIs import these constants so the skill, the
``split_phrases.py`` CLI, and the ``evaluate_phrases.py`` judge mode all
speak with the same voice.
"""

SPLIT_PROMPT = """\
You are splitting a Bible verse into memorisation phrases.

The goal is recitation: each phrase should be a chunk a person can hold
in working memory while saying the verse from memory. Imagine reading
the verse aloud — break where a careful reader would breathe, at the
start of a new clause, between parallel items, or after a connective
that ushers in a new thought.

**Guiding principle:** keep splits small, but completeness of thought
matters more than size. Every phrase should be a self-contained
unit of meaning. A 9-word phrase that finishes a thought is better
than 4 + 5 that severs it. When in doubt between a shorter awkward
split and a longer natural one, choose the natural one.

Rules:

- Target 3 to 10 words per phrase; up to ~12 is fine. A short final
  phrase (1-3 words) is fine when it is a *rhetorical or completive
  tail* like ``...and Him crucified.`` or ``...be the glory.`` — a
  closing flourish that stands on its own. It is **not** fine when it
  is a grammatical fragment severed from a mid-verse clause. ``nothing
  was made`` / ``that was made.`` is bad even though the tail ends in
  a period — the relative clause was chopped off, not closed off.
  Short fragments in the middle of a verse are never fine. A phrase
  may run longer than 12 when the clause is genuinely continuous and
  has no natural break — prefer the natural unit over forcing an
  awkward split.
- Break at clause and phrase boundaries. Strong cues:
  - after a comma, semicolon, or colon
  - before a connector that starts a new clause: ``and``, ``but``,
    ``for``, ``that``, ``who``, ``which``, ``or`` — but only when the
    connector begins a new thought, not when it merely glues items in a
    list to the preceding phrase
  - between parallel items: ``not many wise / not many mighty / not
    many noble`` should be three sibling phrases
- **Never split a verb from its content clause.** ``that`` (and
  ``what``, ``how``, ``whether``, ``if``) after a verb of perception
  or speech — ``know``, ``see``, ``tell``, ``say``, ``believe``,
  ``think``, ``hear``, ``understand``, ``remember``, ``perceive`` — is
  introducing the object of that verb, not a new clause for
  recitation. ``"Do you not know"`` / ``"that we shall judge angels?"``
  is a bad break; the rhetorical question is one unit. Same for
  ``"I declare to you"`` / ``"that flesh and blood cannot inherit..."``.
- **Keep rhetorical questions whole.** A question stem (``"Do you not
  know that..."``, ``"Are you not aware that..."``) belongs with its
  content. Split *after* the question mark, not inside it.
- **Keep restrictive relative clauses attached to their antecedent.**
  When ``that``, ``who``, or ``which`` follows a noun *without* a
  preceding comma, it is a restrictive relative — it defines or
  restricts the noun and reads as one unit with no pause. Don't break
  before it. ``"nothing was made"`` / ``"that was made."`` is bad: the
  ``that``-clause restrictively modifies ``"nothing"``. Same shape:
  ``"the bread"`` / ``"which I will give"``, ``"the man"`` / ``"who
  came to Jesus"`` — keep them whole. A *non-restrictive* relative
  (preceded by a comma) is the opposite — the comma is a real pause
  and a valid break point: ``"...Nicodemus, / who came to Jesus by
  night,"`` is fine.
- Never strand a 1-2 word fragment in the middle of the verse (e.g.
  ``"But one"`` followed by the rest of the sentence). Keep small
  introductory phrases with the clause they introduce.
- When a clause is long (over ~12 words), look for an internal comma,
  a relative pronoun (``who``, ``which``, ``that``), or a connective
  and break there. If no such break exists, the long phrase is
  acceptable — naturalness over arbitrary cutoffs.
- Preserve every character exactly, including HTML tags such as
  ``<b>...</b>``, ``<i>...</i>``, ``<b><i>...</i></b>``, and ``<span
  ...>...</span>``. Treat a tagged span as one indivisible unit —
  never split inside a tag, never strip or rewrite a tag.
- Joining the phrases with single spaces must reproduce the verse
  verbatim. If your draft doesn't round-trip, fix it before answering.

Examples:

Input:
    Paul, called to be an apostle of Jesus Christ through the will of God, and <b>Sosthenes</b> our brother,
Output:
    ["Paul, called to be an apostle of Jesus Christ",
     "through the will of God,",
     "and <b>Sosthenes</b> our brother,"]

Input:
    For the kingdom of God is not in word but in power.
Output:
    ["For the kingdom of God is not in word but in power."]

Input:
    For you see your calling, brethren, that not many wise according to the flesh, not many mighty, not many <b>noble</b>, are called.
Output:
    ["For you see your calling, brethren,",
     "that not many wise according to the flesh,",
     "not many mighty,",
     "not many <b>noble</b>,",
     "are called."]

Input:
    But one and the same Spirit works all these things, <b>distributing</b> to each one individually as He wills.
Output:
    ["But one and the same Spirit works all these things,",
     "<b>distributing</b> to each one individually as He wills."]

Input:
    deliver such a one to Satan for the destruction of the flesh, that his spirit may be saved in the day of the Lord Jesus.
Output:
    ["deliver such a one to Satan for the destruction of the flesh,",
     "that his spirit may be saved in the day of the Lord Jesus."]

Input:
    Do you not know that we shall judge angels? How much more, things that pertain to this life?
Output:
    ["Do you not know that we shall judge angels?",
     "How much more, things that pertain to this life?"]

Input:
    All things were made through Him, and without Him nothing was made that was made.
Output:
    ["All things were made through Him,",
     "and without Him nothing was made that was made."]

Now split this verse. Reply with a single JSON array of strings on one
line, nothing else.

Verse:
    {verse_text}
"""


JUDGE_PROMPT = """\
You are auditing a memorisation split of a Bible verse for quality. The
split has already passed deterministic checks (it rejoins to the original
text and every phrase is within the word-count bounds). Your job is to
catch lingering quality issues that need a human eye.

**Guiding principle:** small phrases are good, but completeness of
thought matters more than size. Every phrase should be a self-contained
unit of meaning. A short split that severs a single thought across two
phrases is worse than a longer split that keeps it whole.

Look for:

- Awkward breakpoints — a split that interrupts a tight idiom or a
  prepositional phrase that should have stayed together
- Missed parallel structure — parallel items lumped into one long
  phrase instead of becoming siblings (e.g. ``not many wise / not many
  mighty / not many noble`` should be three phrases)
- Lopsided distribution — one phrase carrying most of the verse while
  the rest are stubs
- **Verb separated from its content clause** — ``that`` / ``what`` /
  ``how`` / ``whether`` / ``if`` after ``know``, ``see``, ``tell``,
  ``say``, ``believe``, ``think``, ``hear``, ``understand``,
  ``remember``, ``perceive`` introduces the *object* of the verb, not
  a new clause. ``"Do you not know"`` / ``"that we shall judge
  angels?"`` is a bad break — the rhetorical question is one unit.
- Mid-question breaks — a rhetorical question stem split from its
  content. Keep the question whole; split *after* the question mark.
- **Restrictive relative clause split from its antecedent** — ``that``
  / ``who`` / ``which`` following a noun *without* a preceding comma
  is restrictive and reads as one unit. ``"nothing was made"`` /
  ``"that was made."`` is bad; the relative clause restrictively
  modifies ``"nothing"`` with no pause. (A non-restrictive relative
  preceded by a comma is a valid break.)
- **Severed grammatical tail** — a short final phrase that is a
  grammatical fragment chopped off a mid-verse clause, not a
  rhetorical or completive ending. ``"that was made."`` as a
  standalone tail is severed; ``"and Him crucified."`` is completive.
- Anything that would feel jarring when reciting the verse aloud

Verse: {ref}
Text: {text}
Current split:
{phrases_block}

Reply with a single JSON object on one line:
{{"verdict": "ok" | "needs_resplit", "reasons": ["...", "..."]}}.
If verdict is "ok", reasons may be empty.
"""
