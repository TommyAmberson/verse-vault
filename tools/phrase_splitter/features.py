"""Deterministic feature extraction for the phrase-splitter pipeline.

This module emits *signals*, not flags. The auditor reads these to surface
verses worth re-examining; the splitter reads these as context for its
re-split decision. Nothing here judges whether a split is good or bad —
that judgement is the LLM's, informed by the signals below.

The module is pure-stdlib and side-effect-free. It reuses ``tokens`` and
``normalise_word`` from ``helpers.py`` for tokenisation; everything else
is constants and small computations over token lists.
"""

from typing import Any, Dict, List, Sequence

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

# Severance sub-pattern labels emitted alongside ``boundary_severance``.
# These string values are part of the prompt contract — they appear in
# rendered prompts and are referenced by name in
# ``.claude/skills/phrase-splitter/references/splitter-agent-instructions.md``.
SEVERANCE_VERB_CONTENT = "verb_content"
SEVERANCE_BARE_RELATIVE = "bare_relative"
SEVERANCE_STRANDED_STUB = "stranded_stub"

# A recitation run: the stretch a reciter says in one go. Runs much
# longer than this usually hide a pause point; cuts inside a shorter
# combined run usually sever one memory unit.
SHORT_RUN = 10
# Length at which a run with a pause point is fully overlong.
LONG_RUN = 16

RELATIVE_WORDS = frozenset({"who", "whom", "whose", "which"})
PREPOSITIONS = frozenset({
    "of", "in", "on", "at", "by", "for", "with", "from", "to", "into", "onto",
    "upon", "through", "between", "among", "against", "before", "after",
    "under", "over", "about", "without", "within", "unto", "toward", "towards",
})
SUBORDINATORS = frozenset({
    "when", "while", "because", "if", "though", "although", "as", "until",
    "lest", "since", "unless", "where", "whoever", "whatever", "whenever",
    "wherever", "whether", "how", "what", "why", "then",
})
# Words that can open a new run after a cut with no punctuation.
CLAUSE_EDGE_WORDS = WEAK_CONNECTORS | SUBORDINATORS | PREPOSITIONS | RELATIVE_WORDS
LIST_CONJUNCTIONS = frozenset({"and", "or", "nor"})
COORDINATORS = frozenset({"and", "but", "or", "nor", "yet", "so", "for"})

# NKJV capitalizes the first word of each poetry line, and joining lines
# leaves "the sower And bread" mid-phrase. It also capitalizes pronouns
# and titles for God ("He", "Your", "Lord"), so only function words that
# aren't pronouns count as line starts.
_PRONOUNS = frozenset({
    "i", "me", "my", "mine", "you", "your", "yours", "he", "him", "his",
    "she", "her", "hers", "it", "its", "we", "us", "our", "ours", "they",
    "them", "their", "theirs", "who", "whom", "whose",
})
LINE_START_WORDS = (FUNCTION_WORDS | COORDINATORS | SUBORDINATORS) - _PRONOUNS

PAUSE_PUNCT_KIND = "punct"
PAUSE_RELATIVE = "relative"
PAUSE_CONTENT_CLAUSE = "content_clause"
PAUSE_LINE_BREAK = "line_break"
PAUSE_LIST = "list"
PAUSE_PARSE = "parse"
# Weak cues: a coordinator or preposition after a content word. Too
# common to place a cut on their own, but they show a long run has a seam.
PAUSE_COORDINATOR = "coordinator"
PAUSE_PREPOSITION = "preposition"
_WEAK_KINDS = frozenset({PAUSE_COORDINATOR, PAUSE_PREPOSITION})

LIST_WORD_CUT = "word_list_cut"
LIST_LEAD_IN_MERGED = "lead_in_merged"
LIST_CLAUSE_ITEMS_MERGED = "clause_items_merged"

_SENTENCE_END = frozenset({".", "?", "!"})


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


def _ends_sentence(token: str) -> bool:
    tail = _trailing_punct(token)
    return bool(tail) and tail[-1] in _SENTENCE_END


def _opens_quote(token: str) -> bool:
    return strip_html(token).startswith(QUOTE_OPENERS)


def _clamp01(x: float) -> float:
    return max(0.0, min(1.0, x))


def _signal_float(d: object, key: str, default: float = 0.0) -> float:
    """Safely read a float-valued signal from a dict-of-mixed-types
    payload. Returns ``default`` if ``d`` isn't a dict or the value is
    missing/non-numeric — the audit report is a JSON round-trip so
    consumers see ``Dict[str, Any]`` shapes. Booleans read as 0 or 1."""
    if not isinstance(d, dict):
        return default
    v = d.get(key, default)
    return float(v) if isinstance(v, (int, float)) else default


def _signal_max(
    d: object, list_key: str, field_key: str, default: float = 0.0
) -> float:
    """Max of ``field_key`` across the list at ``d[list_key]``. Returns
    ``default`` when the list is missing, non-list, or empty."""
    if not isinstance(d, dict):
        return default
    items = d.get(list_key) or []
    if not isinstance(items, list):
        return default
    return max((_signal_float(it, field_key) for it in items), default=default)


def _is_line_start(prev_token: str, token: str) -> bool:
    """A capitalized line-initial function word mid-phrase marks a lost
    NKJV poetry line break. A capital after a sentence end, a colon, or
    opening a quotation is ordinary prose capitalization."""
    word = strip_html(token).lstrip("“‘\"'(")
    if not word or not word[0].isupper() or word == "I":
        return False
    if normalise_word(word) not in LINE_START_WORDS:
        return False
    if _opens_quote(token):
        return False
    tail = _trailing_punct(prev_token)
    return not (tail and tail[-1] in _SENTENCE_END | {":"})


def _pause_points(phrase_tokens: Sequence[str]) -> List[Dict[str, Any]]:
    """Token indexes inside a phrase where a reciter would naturally pause,
    each with the cue that marks it. Index ``i`` means a cut before token
    ``i``. Cuts that would leave a single word on either side are not
    offered."""
    points: List[Dict[str, Any]] = []
    n = len(phrase_tokens)
    words = [normalise_word(t) for t in phrase_tokens]
    for i in range(2, n - 1):
        prev = phrase_tokens[i - 1]
        kind = None
        if _ends_in_pause(prev):
            kind = PAUSE_PUNCT_KIND
        elif _is_line_start(prev, phrase_tokens[i]):
            kind = PAUSE_LINE_BREAK
        elif words[i] in RELATIVE_WORDS:
            kind = PAUSE_RELATIVE
        elif words[i] == "that":
            # "say that Jesus is Lord" is one unit; "told the Jews / that"
            # pauses after the verb's object.
            if words[i - 1] in CONTENT_CLAUSE_VERBS:
                kind = None
            elif any(w in CONTENT_CLAUSE_VERBS for w in words[max(0, i - 3):i]):
                kind = PAUSE_CONTENT_CLAUSE
            elif words[i - 1] not in FUNCTION_WORDS:
                kind = PAUSE_RELATIVE
        elif words[i] in PREPOSITIONS and words[i + 1] in {"which", "whom"}:
            kind = PAUSE_RELATIVE
        elif i >= 3 and n - i >= 3 and words[i - 1] not in FUNCTION_WORDS:
            if words[i] in {"and", "but", "or", "nor", "yet"}:
                kind = PAUSE_COORDINATOR
            elif words[i] in PREPOSITIONS:
                kind = PAUSE_PREPOSITION
        if kind:
            points.append({"index": i, "kind": kind})
    return points


def _long_run(word_count: int, pause_points: Sequence[Dict[str, Any]]) -> float:
    """How far a phrase runs past one recitation run. A phrase with no
    pause point may legitimately stay whole, so it scores at a fraction;
    a punctuation or line-break pause starts the ramp earlier because the
    reciter already breathes there."""
    if not pause_points:
        return round(0.7 * _clamp01((word_count - SHORT_RUN) / (LONG_RUN - SHORT_RUN)), 3)
    kinds = {p["kind"] for p in pause_points}
    if kinds & {PAUSE_PUNCT_KIND, PAUSE_LINE_BREAK}:
        start = SHORT_RUN - 3
    elif kinds <= _WEAK_KINDS:
        start = SHORT_RUN
    else:
        start = SHORT_RUN
    return round(_clamp01((word_count - start) / (LONG_RUN - start)), 3)


def extract_phrase_features(
    phrase_tokens: Sequence[str],
    position: str,
) -> Dict[str, Any]:
    """Features for a single phrase. ``position`` is ``"first"``,
    ``"middle"``, ``"last"``, or ``"only"`` (single-phrase verse)."""
    wc = len(phrase_tokens)
    first_word = normalise_word(phrase_tokens[0]) if phrase_tokens else ""
    last_token = phrase_tokens[-1] if phrase_tokens else ""
    pause_points = _pause_points(phrase_tokens)
    return {
        "word_count": wc,
        "starts_with_weak_connector": first_word in WEAK_CONNECTORS,
        "ends_in_pause_punct": bool(last_token) and _ends_in_pause(last_token),
        "contains_internal_pause": any(_ends_in_pause(t) for t in phrase_tokens[:-1]),
        "ends_mid_clause": bool(last_token) and not _ends_in_terminal(last_token),
        "position": position,
        "pause_points": pause_points,
        "long_run": _long_run(wc, pause_points),
        "lost_line_break": any(p["kind"] == PAUSE_LINE_BREAK for p in pause_points),
    }


def _opens_run(prev_last: str, next_first: str) -> bool:
    """Whether ``next_first`` can start a new run after a cut with no
    punctuation: a connector, subordinator, preposition, relative word,
    quotation, or poetry line start."""
    if _opens_quote(next_first) or _is_line_start(prev_last, next_first):
        return True
    return normalise_word(next_first) in CLAUSE_EDGE_WORDS


def extract_boundary_features(
    prev_tokens: Sequence[str],
    next_tokens: Sequence[str],
    prev_opens_sentence: bool = False,
) -> Dict[str, Any]:
    """Features for a boundary *between* two adjacent phrases.

    ``boundary_severance`` scores a cut at a known cue (``severance_kind``
    names it) that lands inside a short run; cutting a long run at the
    same cue is what the reference set wants, so it scores nothing.
    ``no_pause_cue`` scores a cut with no punctuation before it and no
    clause edge after it. ``prev_opens_sentence`` exempts a short
    sentence-opening lead-in ("For this reason / the Jews …"), whose
    wording is worth its own chunk in word-perfect recall.
    """
    if not prev_tokens or not next_tokens:
        return {"boundary_severance": 0.0, "severance_kind": None, "no_pause_cue": 0.0}

    prev_last_raw = prev_tokens[-1]
    next_first_raw = next_tokens[0]
    prev_last_word = normalise_word(prev_last_raw)
    next_first_word = normalise_word(next_first_raw)
    prev_tail = _trailing_punct(prev_last_raw)
    short_run = len(prev_tokens) + len(next_tokens) < SHORT_RUN

    kind: str | None = None

    # Verb + content clause: tested first because it's the most specific
    # shape (specific verb + specific complementiser, with quote/colon
    # backoffs). Wins over bare_relative when both could apply.
    if (
        short_run
        and prev_last_word in CONTENT_CLAUSE_VERBS
        and next_first_word in CONTENT_CLAUSE_COMPLEMENTISERS
        and not (prev_tail and prev_tail.endswith(":"))
        and not _opens_quote(next_first_raw)
    ):
        kind = SEVERANCE_VERB_CONTENT

    # Bare relative / complementiser: next starts with who/which/that and
    # prev doesn't end in pause-punct.
    if kind is None and short_run and next_first_word in {"who", "which", "that"}:
        if not prev_tail or prev_tail[-1] not in PAUSE_PUNCT:
            kind = SEVERANCE_BARE_RELATIVE

    # Stranded stub: short prev ending mid-clause + next starts with weak
    # connector. Catches "But one / and the same Spirit…" type strandings.
    if kind is None and next_first_word in WEAK_CONNECTORS and len(prev_tokens) < 4:
        if not _ends_in_terminal(prev_last_raw):
            kind = SEVERANCE_STRANDED_STUB

    severance = 0.0
    if kind is not None:
        # Stubby prev intensifies (up to +0.3 at 1-word prev); thin tail
        # intensifies (up to +0.2 at 1-word next).
        severance = _clamp01(
            0.5
            + 0.3 * _clamp01((4 - len(prev_tokens)) / 4)
            + 0.2 * _clamp01((6 - len(next_tokens)) / 6)
        )

    no_pause_cue = 0.0
    lead_in = prev_opens_sentence and len(prev_tokens) <= 4
    if not _ends_in_terminal(prev_last_raw) and not lead_in:
        if not _opens_run(prev_last_raw, next_first_raw):
            # The shorter the severed piece, the more clearly it was one
            # run with its neighbour.
            shorter = min(len(prev_tokens), len(next_tokens))
            no_pause_cue = _clamp01(0.5 + 0.5 * (SHORT_RUN - shorter) / SHORT_RUN)

    return {
        "boundary_severance": round(severance, 3),
        "severance_kind": kind,
        "no_pause_cue": round(no_pause_cue, 3),
    }


def _word_lists(tokens_list: Sequence[str]) -> List[Dict[str, int]]:
    """Find word lists: four or more comma-separated items of one to three
    words, the last optionally opened by and/or/nor. Lists of three are
    left alone (they rarely need their own chunk, and fixed groups like
    "Shadrach, Meshach, and Abed-Nego" are threes). The first item can
    sit after a lead-in in the same comma segment; it is taken to be as
    long as the second item. Returns ``{start, end, lead_in}`` spans in
    token indexes, ``end`` exclusive."""
    segments: List[List[int]] = [[]]
    for i, t in enumerate(tokens_list):
        segments[-1].append(i)
        if _trailing_punct(t).endswith(","):
            segments.append([])
    if not segments[-1]:
        segments.pop()

    def item_len(seg: List[int]) -> int:
        words = [normalise_word(tokens_list[i]) for i in seg]
        if words and words[0] in LIST_CONJUNCTIONS:
            return len(words) - 1
        return len(words)

    lists: List[Dict[str, int]] = []
    k = 1
    while k < len(segments):
        run = [k]
        while run[-1] + 1 < len(segments) and 1 <= item_len(segments[run[-1] + 1]) <= 3:
            nxt = segments[run[-1] + 1]
            ends_comma = _trailing_punct(tokens_list[nxt[-1]]).endswith(",")
            opens_conj = normalise_word(tokens_list[nxt[0]]) in LIST_CONJUNCTIONS
            if not (ends_comma or opens_conj):
                break
            run.append(run[-1] + 1)
            if not ends_comma:
                break
        if not (1 <= item_len(segments[k]) <= 3) or len(run) < 2:
            k += 1
            continue
        first = segments[k - 1]
        width = item_len(segments[k])
        if len(first) < width:
            k += 1
            continue
        if len(run) + 1 >= 4:
            start = first[-width]
            lists.append({
                "start": start,
                "end": segments[run[-1]][-1] + 1,
                "lead_in": start - first[0],
            })
        k = run[-1] + 1
    return lists


def _segments(tokens_list: Sequence[str]) -> List[range]:
    """Token ranges between pause or terminal punctuation."""
    out: List[range] = []
    start = 0
    for i, t in enumerate(tokens_list):
        if _ends_in_terminal(t):
            out.append(range(start, i + 1))
            start = i + 1
    if start < len(tokens_list):
        out.append(range(start, len(tokens_list)))
    return out


def _parallel_asymmetry(tokens_list: Sequence[str], cuts: Sequence[int]) -> float:
    """Score parallel halves cut differently (research R11). Two segments
    are halves when the later one, past its leading conjunction, opens
    with two words that recur in the earlier one ("no one … / and no
    one …"), or when they share a three-word run. Each half runs from the
    matching words to its segment's end."""
    words = [normalise_word(t) for t in tokens_list]
    segs = _segments(tokens_list)
    best = 0.0
    for a_i, a in enumerate(segs):
        for b in segs[a_i + 1:]:
            b_start = b.start
            if words[b_start] in COORDINATORS:
                b_start += 1
            if b.stop - b_start < 2:
                continue
            match = None
            key = words[b_start:b_start + 2]
            if any(w not in FUNCTION_WORDS for w in key):
                for p in range(a.start, a.stop - 1):
                    if words[p:p + 2] == key:
                        match = (p, b_start)
                        break
            if match is None:
                for p in range(a.start, a.stop - 2):
                    gram = words[p:p + 3]
                    if all(w in FUNCTION_WORDS for w in gram):
                        continue
                    for q in range(b_start, b.stop - 2):
                        if words[q:q + 3] == gram:
                            match = (p, q)
                            break
                    if match:
                        break
            if match is None:
                continue
            half_a = range(match[0], a.stop)
            half_b = range(match[1], b.stop)
            cut_a = any(half_a.start < c < half_a.stop for c in cuts)
            cut_b = any(half_b.start < c < half_b.stop for c in cuts)
            if cut_a != cut_b:
                ratio = min(len(half_a), len(half_b)) / max(len(half_a), len(half_b))
                best = max(best, ratio)
    return round(best, 3)


def _list_breaks(
    tokens_list: Sequence[str], cuts: Sequence[int], lists: Sequence[Dict[str, int]],
    phrase_token_lists: Sequence[Sequence[str]],
) -> List[Dict[str, Any]]:
    breaks: List[Dict[str, Any]] = []
    starts = [0] + list(cuts)

    def phrase_of(index: int) -> int:
        return max(i for i, s in enumerate(starts) if s <= index)

    for lst in lists:
        span = lst["end"] - lst["start"]
        if span <= SHORT_RUN and any(lst["start"] < c < lst["end"] for c in cuts):
            breaks.append({"kind": LIST_WORD_CUT, "phrase": phrase_of(lst["start"]) + 1})
        lead_start = lst["start"] - lst["lead_in"]
        if lst["lead_in"] >= 3 and phrase_of(lead_start) == phrase_of(lst["start"]):
            breaks.append({"kind": LIST_LEAD_IN_MERGED, "phrase": phrase_of(lst["start"]) + 1})

    in_list = {i for lst in lists for i in range(lst["start"], lst["end"])}
    offset = 0
    for n, ptoks in enumerate(phrase_token_lists):
        for i in range(3, len(ptoks) - 3):
            g = offset + i
            if g in in_list:
                continue
            if _ends_in_pause(ptoks[i]) and normalise_word(ptoks[i + 1]) in COORDINATORS:
                breaks.append({"kind": LIST_CLAUSE_ITEMS_MERGED, "phrase": n + 1})
                break
        offset += len(ptoks)
    return breaks


def extract_verse_features(
    tokens_list: Sequence[str],
    pwc: Sequence[int],
) -> Dict[str, Any]:
    """Full feature payload for a verse. Handles the single-phrase case
    (``len(pwc) == 1``) by emitting one phrase entry and no boundaries."""
    token_count = len(tokens_list)
    phrase_count = len(pwc)
    if phrase_count == 0:
        return {
            "token_count": token_count,
            "phrase_count": 0,
            "missing_split": 0.0,
            "parallel_asymmetry": 0.0,
            "list_breaks": [],
            "parse": "skipped",
            "phrases": [],
            "boundaries": [],
        }

    phrase_token_lists = slice_phrases(tokens_list, pwc)
    cuts: List[int] = []
    for n in pwc[:-1]:
        cuts.append((cuts[-1] if cuts else 0) + n)
    lists = _word_lists(tokens_list)

    phrases: List[Dict[str, Any]] = []
    offset = 0
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
        # A word list is one memory item: its commas aren't pause points,
        # and its start is one when a standalone lead-in shares the phrase.
        points = [
            p for p in feat["pause_points"]
            if not any(lst["start"] < offset + p["index"] < lst["end"] for lst in lists)
        ]
        for lst in lists:
            local = lst["start"] - offset
            if lst["lead_in"] >= 3 and 2 <= local < len(ptoks) - 1:
                points.append({"index": local, "kind": PAUSE_LIST})
        points.sort(key=lambda p: p["index"])
        feat["pause_points"] = points
        feat["long_run"] = _long_run(len(ptoks), points)
        feat["text"] = " ".join(ptoks)
        phrases.append(feat)
        offset += len(ptoks)

    boundaries: List[Dict[str, Any]] = []
    for i in range(phrase_count - 1):
        prev = phrase_token_lists[i]
        opens_sentence = i == 0 or _ends_sentence(phrase_token_lists[i - 1][-1])
        boundaries.append(
            extract_boundary_features(prev, phrase_token_lists[i + 1], opens_sentence)
        )

    if phrase_count == 1 and token_count > 12:
        missing_split = _clamp01((token_count - 12) / 10)
    else:
        missing_split = 0.0

    return {
        "token_count": token_count,
        "phrase_count": phrase_count,
        "missing_split": round(missing_split, 3),
        "parallel_asymmetry": _parallel_asymmetry(tokens_list, cuts),
        "list_breaks": _list_breaks(tokens_list, cuts, lists, phrase_token_lists),
        "parse": "skipped",
        "phrases": phrases,
        "boundaries": boundaries,
    }


# Score components: (container, signal key, weight). ``container`` is
# ``"phrases"`` or ``"boundaries"`` (max over the list) or ``"verse"``
# (a top-level field). Total weight at full strength is intentionally
# over 1.0 so several saturating problems hit the clamp instead of
# summing past it. Weights are tuned with ``evaluate_phrases.py
# --calibrate`` against the reference set.
COMPOSITE_COMPONENTS = [
    ("boundaries", "boundary_severance", 0.5),
    ("boundaries", "no_pause_cue", 0.3),
    ("phrases", "long_run", 0.6),
    ("phrases", "lost_line_break", 0.4),
    ("verse", "parallel_asymmetry", 0.4),
    ("verse", "missing_split", 0.3),
]
# List-break kinds, weighted like a component that is 1.0 when present.
LIST_BREAK_WEIGHTS = {
    LIST_WORD_CUT: 0.4,
    LIST_LEAD_IN_MERGED: 0.2,
    LIST_CLAUSE_ITEMS_MERGED: 0.15,
}


def component_value(verse_features: Dict[str, Any], container: str, key: str) -> float:
    if container == "verse":
        return _signal_float(verse_features, key)
    return _signal_max(verse_features, container, key)


def composite_signal_score(verse_features: Dict[str, Any]) -> float:
    """Weighted sum of the strongest instance of each signal, clamped to
    ``[0, 1]``. Higher = more worth a human look."""
    score = sum(
        weight * component_value(verse_features, container, key)
        for container, key, weight in COMPOSITE_COMPONENTS
    )
    kinds = {lb.get("kind") for lb in verse_features.get("list_breaks") or []
             if isinstance(lb, dict)}
    score += max((LIST_BREAK_WEIGHTS.get(k, 0.0) for k in kinds), default=0.0)
    return _clamp01(score)
