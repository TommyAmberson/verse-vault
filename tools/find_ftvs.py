#!/usr/bin/env python3
"""Find the shortest unique opening word-prefix for each verse.

In Bible Quizzing, an FTV (First-Two-Verses / first-few-words) cue is the
short opening prefix the quiz host reads aloud so the contestant can
identify and complete the verse from memory. The cue works only when
that opening prefix is unique across the material — otherwise multiple
verses match and the contestant can't choose.

This script computes the shortest unique opening prefix for every verse
in a text-bearing material JSON and reports it. Pass ``--audit`` to also
diff against the deck's current ``ftv_word_count`` and flag verses where
the deck is set too short (ambiguous) or longer than needed.

Words are compared case-insensitively after stripping inline HTML tags
and edge punctuation, so ``Paul,`` and ``Paul.`` match ``paul``. Two
verses with identical openings produce no unique prefix; those are
flagged with severity ``blocker`` since no FTV cue can work.

Usage:
    python3 tools/find_ftvs.py data/corinthians-parsed.json
    python3 tools/find_ftvs.py data/corinthians-parsed.json --audit
    python3 tools/find_ftvs.py data/corinthians-parsed.json --out report.json
"""

import argparse
import json
import os
import re
import sys
from typing import Any, Dict, List, Optional, Tuple

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from phrase_splitter import strip_html  # noqa: E402

# Strip leading/trailing chars that aren't letters, digits, or an
# interior apostrophe. Keeps "God's" intact; turns "Paul," into "Paul".
_EDGE_PUNCT_RE = re.compile(r"^[^\w']+|[^\w']+$")


def _normalise(token: str) -> str:
    return _EDGE_PUNCT_RE.sub("", token).lower()


def visible_tokens(text: str) -> List[str]:
    """Whitespace tokens with HTML stripped but punctuation glued in."""
    return strip_html(text).split()


def normalised_tokens(text: str) -> List[str]:
    """Lowercased + edge-punctuation-stripped tokens for comparison."""
    return [_normalise(t) for t in visible_tokens(text)]


def find_shortest_unique_prefixes(
    verses: List[Dict[str, Any]],
) -> Dict[Tuple[str, int, int], Optional[int]]:
    """Return ``{(book, chapter, verse): shortest_unique_prefix_len | None}``.

    A verse's shortest unique prefix is the smallest ``n`` such that no
    other verse in the material has the same first ``n`` normalised
    tokens. ``None`` means no unique prefix exists (another verse opens
    identically over the full normalised token stream).
    """
    keys = [(v["book"], v["chapter"], v["verse"]) for v in verses]
    norms = [normalised_tokens(v.get("text", "")) for v in verses]

    out: Dict[Tuple[str, int, int], Optional[int]] = {}
    # For each verse, grow the prefix until no other verse's tokens
    # start with the same sequence.
    for i, key in enumerate(keys):
        toks = norms[i]
        if not toks:
            out[key] = None
            continue
        unique_at: Optional[int] = None
        for n in range(1, len(toks) + 1):
            head = toks[:n]
            collides = False
            for j, other in enumerate(norms):
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
        "input",
        help="Text-bearing chunked JSON (e.g. data/corinthians-parsed.json)",
    )
    ap.add_argument(
        "--audit",
        action="store_true",
        help="Diff computed unique-prefix length against deck's ftv_word_count and flag mismatches",
    )
    ap.add_argument("--out", help="Write the full report as JSON to this path")
    ap.add_argument(
        "--show-non-mismatches",
        action="store_true",
        help="With --audit, also list verses whose ftv_word_count matches the computed minimum",
    )
    args = ap.parse_args()

    with open(args.input, encoding="utf-8") as f:
        data = json.load(f)

    verses = [v for v in data.get("verses", []) if v.get("text")]
    prefixes = find_shortest_unique_prefixes(verses)

    rows: List[Dict[str, Any]] = []
    for v in verses:
        key = (v["book"], v["chapter"], v["verse"])
        ref = f"{v['book']} {v['chapter']}:{v['verse']}"
        n = prefixes[key]
        tokens = visible_tokens(v["text"])
        deck_ftv = v.get("ftv_word_count")
        if deck_ftv is None and v.get("ftv"):
            # Older shapes store ftv as a string. Count its visible
            # tokens as a fallback for the audit comparison.
            deck_ftv = len(strip_html(v["ftv"]).split())
        row = {
            "ref": ref,
            "shortest_unique_prefix_words": n,
            "shortest_unique_prefix_text": None if n is None else " ".join(tokens[:n]),
            "deck_ftv_word_count": deck_ftv,
            "verse_word_count": len(tokens),
        }
        rows.append(row)

    if args.audit:
        mismatches = []
        ambiguous = []
        for r in rows:
            n = r["shortest_unique_prefix_words"]
            if n is None:
                ambiguous.append(r)
                continue
            deck = r["deck_ftv_word_count"]
            if deck is None:
                continue
            if deck < n:
                # Deck's cue is shorter than the minimum unique prefix —
                # the cue collides with another verse and is ambiguous.
                r["audit"] = "too_short"
                mismatches.append(r)
            elif deck > n:
                # Deck's cue is longer than needed; not wrong but wastes
                # the contestant's working memory.
                r["audit"] = "longer_than_minimum"
                mismatches.append(r)

        print(f"Checked {len(verses)} verses.")
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
        # Plain listing
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
