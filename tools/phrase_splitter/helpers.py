"""Deterministic helpers used across the phrase-split and audit tools.

Word counting strips the inline HTML markup the deck preserves
(``<b>``/``<i>``/``<span>``) so a tagged token like ``<b>Sosthenes</b>``
counts as one word. Whitespace is the tokeniser — punctuation glues to
adjacent tokens, matching the convention in
``tools/phrase_splitter/apibible.py``.
"""

import re
from typing import List, Tuple

# Inline tags the deck preserves. Stripping these but keeping their inner
# content yields the user-visible word stream.
_TAG_RE = re.compile(r"</?(?:b|i|span)(?:\s[^>]*)?>", re.IGNORECASE)


def strip_html(text: str) -> str:
    return _TAG_RE.sub("", text)


def tokens(text: str) -> List[str]:
    return strip_html(text).split()


def word_count(text: str) -> int:
    return len(tokens(text))


def rejoin_matches(phrases: List[str], text: str) -> bool:
    return " ".join(phrases) == text


_OPEN_TAG_RE = re.compile(r"<(b|i|span)(?:\s[^>]*)?>", re.IGNORECASE)
_CLOSE_TAG_RE = re.compile(r"</(b|i|span)>", re.IGNORECASE)


def html_tags_balanced(text: str) -> bool:
    """Same multiset of open vs close tags. Cheap and sufficient: the
    pipeline elsewhere already guarantees well-formed nesting in the
    source, so we only need to catch a phrase that broke mid-tag (e.g.
    ``"...word <b>partial"`` next to ``"continued</b> ..."``).
    """
    opens = sorted(m.group(1).lower() for m in _OPEN_TAG_RE.finditer(text))
    closes = sorted(m.group(1).lower() for m in _CLOSE_TAG_RE.finditer(text))
    return opens == closes


# "1 Corinthians 12:11" → ("1 Corinthians", 12, 11). The cache uses this
# canonical form as its key, so the regex anchors on the trailing
# C:V pair and treats everything before as the book name.
_REF_RE = re.compile(r"^(.+?)\s+(\d+):(\d+)\s*$")


def parse_reference(ref: str) -> Tuple[str, int, int]:
    m = _REF_RE.match(ref.strip())
    if not m:
        raise ValueError(f"invalid reference: {ref!r}")
    return m.group(1).strip(), int(m.group(2)), int(m.group(3))


# Loose-input aliases. Lowercased key → canonical book name as used in the
# cache. The list is intentionally small; extend as new books arrive.
_BOOK_ALIASES = {
    "1 corinthians": "1 Corinthians",
    "1corinthians": "1 Corinthians",
    "1 cor": "1 Corinthians",
    "1cor": "1 Corinthians",
    "i corinthians": "1 Corinthians",
    "2 corinthians": "2 Corinthians",
    "2corinthians": "2 Corinthians",
    "2 cor": "2 Corinthians",
    "2cor": "2 Corinthians",
    "ii corinthians": "2 Corinthians",
}


def normalize_reference(ref: str) -> str:
    """Canonicalise loose user input to the cache's ``Book C:V`` key form.

    Accepts ``"1 cor 12:11"``, ``"1Cor 12:11"``, ``"1 Corinthians 12:11"``,
    etc., and returns ``"1 Corinthians 12:11"``. Unknown book strings
    pass through unchanged so the evaluator can still report a clean
    "not in cache" error rather than crash.
    """
    book, chap, verse = parse_reference(ref)
    key = re.sub(r"\s+", " ", book.lower().replace(".", "")).strip()
    canon = _BOOK_ALIASES.get(key, book)
    return f"{canon} {chap}:{verse}"


# Trim a token to its bare lemma form. Curly U+2019 folds to straight
# U+0027 first so the deck's typographic apostrophes compare equal to
# Anki's straight ones. Leading non-letter/non-digit is stripped
# unconditionally. The trailing edge is peeled iteratively to draw a
# careful distinction between a possessive apostrophe (which we want
# to keep — ``conscience'`` ≠ ``conscience``) and a closing quote
# masquerading as an apostrophe (``mind,'`` should normalise to
# ``mind``). A trailing apostrophe is kept only when it sits right
# after a letter; otherwise it's typography and gets stripped.
_LEADING_NONWORD_RE = re.compile(r"^[^\w]+")


def normalise_word(token: str) -> str:
    s = token.replace("’", "'").replace("‘", "'").lower()
    s = _LEADING_NONWORD_RE.sub("", s)
    while s:
        last = s[-1]
        if last.isalnum():
            break
        if last == "'" and len(s) >= 2 and s[-2].isalpha():
            break
        s = s[:-1]
    return s
