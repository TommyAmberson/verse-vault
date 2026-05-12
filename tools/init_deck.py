#!/usr/bin/env python3
"""Bootstrap a new structural deck file from an Anki ``.colpkg`` backup
and the api.bible canonical text + sections.

Use this once per new year of the 8-year quizzing cycle (e.g. when
adding ``data/4-john.json`` for year 4 / John). Subsequent refreshes go
through ``import_colpkg.py`` (clubs only) and the audit/edit tools
(``audit_colpkg.py``, ``find_keywords.py``, ``split_phrases.py``) which
all assume the deck file already exists.

What gets populated:

* ``year``            — from ``--year-num``.
* ``books``           — from ``--books`` in the order given.
* ``chapters``        — derived from the colpkg's verse coverage; one
                        entry per (book, chapter) with the observed
                        ``start_verse`` / ``end_verse``.
* ``headings``        — from api.bible's section list. Sections that
                        don't intersect any deck verse are skipped.
* ``verses``          — one entry per Anki ``Verse`` note in the
                        matching year deck:
                        - ``phraseWordCounts`` initialised to a single
                          phrase covering the whole verse (canonical
                          token count). The phrase splitter pipeline
                          refines this later.
                        - ``annotations`` from the Anki HTML markup
                          (``<b>`` → ``bold``, ``<b><i>`` → ``boldItalic``).
                        - ``ftvWordCount`` from the Anki FTV field's
                          word count.
                        - ``clubs`` from the Anki ``club`` field.

Doesn't write to the api.bible cache itself — uses whatever's already
been fetched (passages + sections). Pre-warm with ``get_chapter_html``
and ``get_book_sections`` if the cache is empty.

Usage:
    python3 tools/init_deck.py \\
        data/collection-2026-05-08.colpkg \\
        --year 4-J --year-num 4 --books John \\
        --out data/4-john.json
"""

import argparse
import json
import os
import shutil
import sqlite3
import subprocess
import sys
import tempfile
import zipfile
from collections import defaultdict
from typing import Any, Dict, List, Tuple

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from audit_colpkg import (  # noqa: E402
    COLLECTION_CANDIDATES,
    align_marks_to_canonical,
    extract_keyword_words,
    ftv_word_count,
    parse_clubs,
    parse_reference,
    query_verse_notes,
)
from phrase_splitter.apibible import (  # noqa: E402
    DEFAULT_DB_PATH,
    DEFAULT_NKJV_ID,
    book_code,
    extract_chapter_verses,
    get_book_sections,
    get_chapter_html,
    open_cache,
)


# The OT Survey deck (year 6-OT) has two book names typo'd in the
# Anki source. Normalise on the way out so the deck file carries
# canonical names — fixing the colpkg itself would be the user's job,
# but downstream tools (book_code lookup, render-time fetches) need
# correct names today.
_BOOK_NAME_FIXUPS = {
    "Dueteronomy": "Deuteronomy",
    "Zephanaih": "Zephaniah",
}


def extract_collection(colpkg_path: str, dest_dir: str) -> str:
    """Mirror of audit_colpkg.extract_collection — kept local so the
    init tool depends on a stable sub-import surface."""
    with zipfile.ZipFile(colpkg_path) as zf:
        names = set(zf.namelist())
        present = [c for c in COLLECTION_CANDIDATES if c in names]
        for name in present:
            zf.extract(name, dest_dir)
    if not present:
        sys.exit(f"No {'/'.join(COLLECTION_CANDIDATES)} found in {colpkg_path}")
    if "collection.anki21b" in present:
        src = os.path.join(dest_dir, "collection.anki21b")
        out = os.path.join(dest_dir, "collection.real.anki21")
        zstd = shutil.which("zstd")
        if zstd is None:
            sys.exit("zstd binary not found on PATH (needed for collection.anki21b)")
        subprocess.run([zstd, "-d", "-q", "-f", src, "-o", out], check=True)
        return out
    chosen = "collection.anki21" if "collection.anki21" in present else "collection.anki2"
    return os.path.join(dest_dir, chosen)


def parse_verse_id(verse_id: str) -> Tuple[str, int, int]:
    """``JHN.1.14`` → ``("JHN", 1, 14)``."""
    parts = verse_id.split(".")
    if len(parts) != 3:
        raise ValueError(f"bad verseId: {verse_id!r}")
    return parts[0], int(parts[1]), int(parts[2])


def build_chapters(verse_keys: List[Tuple[str, int, int]]) -> List[Dict[str, Any]]:
    """One entry per (book, chapter) with the verse range observed in
    the colpkg. Honours partial-chapter coverage (e.g. Luke 3 stopping
    at v 22)."""
    by_chapter: Dict[Tuple[str, int], List[int]] = defaultdict(list)
    for book, ch, v in verse_keys:
        by_chapter[(book, ch)].append(v)
    out: List[Dict[str, Any]] = []
    for (book, ch), verses in sorted(by_chapter.items()):
        out.append({
            "book": book,
            "number": ch,
            "start_verse": min(verses),
            "end_verse": max(verses),
        })
    return out


def build_headings(
    sections_by_book: Dict[str, List[Dict[str, str]]],
    verse_keys: set[Tuple[str, int, int]],
) -> List[Dict[str, Any]]:
    """Map api.bible section list → deck headings (verse-range only,
    no title — the runtime fetches titles from the sections cache).
    Drops sections that don't intersect any deck verse so OT-Survey-
    style sparse coverage doesn't get cluttered with phantom passages."""
    code_to_book: Dict[str, str] = {}
    for book in sections_by_book:
        code_to_book[book_code(book)] = book

    out: List[Dict[str, Any]] = []
    for book, sections in sections_by_book.items():
        for s in sections:
            try:
                first_code, sc, sv = parse_verse_id(s["firstVerseId"])
                last_code, ec, ev = parse_verse_id(s["lastVerseId"])
            except (KeyError, ValueError):
                continue
            if first_code != book_code(book) or last_code != book_code(book):
                continue
            # Keep only if at least one deck verse falls in the range.
            keep = False
            for (b, ch, v) in verse_keys:
                if b != book:
                    continue
                if (ch, v) >= (sc, sv) and (ch, v) <= (ec, ev):
                    keep = True
                    break
            if not keep:
                continue
            out.append({
                "book": book,
                "startChapter": sc,
                "startVerse": sv,
                "endChapter": ec,
                "endVerse": ev,
            })
    out.sort(key=lambda h: (h["book"], h["startChapter"], h["startVerse"]))
    return out


def build_verses(
    notes: List[Tuple[str, int, int, str, str, List[int]]],
    canonical: Dict[Tuple[str, int], Dict[int, List[str]]],
) -> Tuple[List[Dict[str, Any]], List[str]]:
    """One entry per colpkg Verse note. Annotations come from the Anki
    markup, mapped back onto canonical token positions by content
    match — Anki's whitespace-split positions disagree with the
    api.bible token stream when api.bible glues words across tag
    boundaries, so trusting Anki positions directly produces silent
    drift. Phrase splits start as a single whole-verse phrase (the
    splitter pipeline refines later)."""
    seen: Dict[Tuple[str, int, int], Dict[str, Any]] = {}
    warnings: List[str] = []
    for book, ch, v, text_html, ftv_html, clubs in notes:
        key = (book, ch, v)
        if key in seen:
            continue
        tokens = canonical.get((book, ch), {}).get(v, [])
        word_count = len(tokens)
        marks = extract_keyword_words(text_html)
        annotations, warns = align_marks_to_canonical(marks, tokens)
        for w in warns:
            warnings.append(f"{book} {ch}:{v}: {w}")
        seen[key] = {
            "book": book,
            "chapter": ch,
            "verse": v,
            "phraseWordCounts": [word_count] if word_count else [],
            "annotations": annotations,
            "ftvWordCount": ftv_word_count(ftv_html) if ftv_html else 0,
            "clubs": clubs,
        }
    return [seen[k] for k in sorted(seen)], warnings


def main() -> None:
    ap = argparse.ArgumentParser(
        description=__doc__,
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    ap.add_argument("colpkg", help="Anki .colpkg backup file")
    ap.add_argument("--year", required=True,
                    help="Year prefix in Anki deck name (e.g. '4-J')")
    ap.add_argument("--year-num", required=True, type=int,
                    help="Year number for the deck file's `year` field")
    ap.add_argument("--books", required=True,
                    help="Comma-separated book names (e.g. 'John' or 'Hebrews,1 Peter,2 Peter')")
    ap.add_argument("--out", required=True,
                    help="Destination JSON path (e.g. data/4-john.json)")
    ap.add_argument("--db", default=DEFAULT_DB_PATH, help="api.bible SQLite cache path")
    ap.add_argument("--bible", default=DEFAULT_NKJV_ID, help="api.bible bibleId (default: NKJV)")
    ap.add_argument("--force", action="store_true",
                    help="Overwrite --out even if it already exists")
    args = ap.parse_args()

    if os.path.exists(args.out) and not args.force:
        sys.exit(f"refusing to overwrite existing {args.out} (pass --force to allow)")

    books = [b.strip() for b in args.books.split(",") if b.strip()]
    book_set = set(books)

    conn = open_cache(args.db)
    try:
        with tempfile.TemporaryDirectory(prefix="vv-init-deck-") as tmp:
            db_path = extract_collection(args.colpkg, tmp)
            raw_notes = list(query_verse_notes(db_path, args.year))
            notes = []
            for book, ch, v, text_html, ftv_html, clubs in raw_notes:
                canon_book = _BOOK_NAME_FIXUPS.get(book, book)
                if canon_book in book_set:
                    notes.append((canon_book, ch, v, text_html, ftv_html, clubs))
        if not notes:
            sys.exit(f"no Verse notes for year={args.year} books={books}")

        verse_keys = sorted({(b, ch, v) for b, ch, v, *_ in notes})

        # Fetch any missing chapter HTML so canonical token counts are
        # available for the phraseWordCounts seed value.
        chapter_keys = sorted({(b, ch) for b, ch, _ in verse_keys})
        canonical: Dict[Tuple[str, int], Dict[int, List[str]]] = {}
        for book, ch in chapter_keys:
            html = get_chapter_html(conn, book, ch, bible_id=args.bible)
            canonical[(book, ch)] = extract_chapter_verses(html, book, ch)

        sections_by_book = {b: get_book_sections(conn, b, bible_id=args.bible) for b in books}
    finally:
        conn.close()

    chapters = build_chapters(verse_keys)
    headings = build_headings(sections_by_book, set(verse_keys))
    verses, mark_warnings = build_verses(notes, canonical)

    deck = {
        "year": args.year_num,
        "books": books,
        "chapters": chapters,
        "verses": verses,
        "headings": headings,
    }

    os.makedirs(os.path.dirname(args.out) or ".", exist_ok=True)
    with open(args.out, "w", encoding="utf-8") as f:
        json.dump(deck, f, indent=2, ensure_ascii=False)

    # Summary
    print(f"Wrote {args.out}")
    print(f"  books    : {books}")
    print(f"  chapters : {len(chapters)}")
    print(f"  headings : {len(headings)}")
    print(f"  verses   : {len(verses)}")
    print(f"  with annotations: "
          f"{sum(1 for v in verses if v['annotations'])} / {len(verses)}")
    print(f"  with clubs     : "
          f"{sum(1 for v in verses if v['clubs'])} / {len(verses)}")
    no_canon = [v for v in verses if not v["phraseWordCounts"]]
    if no_canon:
        print(f"  WARNING: {len(no_canon)} verse(s) had no canonical text:")
        for v in no_canon[:10]:
            print(f"    {v['book']} {v['chapter']}:{v['verse']}")
    if mark_warnings:
        print(f"  WARNING: {len(mark_warnings)} annotation alignment issue(s):")
        for w in mark_warnings[:10]:
            print(f"    {w}")
        if len(mark_warnings) > 10:
            print(f"    …and {len(mark_warnings) - 10} more")


if __name__ == "__main__":
    main()
