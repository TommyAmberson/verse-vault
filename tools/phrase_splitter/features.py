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

# Verbs of perception / speech that take a content clause as their direct
# object. See ``.claude/skills/phrase-splitter/references/quality-criteria.md``.
# ``if`` is excluded from the complementiser set because conditional
# ``if`` dominates the rare ``know if`` complementiser reading in
# scripture.
CONTENT_CLAUSE_VERBS = frozenset({
    "know", "knew", "known", "knows",
    "see", "saw", "seen", "sees",
    "hear", "heard", "hears",
    "tell", "told", "tells",
    "say", "said", "says",
    "believe", "believed", "believes",
    "think", "thought", "thinks",
    "understand", "understood", "understands",
    "remember", "remembered", "remembers",
    "perceive", "perceived", "perceives",
    "consider", "considered", "considers",
    "declare", "declared", "declares",
    "suppose", "supposed", "supposes",
    "recognize", "recognized", "recognizes",
    "realize", "realized", "realizes",
    "learn", "learned", "learns",
})
CONTENT_CLAUSE_COMPLEMENTISERS = frozenset({"that", "what", "how", "whether"})

# Stronger reported-speech breaks where the verb-clause heuristic backs
# off — ``say: If any brother…`` and ``say, "How…"`` aren't content
# clauses for memorisation purposes.
QUOTE_OPENERS = ("\"", "“", "‘", "'")


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

    # Cognitive overload: ramps from 0 at content_word_count <= 6
    # to 1.0 at content_word_count >= 12. Content words dominate
    # memorisation difficulty; function-heavy phrases stay light
    # regardless of word_count.
    cognitive_overload = max(0.0, min(1.0, (content - 6) / 6))

    # Stub phrase: ramps from 0 at word_count >= 4 to 0.75 at
    # word_count == 1. Suppressed for the "only" position (single-phrase
    # verse) — a whole-verse phrase isn't a chunking problem.
    if position == "only":
        stub_phrase = 0.0
    else:
        stub_phrase = max(0.0, min(1.0, (4 - wc) / 4))

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
        "cognitive_overload": round(cognitive_overload, 3),
        "stub_phrase": round(stub_phrase, 3),
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
) -> Dict[str, object]:
    """Features for a boundary *between* two adjacent phrases.

    Returns a single continuous ``boundary_severance`` in ``[0, 1]``
    plus a ``severance_kind`` label naming the sub-pattern that fired
    (``"verb_content"`` / ``"bare_relative"`` / ``"stranded_stub"`` /
    ``None``). The kind is descriptive; the score is what the composite
    reads.
    """
    if not prev_tokens or not next_tokens:
        return {"boundary_severance": 0.0, "severance_kind": None}

    prev_last_raw = prev_tokens[-1]
    next_first_raw = next_tokens[0]
    prev_last_word = normalise_word(prev_last_raw)
    next_first_word = normalise_word(next_first_raw)
    prev_tail = _trailing_punct(prev_last_raw)

    kind: str | None = None

    # Verb + content clause: tested first because it's the most specific
    # shape (specific verb + specific complementiser, with quote/colon
    # backoffs). Wins over bare_relative when both could apply.
    if (
        prev_last_word in CONTENT_CLAUSE_VERBS
        and next_first_word in CONTENT_CLAUSE_COMPLEMENTISERS
    ):
        next_first_stripped = strip_html(next_first_raw)
        if prev_tail and prev_tail.endswith(":"):
            pass
        elif next_first_stripped.startswith(QUOTE_OPENERS):
            pass
        else:
            kind = "verb_content"

    # Bare relative / complementiser: next starts with who/which/that and
    # prev doesn't end in pause-punct. Captures both true restrictive
    # relatives and stranded performatives ("I do not say to you / that…").
    if kind is None and next_first_word in {"who", "which", "that"}:
        if not prev_tail or prev_tail[-1] not in PAUSE_PUNCT:
            kind = "bare_relative"

    # Stranded stub: short prev ending mid-clause + next starts with weak
    # connector. Catches "But one / and the same Spirit…" type strandings
    # where neither verb_content nor bare_relative applied.
    if kind is None and next_first_word in WEAK_CONNECTORS and len(prev_tokens) < 4:
        if not _ends_in_terminal(prev_last_raw):
            kind = "stranded_stub"

    if kind is None:
        return {"boundary_severance": 0.0, "severance_kind": None}

    # Base severity + modulators.
    severance = 0.5
    # Stubby prev intensifies (up to +0.3 at 1-word prev).
    severance += 0.3 * max(0.0, (4 - len(prev_tokens)) / 4)
    # Thin tail intensifies (up to +0.2 at 1-word next).
    severance += 0.2 * max(0.0, (6 - len(next_tokens)) / 6)
    severance = min(1.0, severance)

    return {
        "boundary_severance": round(severance, 3),
        "severance_kind": kind,
    }


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
            "missing_split": 0.0,
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

    if phrase_count == 1 and token_count > 12:
        missing_split = min(1.0, (token_count - 12) / 10)
    else:
        missing_split = 0.0

    return {
        "token_count": token_count,
        "phrase_count": phrase_count,
        "length_balance": round(length_balance, 3),
        "verse_function_ratio": round(verse_function_ratio, 3),
        "missing_split": round(missing_split, 3),
        "phrases": phrases,
        "boundaries": boundaries,
    }


def composite_signal_score(verse_features: Dict[str, object]) -> float:
    """Weighted sum of continuous score signals, clamped to ``[0, 1]``.

    Higher = more worth a human look. Each component signal is itself
    a float in ``[0, 1]``; the composite is a simple weighted sum of
    max-aggregates over phrases/boundaries.

    Weights:

    * ``boundary_severance`` (max over boundaries): 0.5
    * ``cognitive_overload`` (max over phrases):    0.3
    * ``missing_split`` (verse-level):              0.3
    * ``stub_phrase`` (max over phrases):           0.2

    Total at full strength = 1.3, intentionally over 1.0 so multiple
    saturating problems hit the clamp instead of summing past it.
    """
    score = 0.0

    boundaries = verse_features.get("boundaries") or []
    if isinstance(boundaries, list) and boundaries:
        max_sev = 0.0
        for b in boundaries:
            if isinstance(b, dict):
                sev = b.get("boundary_severance", 0.0)
                if isinstance(sev, (int, float)):
                    max_sev = max(max_sev, float(sev))
        score += 0.5 * max_sev

    phrases = verse_features.get("phrases") or []
    if isinstance(phrases, list) and phrases:
        max_overload = 0.0
        max_stub = 0.0
        for p in phrases:
            if isinstance(p, dict):
                ov = p.get("cognitive_overload", 0.0)
                if isinstance(ov, (int, float)):
                    max_overload = max(max_overload, float(ov))
                stub = p.get("stub_phrase", 0.0)
                if isinstance(stub, (int, float)):
                    max_stub = max(max_stub, float(stub))
        score += 0.3 * max_overload
        score += 0.2 * max_stub

    missing = verse_features.get("missing_split", 0.0)
    if isinstance(missing, (int, float)):
        score += 0.3 * float(missing)

    return min(1.0, score)
