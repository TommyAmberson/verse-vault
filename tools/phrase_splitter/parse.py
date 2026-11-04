"""Optional dependency-parse pause points for the phrase audit.

Importing this module imports spaCy, so ``features.py`` imports it only
inside a guard and the stdlib path keeps working without it. The parse
finds pauses punctuation misses: the start of an adverbial, relative or
complement clause, and the end of a long subject ("Now the sojourn of
the children of Israel who lived in Egypt / was four hundred and thirty
years."). See research R6 in ``specs/008-recitation-splits/``.
"""

import os
import warnings
from functools import lru_cache
from typing import List, Sequence, Set

import spacy

# Best first. The transformer model parses archaic syntax ("He who eats
# ... abides") far better but needs PyTorch; PHRASE_PARSE_MODEL picks one.
_MODELS = ("en_core_web_trf", "en_core_web_sm")

# Clauses whose first word starts a new run.
_CLAUSE_DEPS = frozenset({"advcl", "relcl", "ccomp"})
_SUBJECT_DEPS = frozenset({"nsubj", "nsubjpass", "csubj"})
_OBJECT_DEPS = frozenset({"dobj", "obj"})
# A subject or fronted object this long is a run of its own before its
# verb. Shorter ones stay with the verb: the maintainer rejected "And the
# posts of the door / were shaken" but kept the 6- to 11-word subjects.
_LONG_SUBJECT = 6
_LONG_OBJECT = 4


@lru_cache(maxsize=1)
def _loaded():
    wanted = os.environ.get("PHRASE_PARSE_MODEL")
    for name in (wanted,) if wanted else _MODELS:
        try:
            # The transformer model pulls in PyTorch, which warns about
            # its own Python version support on import.
            with warnings.catch_warnings():
                warnings.simplefilter("ignore", FutureWarning)
                return name, spacy.load(name)
        except OSError:
            continue
    return None, None


def _nlp():
    return _loaded()[1]


def model_name() -> str:
    return _loaded()[0]


def available() -> bool:
    """Whether a model loads; spaCy can be installed without one."""
    return _nlp() is not None


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
            continue
        words = [w for w in subtree if not w.is_punct and w.dep_ != "cc"]
        is_subject = t.dep_ in _SUBJECT_DEPS and len(words) >= _LONG_SUBJECT
        is_fronted_object = (
            t.dep_ in _OBJECT_DEPS and t.i < t.head.i and len(words) >= _LONG_OBJECT
        )
        if is_subject or is_fronted_object:
            after = subtree[-1].i + 1
            if after < len(doc):
                cuts.add(ours(doc[after].idx))
    return {c for c in cuts if 0 < c < len(tokens)}
