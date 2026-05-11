#!/usr/bin/env python3
"""Audit the deck's keyword (``<b>``) and context-key (``<b><i>``) markup.

Quiz federation rules (paraphrased from `qzr-sheet/docs/rules.md`):

- **Keyword** (marked ``<b>``): a word that appears in exactly one verse
  in the material. The contestant can answer with the verse on hearing
  this word.
- **Context key** (marked ``<b><i>``): a word that appears in multiple
  verses whose **first and last occurrences are within 5 verses** of
  each other (``max_index - min_index <= 5``). Since occurrences are
  collected in verse order, the first-to-last gap bounds every other
  pair, so this single check suffices. The contestant can locate the
  context on hearing this word even though more than one verse
  contains it.

Verse distance is computed sequentially within a single book. The
material includes 1 & 2 Corinthians; cross-book occurrences are treated
as separate contexts (a word in 1 Cor and 2 Cor can't be a context key
no matter how close the in-chapter numbers look).

Words are compared after stripping inline HTML tags, lowercasing, and
trimming leading/trailing non-letter characters. So ``Paul,`` and
``Paul.`` both normalise to ``paul``; ``God's`` keeps its interior
apostrophe.

The script emits a comparison between what the deck has marked today
and what the rules say should be marked, flagging:

- ``over-marked``  — word is marked but doesn't satisfy the rule.
- ``under-marked`` — word satisfies the rule but isn't marked.
- ``wrong-kind``   — word is marked ``<b>`` but should be ``<b><i>``,
                     or vice versa.

Usage:
    python3 tools/find_keywords.py data/corinthians-parsed.json
    python3 tools/find_keywords.py data/corinthians-parsed.json --out report.json
    python3 tools/find_keywords.py data/corinthians-parsed.json --kind keyword
"""

import argparse
import json
import os
import re
import sys
from collections import defaultdict
from typing import Any, Dict, List, Optional, Set, Tuple

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from phrase_splitter import strip_html  # noqa: E402

CONTEXT_RADIUS = 5  # ±5 verses per the federation rules

# Markup levels, in priority order — boldItalic > bold > plain.
MARKUP_PLAIN = "plain"
MARKUP_BOLD = "bold"
MARKUP_BOLD_ITALIC = "boldItalic"

_EDGE_PUNCT_RE = re.compile(r"^[^\w']+|[^\w']+$")

# Match a single-word annotation wrapper. The deck's text cleaning
# normalises multi-word `<b>` / `<i>` spans to per-word tags
# (see tools/parse_anki.py), so we expect each wrapper to enclose
# exactly one whitespace-token after stripping inner tags.
_BOLD_ITALIC_RE = re.compile(r"<b><i>([^<]+)</i></b>", re.IGNORECASE)
_ITALIC_BOLD_RE = re.compile(r"<i><b>([^<]+)</b></i>", re.IGNORECASE)
_BOLD_RE = re.compile(r"<b>([^<]+)</b>", re.IGNORECASE)


def _normalise(token: str) -> str:
    return _EDGE_PUNCT_RE.sub("", token).lower()


def extract_word_markups(text: str) -> Dict[str, str]:
    """Scan a verse's text for inline markup. Returns a map of
    ``normalised_word → markup level`` (``boldItalic`` if a word is
    wrapped both ways anywhere in the verse, else ``bold`` if any
    occurrence is bold, else absent). Same-word occurrences within
    the verse are collapsed so a verse-internal "love ... love" pair
    where one is bolded is reported as bold.
    """
    out: Dict[str, str] = {}

    def upsert(word: str, level: str) -> None:
        n = _normalise(word)
        if not n:
            return
        prev = out.get(n)
        if (
            prev is None
            or (prev == MARKUP_BOLD and level == MARKUP_BOLD_ITALIC)
        ):
            out[n] = level

    for m in _BOLD_ITALIC_RE.finditer(text):
        upsert(m.group(1), MARKUP_BOLD_ITALIC)
    for m in _ITALIC_BOLD_RE.finditer(text):
        upsert(m.group(1), MARKUP_BOLD_ITALIC)
    # Plain bold has to come after bold-italic so we don't double-count
    # the outer ``<b>`` of a ``<b><i>``. Strip already-matched
    # bold-italic spans from a working copy before scanning for bold.
    stripped = _BOLD_ITALIC_RE.sub("", text)
    stripped = _ITALIC_BOLD_RE.sub("", stripped)
    for m in _BOLD_RE.finditer(stripped):
        upsert(m.group(1), MARKUP_BOLD)
    return out


def build_word_index(
    verses: List[Dict[str, Any]],
) -> Tuple[
    Dict[str, List[Tuple[str, int, int, str]]],
    Dict[Tuple[str, int, int], int],
]:
    """Walk the material once and build:

    - ``word → [(book, chapter, verse, current_markup), ...]`` — the
      list of every verse that contains the (normalised) word, with the
      deck's current markup for that word in that verse.
    - ``(book, chapter, verse) → sequential_index_within_book`` — used
      for verse-distance arithmetic.
    """
    word_occurrences: Dict[str, List[Tuple[str, int, int, str]]] = defaultdict(list)
    book_sequence: Dict[str, int] = defaultdict(int)
    verse_index: Dict[Tuple[str, int, int], int] = {}

    for v in verses:
        book = v["book"]
        chapter = v["chapter"]
        verse_num = v["verse"]
        text = v.get("text", "")
        if not text:
            continue
        verse_index[(book, chapter, verse_num)] = book_sequence[book]
        book_sequence[book] += 1

        markups = extract_word_markups(text)
        seen_in_verse: Set[str] = set()
        for token in strip_html(text).split():
            n = _normalise(token)
            if not n or n in seen_in_verse:
                continue
            seen_in_verse.add(n)
            level = markups.get(n, MARKUP_PLAIN)
            word_occurrences[n].append((book, chapter, verse_num, level))

    return word_occurrences, verse_index


def classify_word(
    occurrences: List[Tuple[str, int, int, str]],
    verse_index: Dict[Tuple[str, int, int], int],
) -> str:
    """Return what the rule says this word should be marked as: ``bold``,
    ``boldItalic``, or ``plain``.

    - 1 occurrence (in 1 verse) → keyword ``bold``.
    - 2+ occurrences all in the same book, first-to-last gap within
      ``CONTEXT_RADIUS`` verses (``max_index - min_index <= 5``) →
      context key ``boldItalic``.
    - Otherwise → ``plain`` (shouldn't be marked).
    """
    if len(occurrences) == 1:
        return MARKUP_BOLD
    books = {book for book, _c, _v, _m in occurrences}
    if len(books) > 1:
        return MARKUP_PLAIN
    indices = [verse_index[(b, c, v)] for b, c, v, _m in occurrences]
    if max(indices) - min(indices) <= CONTEXT_RADIUS:
        return MARKUP_BOLD_ITALIC
    return MARKUP_PLAIN


def deck_marking_for_word(occurrences: List[Tuple[str, int, int, str]]) -> str:
    """The strongest markup level applied to this word anywhere in the
    deck. If any occurrence is bold-italic the word is treated as marked
    bold-italic; else bold if any is bold; else plain.
    """
    levels = {m for *_rest, m in occurrences}
    if MARKUP_BOLD_ITALIC in levels:
        return MARKUP_BOLD_ITALIC
    if MARKUP_BOLD in levels:
        return MARKUP_BOLD
    return MARKUP_PLAIN


def _ref_list(occurrences: List[Tuple[str, int, int, str]]) -> List[str]:
    return [f"{b} {c}:{v}" for b, c, v, _m in occurrences]


def audit(
    word_occurrences: Dict[str, List[Tuple[str, int, int, str]]],
    verse_index: Dict[Tuple[str, int, int], int],
) -> List[Dict[str, Any]]:
    rows: List[Dict[str, Any]] = []
    for word in sorted(word_occurrences.keys()):
        occs = word_occurrences[word]
        expected = classify_word(occs, verse_index)
        actual = deck_marking_for_word(occs)
        if expected == actual:
            continue
        if actual == MARKUP_PLAIN:
            verdict = "under-marked"
        elif expected == MARKUP_PLAIN:
            verdict = "over-marked"
        else:
            verdict = "wrong-kind"
        rows.append(
            {
                "word": word,
                "expected": expected,
                "actual": actual,
                "verdict": verdict,
                "occurrence_count": len(occs),
                "refs": _ref_list(occs),
            }
        )
    return rows


def main() -> None:
    ap = argparse.ArgumentParser(
        description=__doc__,
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    ap.add_argument(
        "input",
        help="Text-bearing chunked JSON (e.g. data/corinthians-parsed.json)",
    )
    ap.add_argument(
        "--kind",
        choices=("keyword", "context-key", "all"),
        default="all",
        help="Limit the report to one marker class",
    )
    ap.add_argument("--out", help="Write the full report as JSON to this path")
    ap.add_argument(
        "--top",
        type=int,
        help="Print only the first N rows of each section (verdict bucket)",
    )
    args = ap.parse_args()

    with open(args.input, encoding="utf-8") as f:
        data = json.load(f)
    verses = [v for v in data.get("verses", []) if v.get("text")]

    word_occurrences, verse_index = build_word_index(verses)
    findings = audit(word_occurrences, verse_index)

    if args.kind == "keyword":
        findings = [
            f
            for f in findings
            if f["expected"] == MARKUP_BOLD or f["actual"] == MARKUP_BOLD
        ]
    elif args.kind == "context-key":
        findings = [
            f
            for f in findings
            if f["expected"] == MARKUP_BOLD_ITALIC or f["actual"] == MARKUP_BOLD_ITALIC
        ]

    # Group by verdict for readable output.
    buckets: Dict[str, List[Dict[str, Any]]] = defaultdict(list)
    for f in findings:
        buckets[f["verdict"]].append(f)

    print(f"Scanned {len(verses)} verses, {len(word_occurrences)} distinct words.")
    print(f"Flagged: {len(findings)}")
    for verdict in ("over-marked", "under-marked", "wrong-kind"):
        rows = buckets[verdict]
        if not rows:
            continue
        print(f"\n{verdict} ({len(rows)}):")
        shown = rows if args.top is None else rows[: args.top]
        for r in shown:
            print(
                f"  {r['word']!r:20s} expected={r['expected']:11s} "
                f"actual={r['actual']:11s} ({r['occurrence_count']}x)"
            )
            preview = ", ".join(r["refs"][:5])
            if len(r["refs"]) > 5:
                preview += f", … +{len(r['refs']) - 5}"
            print(f"    refs: {preview}")
        if args.top is not None and len(rows) > args.top:
            print(f"  …and {len(rows) - args.top} more")

    if args.out:
        os.makedirs(os.path.dirname(args.out) or ".", exist_ok=True)
        with open(args.out, "w", encoding="utf-8") as f:
            json.dump(findings, f, indent=2, ensure_ascii=False)
        print(f"\nWrote full report to {args.out}")


if __name__ == "__main__":
    main()
