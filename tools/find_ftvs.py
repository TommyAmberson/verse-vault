#!/usr/bin/env python3
"""Find the shortest unique opening word-prefix for each verse.

In Bible Quizzing, an FTV (First-Two-Verses / first-few-words) cue is
the short opening prefix the quiz host reads aloud so the contestant
can identify and complete the verse from memory. The cue works only
when that opening prefix is unique across the material — otherwise
multiple verses match and the contestant can't choose.

This script computes the shortest unique opening prefix for every
verse in ``data/corinthians.json`` (structural) using canonical NKJV
tokens from the api.bible HTML cache. Pass ``--audit`` to also diff
against the deck's current ``ftvWordCount`` and flag verses where the
deck cue is too short (ambiguous) or longer than the minimum.

Words are compared case-insensitively after stripping edge
punctuation, so ``Paul,`` and ``Paul.`` match ``paul``. Two verses
with identical openings produce no unique prefix; those are flagged
with severity ``blocker`` since no FTV cue can work.

Usage:
    python3 tools/find_ftvs.py
    python3 tools/find_ftvs.py --audit
    python3 tools/find_ftvs.py --out report.json
"""

import argparse
import json
import os
import re
import sys
from typing import Any, Dict, List, Optional, Tuple

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from phrase_splitter.apibible import (  # noqa: E402
    DEFAULT_DB_PATH,
    DEFAULT_NKJV_ID,
    extract_chapter_verses,
    get_chapter_html,
    open_cache,
)

# Strip leading/trailing chars that aren't letters, digits, or an
# interior apostrophe. Keeps "God's" intact; turns "Paul," into "Paul".
_EDGE_PUNCT_RE = re.compile(r"^[^\w']+|[^\w']+$")


def _normalise(token: str) -> str:
    return _EDGE_PUNCT_RE.sub("", token).lower()


def find_shortest_unique_prefixes(
    keyed_tokens: List[Tuple[Tuple[str, int, int], List[str]]],
) -> Dict[Tuple[str, int, int], Optional[int]]:
    """Return ``{(book, chapter, verse): shortest_unique_prefix_len | None}``.

    ``None`` means no unique prefix exists (another verse opens
    identically over the full normalised token stream)."""
    norms = [(key, [_normalise(t) for t in toks]) for key, toks in keyed_tokens]
    out: Dict[Tuple[str, int, int], Optional[int]] = {}
    for i, (key, toks) in enumerate(norms):
        if not toks:
            out[key] = None
            continue
        unique_at: Optional[int] = None
        for n in range(1, len(toks) + 1):
            head = toks[:n]
            collides = False
            for j, (_okey, other) in enumerate(norms):
                if j == i or len(other) < n:
                    continue
                if other[:n] == head:
                    collides = True
                    break
            if not collides:
                unique_at = n
                break
        out[key] = unique_at
    return out


def main() -> None:
    ap = argparse.ArgumentParser(
        description=__doc__,
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    ap.add_argument(
        "deck",
        nargs="?",
        default="data/corinthians.json",
        help="Structural deck JSON (default: data/corinthians.json)",
    )
    ap.add_argument("--db", default=DEFAULT_DB_PATH, help="Shared api.bible SQLite cache")
    ap.add_argument("--bible", default=DEFAULT_NKJV_ID, help="api.bible bibleId (default: NKJV)")
    ap.add_argument(
        "--audit",
        action="store_true",
        help="Diff computed unique-prefix length against deck's ftvWordCount and flag mismatches",
    )
    ap.add_argument("--out", help="Write the full report as JSON to this path")
    ap.add_argument(
        "--show-non-mismatches",
        action="store_true",
        help="With --audit, also list verses whose ftvWordCount matches the computed minimum",
    )
    args = ap.parse_args()

    with open(args.deck, encoding="utf-8") as f:
        deck = json.load(f)

    conn = open_cache(args.db)
    try:
        keyed_tokens: List[Tuple[Tuple[str, int, int], List[str]]] = []
        chapter_cache: Dict[Tuple[str, int], Dict[int, List[str]]] = {}
        for v in deck.get("verses", []):
            if not v.get("phraseWordCounts"):
                continue
            book = v["book"]
            chapter = v["chapter"]
            ckey = (book, chapter)
            if ckey not in chapter_cache:
                html = get_chapter_html(conn, book, chapter, bible_id=args.bible)
                chapter_cache[ckey] = extract_chapter_verses(html, book, chapter)
            tokens = chapter_cache[ckey].get(v["verse"], [])
            keyed_tokens.append(((book, chapter, v["verse"]), tokens))
    finally:
        conn.close()

    prefixes = find_shortest_unique_prefixes(keyed_tokens)

    # Build a quick book/chapter/verse → deck verse lookup for ftvWordCount.
    deck_index = {(v["book"], v["chapter"], v["verse"]): v for v in deck.get("verses", [])}

    rows: List[Dict[str, Any]] = []
    for (book, chapter, verse), tokens in keyed_tokens:
        key = (book, chapter, verse)
        ref = f"{book} {chapter}:{verse}"
        n = prefixes[key]
        rows.append({
            "ref": ref,
            "shortest_unique_prefix_words": n,
            "shortest_unique_prefix_text": None if n is None else " ".join(tokens[:n]),
            "deck_ftv_word_count": deck_index[key].get("ftvWordCount"),
            "verse_word_count": len(tokens),
        })

    if args.audit:
        mismatches: List[Dict[str, Any]] = []
        ambiguous: List[Dict[str, Any]] = []
        for r in rows:
            n = r["shortest_unique_prefix_words"]
            if n is None:
                ambiguous.append(r)
                continue
            deck_ftv = r["deck_ftv_word_count"]
            if deck_ftv is None:
                continue
            if deck_ftv < n:
                r["audit"] = "too_short"
                mismatches.append(r)
            elif deck_ftv > n:
                r["audit"] = "longer_than_minimum"
                mismatches.append(r)

        print(f"Checked {len(rows)} verses.")
        print(f"No unique opening prefix: {len(ambiguous)}")
        print(f"Deck FTV cue mismatches:  {len(mismatches)}")

        if ambiguous:
            print("\nAmbiguous (no unique prefix — needs disambiguation):")
            for r in ambiguous[:20]:
                print(f"  [blocker] {r['ref']}  ({r['verse_word_count']} words)")
            if len(ambiguous) > 20:
                print(f"  …and {len(ambiguous) - 20} more")

        if mismatches:
            print("\nFTV cue audit:")
            for r in mismatches[:30]:
                tag = "too_short" if r["audit"] == "too_short" else "longer"
                print(
                    f"  [{tag}] {r['ref']}: deck={r['deck_ftv_word_count']}, "
                    f"minimum={r['shortest_unique_prefix_words']}  "
                    f"({r['shortest_unique_prefix_text']!r})"
                )
            if len(mismatches) > 30:
                print(f"  …and {len(mismatches) - 30} more")

        if args.show_non_mismatches:
            ok = [
                r
                for r in rows
                if r["shortest_unique_prefix_words"] is not None
                and r.get("deck_ftv_word_count") == r["shortest_unique_prefix_words"]
            ]
            print(f"\nMatching deck FTV (cue is minimum): {len(ok)}")
    else:
        for r in rows[:30]:
            n = r["shortest_unique_prefix_words"]
            if n is None:
                print(f"  {r['ref']:30s}  AMBIGUOUS  ({r['verse_word_count']} words)")
            else:
                print(
                    f"  {r['ref']:30s}  {n:2d}w  "
                    f"{r['shortest_unique_prefix_text']!r}"
                )
        if len(rows) > 30:
            print(f"  …and {len(rows) - 30} more")

    if args.out:
        os.makedirs(os.path.dirname(args.out) or ".", exist_ok=True)
        with open(args.out, "w", encoding="utf-8") as f:
            json.dump(rows, f, indent=2, ensure_ascii=False)
        print(f"\nWrote full report to {args.out}")


if __name__ == "__main__":
    main()
