#!/usr/bin/env python3
"""Expand a structural deck file to its full quizzing material.

A year's deck file as produced by ``init_deck.py`` only carries the
verses that exist as ``Verse`` notes in the Anki ``.colpkg`` — for
years 5/6/7 today that's just the Club 150 cut. The full quizzing
material is broader: Club 300 (a second 150-verse set printed in
the QuizMeet booklet) layered on top, plus any "full-tier" verses
that aren't in either club.

Tier-definition input (``--tiers``) JSON shape:

    {
      "year": 5,
      "books": ["Hebrews", "1 Peter", "2 Peter"],
      "club_300": {
        "Hebrews": {"1": [5, 6, ...], ...},
        ...
      },

      // Choose ONE of the following to declare the full tier:
      //   (a) every chapter touched by 150∪300, in entirety:
      "expand_to_full_chapters": true,

      //   (b) explicit per-chapter range list (list of inclusive
      //       [start, end] pairs; supports gaps via multiple pairs):
      "full": {
        "Genesis": {
          "1":  [[1, 31]],
          "11": [[1, 9]],
          "50": [[15, 26]]
        },
        "Joel": {
          "2": [[12, 13], [28, 32]]
        }
      }
    }

The Club 150 set is read straight off the deck (verses already
flagged ``clubs: [150]``); the tiers file shouldn't duplicate it
— the colpkg is its source of truth.

Verses already in Club 150 or 300 retain that tier when they fall
inside the full set — the full tier is additive, never demoting.
A Club 150/300 verse that falls *outside* the declared full set is
flagged with a warning (likely a transcription error).

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


def expand_full_ranges(
    full_decl: Dict[str, Dict[str, List[List[int]]]],
) -> Set[VerseKey]:
    """Flatten the ``full`` declaration's [start, end] pairs into a
    concrete verse set."""
    out: Set[VerseKey] = set()
    for book, chapters in full_decl.items():
        for ch_str, ranges in chapters.items():
            ch = int(ch_str)
            for pair in ranges:
                if len(pair) != 2:
                    raise ValueError(f"bad range for {book} {ch}: {pair!r}")
                start, end = int(pair[0]), int(pair[1])
                for v in range(start, end + 1):
                    out.add((book, ch, v))
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

    # Compute the full-tier verse set from the tier file.
    raw_full = tiers.get("full")
    expand_chapters = bool(tiers.get("expand_to_full_chapters"))
    if raw_full and expand_chapters:
        sys.exit("tier file declares both `full` and `expand_to_full_chapters`; pick one")

    # Touched-chapter set: union of (existing 150) + Club 300 + full-tier sources.
    touched_chapters: Dict[str, Set[int]] = defaultdict(set)
    for key in existing:
        touched_chapters[key[0]].add(key[1])
    for (b, ch, _v) in club_300:
        touched_chapters[b].add(ch)
    if raw_full:
        for book, chapters in raw_full.items():
            for ch_str in chapters:
                touched_chapters[book].add(int(ch_str))

    # Fetch canonical tokens for every touched (book, chapter) so we
    # know chapter lengths and can seed phraseWordCounts.
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

    # Build the full-tier verse set (verses to be seeded with clubs=[]).
    if raw_full:
        full_tier: Set[VerseKey] = expand_full_ranges(raw_full)
    elif expand_chapters:
        full_tier = set()
        for book in books:
            for ch in sorted(touched_chapters.get(book, set())):
                chapter_len = max(canonical.get((book, ch), {}).keys(), default=0)
                for v in range(1, chapter_len + 1):
                    full_tier.add((book, ch, v))
    else:
        full_tier = set()

    # Cross-check: any 150/300 verse outside the declared full set?
    declared = full_tier | set(existing.keys()) | club_300
    outside_150 = sorted(k for k in existing if 150 in (existing[k].get("clubs") or [])
                         and k not in full_tier and full_tier)
    outside_300 = sorted(k for k in club_300 if k not in full_tier and full_tier)
    for label, keys in (("Club 150", outside_150), ("Club 300", outside_300)):
        if not keys:
            continue
        print(f"WARNING: {len(keys)} {label} verse(s) outside the declared full set:")
        for (b, c, v) in keys[:10]:
            print(f"  {b} {c}:{v}")

    # Compose the expanded verse map: existing 150 verses (preserved),
    # plus 300 and full-tier verses with seeded scaffolding.
    expanded: Dict[VerseKey, Dict[str, Any]] = {}
    added_300 = 0
    added_full = 0

    target_keys: Set[VerseKey] = set(existing.keys()) | club_300 | full_tier
    for key in sorted(target_keys):
        book, ch, v = key
        if key in existing:
            expanded[key] = existing[key]
            continue
        tokens = canonical.get((book, ch), {}).get(v, [])
        if not tokens:
            # No canonical text — skip rather than fabricate.
            continue
        clubs = [300] if key in club_300 else []
        expanded[key] = {
            "book": book,
            "chapter": ch,
            "verse": v,
            "phraseWordCounts": [len(tokens)],
            "annotations": [],
            # `null`, not 0. Newly seeded rows are always pre-audit —
            # `null` is the schema's "no Ftv card emitted" sentinel,
            # covering both "pending audit" (the state we're in
            # immediately after this script writes) and "no unique
            # prefix exists" (the state ambiguous verses land in after
            # `find_ftvs.py --audit` + `apply_audit.py` run and the
            # ambiguous-skip branch leaves the value alone). The Rust
            # core's `builder.rs` short-circuits the Ftv card emission
            # while the row is `null`, so the card never appears in
            # /memorize until an integer is written. Zero would
            # violate the deck invariant `evaluate_phrases.py:117`
            # enforces (`ftv < 1` is BLOCK) and would make every
            # seeded verse a blocker on the next audit pass.
            "ftvWordCount": None,
            "clubs": clubs,
        }
        if clubs:
            added_300 += 1
        else:
            added_full += 1

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
