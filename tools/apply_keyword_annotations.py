#!/usr/bin/env python3
"""Derive a deck's ``annotations`` from the keyword / context-key rules.

The rules in ``tools/find_keywords.py`` are deterministic over the
canonical text:

* a word appearing in exactly one verse is a keyword (``bold``);
* a word appearing in two or more verses within the same book,
  whose first-and-last occurrences are within ``CONTEXT_RADIUS``
  verses, is a context key (``boldItalic``);
* anything else is plain.

That means the auditor's "expected" markup _is_ the correct
annotation set. This script walks every verse, classifies every
word, and writes ``{wordIndex, kind}`` entries back into the deck —
overwriting any existing ``annotations`` array. Use it to populate a
side-deck where annotations weren't carried over from the source
(e.g. ``init_niv_deck.py``, which drops NKJV-indexed annotations).

After running, ``tools/find_keywords.py`` against the same deck
should report ``Flagged: 0``.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from typing import Any, Dict, List

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from phrase_splitter.apibible import (  # noqa: E402
    DEFAULT_DB_PATH,
    DEFAULT_NKJV_ID,
    extract_chapter_verses,
    get_chapter_html,
    open_cache,
)
from phrase_splitter.helpers import normalise_word as _normalise  # noqa: E402
from find_keywords import (  # noqa: E402
    MARKUP_BOLD,
    MARKUP_BOLD_ITALIC,
    MARKUP_PLAIN,
    build_word_index,
    classify_word,
)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("deck")
    ap.add_argument("--bible", default=DEFAULT_NKJV_ID)
    ap.add_argument("--db", default=DEFAULT_DB_PATH)
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    with open(args.deck, encoding="utf-8") as f:
        deck = json.load(f)
    conn = open_cache(args.db)
    occurrences, verse_index = build_word_index(deck, conn, args.bible)
    expected = {w: classify_word(occurrences[w], verse_index) for w in occurrences}

    chapter_cache: Dict[tuple, Dict[int, List[str]]] = {}
    n_keyword = n_context = 0
    for v in deck["verses"]:
        ckey = (v["book"], v["chapter"])
        if ckey not in chapter_cache:
            html = get_chapter_html(conn, v["book"], v["chapter"], bible_id=args.bible)
            chapter_cache[ckey] = extract_chapter_verses(html, v["book"], v["chapter"])
        tokens = chapter_cache[ckey].get(v["verse"], [])
        annotations: List[Dict[str, Any]] = []
        for i, tok in enumerate(tokens):
            n = _normalise(tok)
            if not n:
                continue
            kind = expected.get(n, MARKUP_PLAIN)
            if kind == MARKUP_PLAIN:
                continue
            annotations.append({"wordIndex": i, "kind": kind})
            if kind == MARKUP_BOLD:
                n_keyword += 1
            elif kind == MARKUP_BOLD_ITALIC:
                n_context += 1
        v["annotations"] = annotations

    print(
        f"derived {n_keyword} keyword + {n_context} context-key annotation entries",
        file=sys.stderr,
    )
    if args.dry_run:
        return 0
    with open(args.deck, "w", encoding="utf-8") as f:
        json.dump(deck, f, ensure_ascii=False, indent=2)
        f.write("\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
