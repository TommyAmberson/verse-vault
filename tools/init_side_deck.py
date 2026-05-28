#!/usr/bin/env python3
"""Bootstrap a translation side-deck from an existing structural deck.

Mirrors the source deck's structural fields (``year``, ``books``,
``chapters``, ``headings``, per-verse ``book``, ``chapter``,
``verse``, ``clubs``) and replaces the verse-specific data with
target-translation values:

* ``phraseWordCounts`` — single-phrase placeholder covering the
  whole target-translation verse (the splitter pipeline refines this
  next).
* ``annotations`` — dropped: the source's ``wordIndex`` values index
  the source-translation token stream and don't transfer. Run
  ``tools/apply_keyword_annotations.py`` after this script to derive
  the target's annotations from the same rules.
* ``ftvWordCount`` — left as ``null`` (the schema's "unknown / not
  set" sentinel — ``0`` would trip ``tools/evaluate_phrases.py``'s
  out-of-range check). Run ``tools/find_ftvs.py`` to compute real
  values.

``--bible`` is required — picks the target translation. NKJV decks
are bootstrapped from Anki via ``tools/init_deck.py``; this script is
for everything else (e.g. ``78a9f6124f344018-01`` for NIV 2011).

Canonical tokens come from the existing chapter-level
``get_chapter_html`` path with ``include-verse-numbers=true``: the
``/passages/<chapter-id>`` endpoint returns NKJV-shaped
``data-sid``/``class="v"`` markup across translations, so
``extract_chapter_verses`` works unchanged. Tokenisation matches the
runtime renderer's via the same strip+tokenise helpers used by every
other audit tool.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from typing import Any, Dict

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from phrase_splitter.apibible import (  # noqa: E402
    DEFAULT_DB_PATH,
    extract_chapter_verses,
    get_chapter_html,
    open_cache,
)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--source", required=True, help="path to source structural deck")
    ap.add_argument("--out", required=True, help="path to write the side-deck")
    ap.add_argument(
        "--bible", required=True,
        help="target translation bibleId (e.g. 78a9f6124f344018-01 for NIV 2011)",
    )
    ap.add_argument("--db", default=DEFAULT_DB_PATH)
    args = ap.parse_args()

    with open(args.source, encoding="utf-8") as f:
        src = json.load(f)
    conn = open_cache(args.db)

    chapter_tokens: Dict[tuple, Dict[int, list]] = {}
    out_verses = []
    missing: list = []
    for v in src["verses"]:
        book, ch, vno = v["book"], v["chapter"], v["verse"]
        ckey = (book, ch)
        if ckey not in chapter_tokens:
            html = get_chapter_html(conn, book, ch, bible_id=args.bible)
            chapter_tokens[ckey] = extract_chapter_verses(html, book, ch)
        tokens = chapter_tokens[ckey].get(vno, [])
        if not tokens:
            missing.append(f"{book} {ch}:{vno}")
        out_verses.append(
            {
                "book": book,
                "chapter": ch,
                "verse": vno,
                "phraseWordCounts": [len(tokens)] if tokens else [],
                "annotations": [],
                "ftvWordCount": None,
                "clubs": v.get("clubs", []),
            }
        )

    out: Dict[str, Any] = {
        "year": src["year"],
        "books": src["books"],
        "chapters": src["chapters"],
        "verses": out_verses,
        "headings": src.get("headings", []),
    }
    with open(args.out, "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, indent=2)
        f.write("\n")

    if missing:
        print(
            f"WARN {len(missing)} verses had no canonical text "
            f"(first: {missing[0]})",
            file=sys.stderr,
        )
    print(
        f"wrote {args.out}  ({len(out_verses)} verses across "
        f"{len(chapter_tokens)} chapters)",
        file=sys.stderr,
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
