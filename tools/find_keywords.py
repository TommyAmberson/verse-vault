#!/usr/bin/env python3
"""Audit the deck's keyword (``bold``) and context-key (``boldItalic``)
annotations in ``data/3-corinthians.json``.

Quiz federation rules (paraphrased from `qzr-sheet/docs/rules.md`):

- **Keyword** (annotation kind ``bold``): a word that appears in
  exactly one verse in the material. The contestant can answer with
  the verse on hearing this word.
- **Context key** (annotation kind ``boldItalic``): a word that
  appears in multiple verses whose **first and last occurrences are
  within 5 verses** of each other (``max_index - min_index <= 5``).
  Since occurrences are collected in verse order, the first-to-last
  gap bounds every other pair, so this single check suffices.

Verse distance is computed sequentially within a single book. The
material includes 1 & 2 Corinthians; cross-book occurrences count as
separate contexts.

Tokens come from the api.bible canonical text (the same source the
runtime renderer uses). Words are compared after lowercasing and
trimming leading/trailing non-letter characters. So ``Paul,`` and
``Paul.`` both normalise to ``paul``; ``God's`` keeps its interior
apostrophe.

The report compares each word's expected markup (per the rules above)
with the markup the deck currently applies via ``annotations``:

- ``over-marked``  — word is marked but doesn't satisfy the rule
- ``under-marked`` — word satisfies the rule but isn't marked
- ``wrong-kind``   — marked as bold but should be boldItalic, or vice versa

Usage:
    python3 tools/find_keywords.py
    python3 tools/find_keywords.py --out report.json
    python3 tools/find_keywords.py --kind keyword
"""

import argparse
import json
import os
import sys
from collections import defaultdict
from typing import Any, Dict, List, Optional, Set, Tuple

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from phrase_splitter.apibible import (  # noqa: E402
    DEFAULT_DB_PATH,
    DEFAULT_NKJV_ID,
    extract_chapter_verses,
    get_chapter_html,
    open_cache,
)
from phrase_splitter.helpers import normalise_word as _normalise  # noqa: E402

CONTEXT_RADIUS = 5  # ±5 verses per the federation rules

MARKUP_PLAIN = "plain"
MARKUP_BOLD = "bold"
MARKUP_BOLD_ITALIC = "boldItalic"


def _annotation_map(verse: Dict[str, Any]) -> Dict[int, str]:
    """``wordIndex → kind`` for the deck annotations on this verse. We
    treat ``italic``-only as plain for this audit — quiz rules only
    elevate ``bold`` (keyword) and ``boldItalic`` (context-key)."""
    out: Dict[int, str] = {}
    for a in verse.get("annotations") or []:
        kind = a.get("kind")
        if kind in (MARKUP_BOLD, MARKUP_BOLD_ITALIC):
            out[a["wordIndex"]] = kind
    return out


def build_word_index(
    deck: Dict[str, Any], conn, bible_id: str
) -> Tuple[
    Dict[str, List[Tuple[str, int, int, str]]],
    Dict[Tuple[str, int, int], int],
]:
    """Walk the material once and collect, per normalised word:

    - the verses it appears in, with the markup the deck applies to it
      in that verse (collapsing same-word repeats inside the verse to a
      single occurrence, with the strongest markup winning)
    - a ``(book, chapter, verse) → sequential_index_within_book`` map
      used for the verse-distance check on context keys.
    """
    occurrences: Dict[str, List[Tuple[str, int, int, str]]] = defaultdict(list)
    book_seq: Dict[str, int] = defaultdict(int)
    verse_index: Dict[Tuple[str, int, int], int] = {}

    chapter_cache: Dict[Tuple[str, int], Dict[int, List[str]]] = {}
    # Walk every verse regardless of phrase-split state: keyword
    # uniqueness and context-key proximity both depend on counting
    # every verse's canonical tokens.
    for v in deck.get("verses", []):
        book = v["book"]
        chapter = v["chapter"]
        verse_num = v["verse"]
        ckey = (book, chapter)
        if ckey not in chapter_cache:
            html = get_chapter_html(conn, book, chapter, bible_id=bible_id)
            chapter_cache[ckey] = extract_chapter_verses(html, book, chapter)
        tokens = chapter_cache[ckey].get(verse_num, [])
        if not tokens:
            continue
        verse_index[(book, chapter, verse_num)] = book_seq[book]
        book_seq[book] += 1

        annotations = _annotation_map(v)
        # Collapse same-word repeats in the verse — keep the strongest
        # markup seen across positions (boldItalic > bold > plain).
        seen_kinds: Dict[str, str] = {}
        for i, token in enumerate(tokens):
            n = _normalise(token)
            if not n:
                continue
            kind = annotations.get(i, MARKUP_PLAIN)
            prev = seen_kinds.get(n, MARKUP_PLAIN)
            if _markup_rank(kind) > _markup_rank(prev):
                seen_kinds[n] = kind
            else:
                seen_kinds.setdefault(n, prev)
        for n, kind in seen_kinds.items():
            occurrences[n].append((book, chapter, verse_num, kind))

    return occurrences, verse_index


def _markup_rank(m: str) -> int:
    return {MARKUP_PLAIN: 0, MARKUP_BOLD: 1, MARKUP_BOLD_ITALIC: 2}.get(m, 0)


def classify_word(
    occurrences: List[Tuple[str, int, int, str]],
    verse_index: Dict[Tuple[str, int, int], int],
) -> str:
    """What the rule says this word should be marked as.

    - 1 occurrence → ``bold`` (keyword)
    - 2+ occurrences, same book, first-to-last gap ≤ ``CONTEXT_RADIUS``
      → ``boldItalic`` (context key)
    - Otherwise → ``plain``
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
    deck. Any occurrence marked boldItalic wins; otherwise bold if any;
    else plain."""
    levels = {m for *_rest, m in occurrences}
    if MARKUP_BOLD_ITALIC in levels:
        return MARKUP_BOLD_ITALIC
    if MARKUP_BOLD in levels:
        return MARKUP_BOLD
    return MARKUP_PLAIN


def _ref_list(occurrences: List[Tuple[str, int, int, str]]) -> List[str]:
    return [f"{b} {c}:{v}" for b, c, v, _m in occurrences]


def audit(
    occurrences: Dict[str, List[Tuple[str, int, int, str]]],
    verse_index: Dict[Tuple[str, int, int], int],
) -> List[Dict[str, Any]]:
    rows: List[Dict[str, Any]] = []
    for word in sorted(occurrences.keys()):
        occs = occurrences[word]
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
        rows.append({
            "word": word,
            "expected": expected,
            "actual": actual,
            "verdict": verdict,
            "occurrence_count": len(occs),
            "refs": _ref_list(occs),
        })
    return rows


def main() -> None:
    ap = argparse.ArgumentParser(
        description=__doc__,
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    ap.add_argument(
        "deck",
        nargs="?",
        default="data/3-corinthians.json",
        help="Structural deck JSON (default: data/3-corinthians.json)",
    )
    ap.add_argument("--db", default=DEFAULT_DB_PATH, help="Shared api.bible SQLite cache")
    ap.add_argument("--bible", default=DEFAULT_NKJV_ID, help="api.bible bibleId (default: NKJV)")
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
        help="Print only the first N rows of each verdict bucket",
    )
    args = ap.parse_args()

    with open(args.deck, encoding="utf-8") as f:
        deck = json.load(f)

    conn = open_cache(args.db)
    try:
        occurrences, verse_index = build_word_index(deck, conn, args.bible)
    finally:
        conn.close()

    findings = audit(occurrences, verse_index)

    if args.kind == "keyword":
        findings = [f for f in findings if f["expected"] == MARKUP_BOLD or f["actual"] == MARKUP_BOLD]
    elif args.kind == "context-key":
        findings = [f for f in findings if f["expected"] == MARKUP_BOLD_ITALIC or f["actual"] == MARKUP_BOLD_ITALIC]

    buckets: Dict[str, List[Dict[str, Any]]] = defaultdict(list)
    for f in findings:
        buckets[f["verdict"]].append(f)

    print(f"Scanned {len(verse_index)} verses, {len(occurrences)} distinct words.")
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
