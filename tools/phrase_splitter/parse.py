"""Optional dependency-parse pause points for the phrase audit.

Importing this module imports spaCy, so ``features.py`` imports it only
inside a guard and the stdlib path keeps working without it. The parse
finds pauses punctuation misses: the start of an adverbial, relative or
complement clause, and the end of a long subject ("Now the sojourn of
the children of Israel who lived in Egypt / was four hundred and thirty
years."). See research R6 in ``specs/008-recitation-splits/``.
"""

from functools import lru_cache
from typing import List, Sequence, Set

import spacy

MODEL = "en_core_web_sm"

# Clauses whose first word starts a new run.
_CLAUSE_DEPS = frozenset({"advcl", "relcl", "ccomp"})
_SUBJECT_DEPS = frozenset({"nsubj", "nsubjpass", "csubj"})
# A subject this long is a run of its own before its verb.
_LONG_SUBJECT = 4


@lru_cache(maxsize=1)
def _nlp():
    return spacy.load(MODEL)


def available() -> bool:
    """Whether the model loads; spaCy can be installed without it."""
    try:
        _nlp()
    except OSError:
        return False
    return True


def pause_cuts(tokens: Sequence[str]) -> Set[int]:
    """Verse token indexes where the parse places a pause (a cut before
    that token)."""
    starts: List[int] = []
    pos = 0
    for t in tokens:
        starts.append(pos)
        pos += len(t) + 1

    def ours(char_idx: int) -> int:
        lo, hi = 0, len(starts) - 1
        while lo < hi:
            mid = (lo + hi + 1) // 2
            if starts[mid] <= char_idx:
                lo = mid
            else:
                hi = mid - 1
        return lo

    doc = _nlp()(" ".join(tokens))
    cuts: Set[int] = set()
    for t in doc:
        subtree = list(t.subtree)
        if t.dep_ in _CLAUSE_DEPS:
            cuts.add(ours(subtree[0].idx))
        elif t.dep_ in _SUBJECT_DEPS and len(subtree) >= _LONG_SUBJECT:
            after = subtree[-1].i + 1
            if after < len(doc):
                cuts.add(ours(doc[after].idx))
    return {c for c in cuts if 0 < c < len(tokens)}
