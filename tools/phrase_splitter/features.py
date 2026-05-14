"""Deterministic feature extraction for the phrase-splitter pipeline.

This module emits *signals*, not flags. The auditor reads these to surface
verses worth re-examining; the splitter reads these as context for its
re-split decision. Nothing here judges whether a split is good or bad —
that judgement is the LLM's, informed by the signals below.

The module is pure-stdlib and side-effect-free. It reuses ``tokens`` and
``normalise_word`` from ``helpers.py`` for tokenisation; everything else
is constants and small computations over token lists.
"""

from typing import Dict, List, Sequence

from .helpers import normalise_word, strip_html

# Function words — articles, common pronouns, prepositions, auxiliaries,
# conjunctions, complementisers. Kept deliberately narrow so the
# ``function_ratio`` signal stays meaningful. ``that`` is classed as
# function (complementiser); the rare demonstrative reading is a small
# acceptable calibration error.
FUNCTION_WORDS = frozenset({
    # articles
    "a", "an", "the",
    # demonstratives
    "this", "that", "these", "those",
    # personal pronouns
    "i", "me", "my", "mine",
    "you", "your", "yours",
    "he", "him", "his",
    "she", "her", "hers",
    "it", "its",
    "we", "us", "our", "ours",
    "they", "them", "their", "theirs",
    # relative / interrogative
    "who", "whom", "whose", "which", "what",
    # prepositions
    "of", "in", "on", "at", "by", "for", "with", "from",
    "to", "into", "onto", "upon", "through",
    "between", "among", "against", "before", "after",
    # conjunctions
    "and", "but", "or", "nor", "yet", "so",
    # complementisers
    "if", "whether", "as", "than",
    # auxiliaries / copula
    "is", "are", "was", "were", "be", "been", "being", "am",
    "has", "have", "had",
    "do", "does", "did",
    "will", "would", "shall", "should",
    "may", "might", "can", "could", "must",
})

# Subset that, when starting a phrase, often signals the phrase was glued
# back onto the previous one in recitation — its content depends on what
# came before. Used by the ``starts_with_weak_connector`` signal.
WEAK_CONNECTORS = frozenset({
    "and", "but", "for", "or", "nor", "yet", "so",
    "that", "which", "who", "whom", "whose",
})

# Trailing-punctuation tokens that count as a "pause" inside a phrase.
PAUSE_PUNCT = frozenset({",", ";", ":", "—"})

# Trailing characters that mark a phrase ending on a natural break.
# ``--`` is the ASCII em-dash form some sources still use.
_TERMINAL_PUNCT = frozenset({".", "?", "!", ",", ";", ":", "—"})
_TRAILING_QUOTES = frozenset({'"', "'", ")", "]", "}", "»", "”", "’"})


def count_syllables(word: str) -> int:
    """Vowel-cluster heuristic — count contiguous vowel runs, with a
    light correction for silent trailing ``e``. Off-by-one is fine; the
    signal only needs to order phrases roughly by speakability."""
    w = normalise_word(word)
    if not w:
        return 0
    vowels = "aeiouy"
    count = 0
    in_run = False
    for ch in w:
        if ch in vowels:
            if not in_run:
                count += 1
                in_run = True
        else:
            in_run = False
    if w.endswith("e") and count > 1:
        count -= 1
    return max(1, count)


def slice_phrases(tokens_list: Sequence[str], pwc: Sequence[int]) -> List[List[str]]:
    """Slice a flat token list into per-phrase token lists by word counts.

    Does not validate that ``sum(pwc) == len(tokens_list)`` — callers are
    expected to have already checked for sum drift (a blocker).
    """
    result: List[List[str]] = []
    cursor = 0
    for n in pwc:
        result.append(list(tokens_list[cursor:cursor + n]))
        cursor += n
    return result


def _trailing_punct(token: str) -> str:
    """Return the trailing punctuation cluster of a token (after HTML strip
    and closing-quote/paren peel)."""
    s = strip_html(token).rstrip()
    while s and s[-1] in _TRAILING_QUOTES:
        s = s[:-1]
    out: List[str] = []
    for ch in reversed(s):
        if ch.isalnum():
            break
        out.append(ch)
    return "".join(reversed(out))


def _ends_in_pause(token: str) -> bool:
    tail = _trailing_punct(token)
    return bool(tail) and tail[-1] in PAUSE_PUNCT


def _ends_in_terminal(token: str) -> bool:
    tail = _trailing_punct(token)
    return bool(tail) and tail[-1] in _TERMINAL_PUNCT


def extract_phrase_features(
    phrase_tokens: Sequence[str],
    position: str,
    prev_last_token: str = "",
    next_first_token: str = "",
) -> Dict[str, object]:
    """Features for a single phrase. ``position`` is ``"first"``,
    ``"middle"``, or ``"last"``."""
    del prev_last_token, next_first_token  # reserved for future cross-phrase signals
    wc = len(phrase_tokens)
    content = 0
    syllables = 0
    for t in phrase_tokens:
        w = normalise_word(t)
        syllables += count_syllables(t)
        if w and w not in FUNCTION_WORDS:
            content += 1
    function_ratio = (wc - content) / wc if wc else 0.0

    first_word = normalise_word(phrase_tokens[0]) if phrase_tokens else ""
    starts_with_weak_connector = first_word in WEAK_CONNECTORS

    internal_pause = any(_ends_in_pause(t) for t in phrase_tokens[:-1])
    last_token = phrase_tokens[-1] if phrase_tokens else ""
    ends_in_pause_punct = bool(last_token) and _ends_in_pause(last_token)
    ends_mid_clause = bool(last_token) and not _ends_in_terminal(last_token)

    return {
        "word_count": wc,
        "content_word_count": content,
        "function_ratio": round(function_ratio, 3),
        "syllable_count": syllables,
        "starts_with_weak_connector": starts_with_weak_connector,
        "ends_in_pause_punct": ends_in_pause_punct,
        "contains_internal_pause": internal_pause,
        "ends_mid_clause": ends_mid_clause,
        "position": position,
    }


def extract_boundary_features(
    prev_tokens: Sequence[str],
    next_tokens: Sequence[str],
) -> Dict[str, bool]:
    """Features for a boundary *between* two adjacent phrases. The
    ``verb_content_clause`` key is filled in by a later commit when the
    content-clause constants move to this module; for now only the
    restrictive-relative check is computed.
    """
    if not prev_tokens or not next_tokens:
        return {"restrictive_relative": False}

    prev_last = strip_html(prev_tokens[-1]).rstrip()
    next_first_raw = next_tokens[0]
    next_first = normalise_word(next_first_raw)

    # Restrictive relative: previous phrase ends in a noun (no trailing
    # comma) and the next phrase starts with a bare ``who``, ``which``,
    # or ``that`` (no preceding comma → restrictive).
    restrictive_relative = False
    if next_first in {"who", "which", "that"} and prev_last:
        tail = _trailing_punct(prev_tokens[-1])
        # Bare = no trailing pause punctuation on the previous phrase.
        if not tail or tail[-1] not in PAUSE_PUNCT:
            restrictive_relative = True

    return {"restrictive_relative": restrictive_relative}


def extract_verse_features(
    tokens_list: Sequence[str],
    pwc: Sequence[int],
) -> Dict[str, object]:
    """Full feature payload for a verse. Handles the single-phrase case
    (``len(pwc) == 1``) by emitting one phrase entry and no boundaries —
    the verse-level signals (token count vs threshold, function ratio)
    still surface."""
    token_count = len(tokens_list)
    phrase_count = len(pwc)
    if phrase_count == 0:
        return {
            "token_count": token_count,
            "phrase_count": 0,
            "length_balance": 0.0,
            "verse_function_ratio": 0.0,
            "phrases": [],
            "boundaries": [],
        }

    phrase_token_lists = slice_phrases(tokens_list, pwc)
    phrases: List[Dict[str, object]] = []
    for i, ptoks in enumerate(phrase_token_lists):
        if phrase_count == 1:
            position = "only"
        elif i == 0:
            position = "first"
        elif i == phrase_count - 1:
            position = "last"
        else:
            position = "middle"
        feat = extract_phrase_features(ptoks, position)
        feat["text"] = " ".join(ptoks)
        phrases.append(feat)

    boundaries: List[Dict[str, bool]] = []
    if phrase_count > 1:
        for i in range(phrase_count - 1):
            boundaries.append(
                extract_boundary_features(phrase_token_lists[i], phrase_token_lists[i + 1])
            )

    mean_wc = sum(pwc) / phrase_count
    length_balance = (max(pwc) / mean_wc) if mean_wc else 0.0

    total_function = sum(int(p["content_word_count"]) for p in phrases)  # type: ignore[arg-type]
    verse_function_ratio = (token_count - total_function) / token_count if token_count else 0.0

    return {
        "token_count": token_count,
        "phrase_count": phrase_count,
        "length_balance": round(length_balance, 3),
        "verse_function_ratio": round(verse_function_ratio, 3),
        "phrases": phrases,
        "boundaries": boundaries,
    }


def composite_signal_score(verse_features: Dict[str, object]) -> float:
    """Weighted sum of signals, normalised to ``[0, 1]``. Higher = more
    worth a human look. Weights are an initial baseline — tune after
    seeing a self-audit's distribution.

    Components:

    * boundary signals (restrictive_relative, verb_content_clause)
    * length balance (``max(pwc) / mean`` above ~1.8 is lopsided)
    * weak-connector starts on non-first phrases
    * short mid-phrases (word_count < 3 in middle positions)
    * single-phrase verses that exceed the missing-split threshold
    """
    score = 0.0

    boundaries = verse_features.get("boundaries") or []
    if isinstance(boundaries, list) and boundaries:
        flagged = 0
        for b in boundaries:
            if not isinstance(b, dict):
                continue
            if b.get("restrictive_relative") or b.get("verb_content_clause"):
                flagged += 1
        score += 0.4 * min(1.0, flagged / max(1, len(boundaries)))

    balance = verse_features.get("length_balance")
    if isinstance(balance, (int, float)) and balance > 1.5:
        score += 0.2 * min(1.0, (float(balance) - 1.5) / 1.5)

    phrases = verse_features.get("phrases") or []
    if isinstance(phrases, list) and phrases:
        weak_starts = 0
        short_middles = 0
        for p in phrases:
            if not isinstance(p, dict):
                continue
            if p.get("position") != "first" and p.get("starts_with_weak_connector"):
                weak_starts += 1
            if p.get("position") == "middle":
                wc = p.get("word_count", 0)
                if isinstance(wc, int) and wc < 3:
                    short_middles += 1
        score += 0.2 * min(1.0, weak_starts / max(1, len(phrases) - 1)) if len(phrases) > 1 else 0.0
        if short_middles:
            score += 0.2 * min(1.0, short_middles / max(1, len(phrases)))

    phrase_count = verse_features.get("phrase_count")
    token_count = verse_features.get("token_count")
    if (
        isinstance(phrase_count, int)
        and phrase_count == 1
        and isinstance(token_count, int)
        and token_count > 10
    ):
        score += 0.3 * min(1.0, (token_count - 10) / 10)

    return min(1.0, score)
