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

Rules:

- Target 3 to 10 words per phrase; up to ~12 is fine. A short final
  phrase (1-2 words) is fine when it carries trailing punctuation like
  ``...and Him crucified.``; short fragments in the middle of a verse
  are not. A phrase may run longer than 12 when the clause is genuinely
  continuous and has no natural break — prefer the natural unit over
  forcing an awkward split.
- Break at clause and phrase boundaries. Strong cues:
  - after a comma, semicolon, or colon
  - before a connector that starts a new clause: ``and``, ``but``,
    ``for``, ``that``, ``who``, ``which``, ``or`` — but only when the
    connector begins a new thought, not when it merely glues items in a
    list to the preceding phrase
  - between parallel items: ``not many wise / not many mighty / not
    many noble`` should be three sibling phrases
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

Look for:

- Awkward breakpoints — a split that interrupts a tight idiom or a
  prepositional phrase that should have stayed together
- Missed parallel structure — parallel items lumped into one long
  phrase instead of becoming siblings (e.g. ``not many wise / not many
  mighty / not many noble`` should be three phrases)
- Lopsided distribution — one phrase carrying most of the verse while
  the rest are stubs
- Anything that would feel jarring when reciting the verse aloud

Verse: {ref}
Text: {text}
Current split:
{phrases_block}

Reply with a single JSON object on one line:
{{"verdict": "ok" | "needs_resplit", "reasons": ["...", "..."]}}.
If verdict is "ok", reasons may be empty.
"""
