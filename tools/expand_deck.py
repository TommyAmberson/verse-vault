#!/usr/bin/env python3
"""Expand a structural deck file to its full quizzing material.

A year's deck file as produced by ``init_deck.py`` only carries the
verses that exist as ``Verse`` notes in the Anki ``.colpkg`` — for
years 5/6/7 today that's just the Club 150 cut. The full quizzing
material is broader: every chapter that contains at least one
Club 150 or Club 300 verse, taken in its entirety.

This tool layers the printed back-list's Club 300 list onto an
existing deck, then fills in the remaining verses of every touched
chapter (the "full" tier — ``clubs: []``). Existing verses keep
their annotations / FTV / phrase splits; new verses are seeded
with one whole-verse phrase and empty annotations, matching
``init_deck.py``.

Tier-definition input (``--tiers``) JSON shape:

    {
      "year": 5,
      "books": ["Hebrews", "1 Peter", "2 Peter"],
      "club_300": {
        "Hebrews": {"1": [5, 6, ...], "2": [...], ...},
        "1 Peter": {...},
        "2 Peter": {...}
      }
    }

The Club 150 set is read straight off the deck (verses already
flagged ``clubs: [150]``); we don't duplicate it in the tiers file
because the colpkg is its source of truth.

The "full" chapter set is derived: every chapter that contains at
least one Club 150 or Club 300 verse. Every verse 1..N of those
chapters that isn't already in 150 or 300 gets ``clubs: []``.

Usage:
    python3 tools/expand_deck.py \\
        --deck data/5-hp.json \\
        --tiers data/5-hp-tiers.json
        [--out data/5-hp.json]          # default: in-place
        [--dry-run]
"""

import argparse
import json
import os
import sys
from collections import defaultdict
from typing import Any, Dict, List, Set, Tuple

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from phrase_splitter.apibible import (  # noqa: E402
    DEFAULT_DB_PATH,
    DEFAULT_NKJV_ID,
    book_code,
    extract_chapter_verses,
    get_book_sections,
    get_chapter_html,
    open_cache,
)


VerseKey = Tuple[str, int, int]


def parse_verse_id(verse_id: str) -> Tuple[str, int, int]:
    parts = verse_id.split(".")
    if len(parts) != 3:
        raise ValueError(f"bad verseId: {verse_id!r}")
    return parts[0], int(parts[1]), int(parts[2])


def derive_full_chapters(verse_keys: Set[VerseKey]) -> Dict[str, Set[int]]:
    """For each book, which chapter numbers contain at least one
    Club 150 or 300 verse — those are the chapters to fully expand."""
    out: Dict[str, Set[int]] = defaultdict(set)
    for book, ch, _v in verse_keys:
        out[book].add(ch)
    return out


def build_chapters(verse_keys: Set[VerseKey]) -> List[Dict[str, Any]]:
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
    verse_keys: Set[VerseKey],
) -> List[Dict[str, Any]]:
    out: List[Dict[str, Any]] = []
    for book, sections in sections_by_book.items():
        code = book_code(book)
        for s in sections:
            try:
                first_code, sc, sv = parse_verse_id(s["firstVerseId"])
                last_code, ec, ev = parse_verse_id(s["lastVerseId"])
            except (KeyError, ValueError):
                continue
            if first_code != code or last_code != code:
                continue
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


def main() -> None:
    ap = argparse.ArgumentParser(
        description=__doc__,
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    ap.add_argument("--deck", required=True, help="Existing deck file to expand")
    ap.add_argument("--tiers", required=True, help="Tier-definition JSON (Club 300 list)")
    ap.add_argument("--out", help="Output deck path (default: overwrite --deck)")
    ap.add_argument("--dry-run", action="store_true",
                    help="Report what would change without writing")
    ap.add_argument("--db", default=DEFAULT_DB_PATH, help="api.bible SQLite cache path")
    ap.add_argument("--bible", default=DEFAULT_NKJV_ID, help="api.bible bibleId (default: NKJV)")
    args = ap.parse_args()

    out_path = args.out or args.deck

    with open(args.deck, encoding="utf-8") as f:
        deck = json.load(f)
    with open(args.tiers, encoding="utf-8") as f:
        tiers = json.load(f)

    if tiers.get("year") != deck.get("year"):
        sys.exit(
            f"year mismatch: deck={deck.get('year')} tiers={tiers.get('year')}"
        )
    books = tiers.get("books") or deck.get("books") or []
    if not books:
        sys.exit("no `books` in tiers or deck — can't expand")

    # Index existing verses; preserve their authored fields.
    existing: Dict[VerseKey, Dict[str, Any]] = {
        (v["book"], v["chapter"], v["verse"]): v
        for v in deck.get("verses", [])
    }

    # Parse Club 300 entries; record which (book, ch, v) gets clubs=[300].
    club_300: Set[VerseKey] = set()
    raw_300 = tiers.get("club_300") or {}
    for book, chapters in raw_300.items():
        for ch_str, verses in chapters.items():
            ch = int(ch_str)
            for v in verses:
                club_300.add((book, ch, int(v)))

    # Sanity: a Club 300 verse should not already be flagged Club 150.
    overlaps = []
    for key in club_300:
        v_entry = existing.get(key)
        if v_entry and 150 in (v_entry.get("clubs") or []):
            overlaps.append(key)
    if overlaps:
        print(f"WARNING: {len(overlaps)} verse(s) tagged Club 150 in the deck "
              f"and Club 300 in the tier file:")
        for (b, c, v) in overlaps[:10]:
            print(f"  {b} {c}:{v}")

    # Full-chapter set: every chapter touched by any club-tagged verse.
    touched_chapters: Dict[str, Set[int]] = defaultdict(set)
    for key in existing:
        touched_chapters[key[0]].add(key[1])
    for (b, ch, _v) in club_300:
        touched_chapters[b].add(ch)

    # Fetch canonical tokens for every touched (book, chapter) so we
    # know the chapter length and can seed phraseWordCounts.
    conn = open_cache(args.db)
    canonical: Dict[Tuple[str, int], Dict[int, List[str]]] = {}
    sections_by_book: Dict[str, List[Dict[str, str]]] = {}
    try:
        for book in books:
            chapters = sorted(touched_chapters.get(book, set()))
            for ch in chapters:
                html = get_chapter_html(conn, book, ch, bible_id=args.bible)
                canonical[(book, ch)] = extract_chapter_verses(html, book, ch)
            sections_by_book[book] = get_book_sections(conn, book, bible_id=args.bible)
    finally:
        conn.close()

    # Build the expanded verse set.
    expanded: Dict[VerseKey, Dict[str, Any]] = {}
    added_300 = 0
    added_full = 0
    for book in books:
        for ch in sorted(touched_chapters.get(book, set())):
            chapter_tokens = canonical.get((book, ch), {})
            chapter_len = max(chapter_tokens.keys(), default=0)
            for v in range(1, chapter_len + 1):
                key = (book, ch, v)
                if key in existing:
                    expanded[key] = existing[key]
                    continue
                tokens = chapter_tokens.get(v, [])
                if not tokens:
                    # Canonical text missing for this verse — skip
                    # rather than fabricate. The init_deck warning
                    # message covers the diagnostic.
                    continue
                clubs = [300] if key in club_300 else []
                expanded[key] = {
                    "book": book,
                    "chapter": ch,
                    "verse": v,
                    "phraseWordCounts": [len(tokens)],
                    "annotations": [],
                    "ftvWordCount": 0,
                    "clubs": clubs,
                }
                if clubs:
                    added_300 += 1
                else:
                    added_full += 1

    # Preserve any existing verses outside the touched chapters
    # (defensive — shouldn't happen for a well-formed deck).
    for key, v in existing.items():
        expanded.setdefault(key, v)

    new_verse_list = [expanded[k] for k in sorted(expanded)]
    verse_keys = set(expanded.keys())

    deck["books"] = books
    deck["verses"] = new_verse_list
    deck["chapters"] = build_chapters(verse_keys)
    deck["headings"] = build_headings(sections_by_book, verse_keys)

    # Sanity: any Club 300 verse from the tier file we couldn't seed?
    missing_300 = sorted(club_300 - verse_keys)
    if missing_300:
        print(f"WARNING: {len(missing_300)} Club 300 verse(s) couldn't be seeded "
              f"(no canonical text in cache):")
        for (b, c, v) in missing_300[:10]:
            print(f"  {b} {c}:{v}")

    print(f"deck verses: {len(existing)} → {len(new_verse_list)}")
    print(f"  added Club 300 : {added_300}")
    print(f"  added full     : {added_full}")
    print(f"  chapters       : {len(deck['chapters'])}")
    print(f"  headings       : {len(deck['headings'])}")
    counts_by_tier: Dict[Tuple[int, ...], int] = defaultdict(int)
    for v in new_verse_list:
        counts_by_tier[tuple(v.get("clubs") or ())] += 1
    print("  by tier        : "
          + ", ".join(f"{k or '[]'}={n}" for k, n in sorted(counts_by_tier.items())))

    if args.dry_run:
        print("(dry-run — no write)")
        return

    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(deck, f, indent=2, ensure_ascii=False)
    print(f"wrote {out_path}")


if __name__ == "__main__":
    main()
