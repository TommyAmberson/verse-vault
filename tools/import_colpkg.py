#!/usr/bin/env python3
"""Refresh the ``clubs`` field on each verse in the structural deck file
from an Anki ``.colpkg`` backup.

Now that canonical verse text and structure both live in ``data/
corinthians.json`` (and the api.bible cache for the text itself), the
only thing we still need from Anki is each verse's club membership
(Club150 / Club300 — the tiered memorisation challenge buckets the
deck tracks). Everything else stays untouched.

A ``.colpkg`` is a zip of:
    collection.anki21b   (Anki 23+, zstd-compressed SQLite)
    collection.anki21    (Anki 2.1.40+, plain SQLite)
    collection.anki2     (legacy compatibility stub — usually 1 row)
    media + numbered media files

We prefer anki21b → anki21 → anki2 in that order. zstd decompression
shells out to ``/usr/bin/zstd`` to keep this dependency-free.

Usage:
    python3 tools/import_colpkg.py \\
        data/collection-2026-05-08.colpkg \\
        data/corinthians.json \\
        --year 3-C
"""

import argparse
import json
import os
import re
import shutil
import sqlite3
import subprocess
import sys
import tempfile
import zipfile
from typing import List, Tuple

VERSE_FIELDS = ("Sort", "Ref", "Text", "FTV", "club")
ANKI_FIELD_SEP = "\x1f"
COLLECTION_CANDIDATES = ("collection.anki21b", "collection.anki21", "collection.anki2")

# Match the existing structural-file convention for verse references.
_REF_RE = re.compile(r"^([0-9]?\s*[A-Za-z]+)\s+(\d+):(\d+)$")


def parse_reference(ref_str: str) -> Tuple[str, int, int]:
    m = _REF_RE.match(ref_str.strip())
    if not m:
        raise ValueError(f"invalid reference: {ref_str!r}")
    return m.group(1).strip(), int(m.group(2)), int(m.group(3))


def parse_clubs(club_str: str) -> List[int]:
    """Anki's club field is a comma-separated list of tier ids
    (``"150,300"``). Empty or whitespace-only fields mean no club."""
    if not club_str:
        return []
    out: List[int] = []
    for piece in club_str.split(","):
        piece = piece.strip()
        if not piece:
            continue
        try:
            out.append(int(piece))
        except ValueError:
            pass
    return sorted(set(out))


def extract_collection(colpkg_path: str, dest_dir: str) -> str:
    """Extract the .colpkg's collection file, return path to readable SQLite."""
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
            sys.exit("zstd binary not found on PATH (needed to decompress collection.anki21b)")
        subprocess.run([zstd, "-d", "-q", "-f", src, "-o", out], check=True)
        return out
    chosen = "collection.anki21" if "collection.anki21" in present else "collection.anki2"
    return os.path.join(dest_dir, chosen)


def query_verse_notes(db_path: str, year_prefix: str):
    """Yield (book, chapter, verse, clubs) for each ``Verse`` note in
    decks whose name contains ``year_prefix``."""
    con = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
    con.create_collation(
        "unicase",
        lambda a, b: (a.casefold() > b.casefold()) - (a.casefold() < b.casefold()),
    )
    try:
        cur = con.execute(
            """
            SELECT n.flds, m.name,
                   (SELECT d.name FROM cards c
                    JOIN decks d ON c.did = d.id
                    WHERE c.nid = n.id LIMIT 1)
            FROM notes n
            JOIN notetypes m ON n.mid = m.id
            WHERE m.name = 'Verse'
            """
        )
        for flds, _notetype, deck in cur:
            if deck is None or year_prefix not in deck:
                continue
            fields = flds.split(ANKI_FIELD_SEP)
            if len(fields) < 5:
                continue
            _sort, ref_str, _text_html, _ftv_html, club = fields[:5]
            try:
                book, chapter, verse = parse_reference(ref_str)
            except ValueError:
                continue
            yield book, chapter, verse, parse_clubs(club)
    finally:
        con.close()


def main() -> None:
    ap = argparse.ArgumentParser(
        description=__doc__,
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    ap.add_argument("colpkg", help="Anki .colpkg backup file")
    ap.add_argument(
        "deck",
        nargs="?",
        default="data/corinthians.json",
        help="Structural deck JSON to update in place (default: data/corinthians.json)",
    )
    ap.add_argument(
        "--year",
        required=True,
        help="Year prefix matching the Anki deck name (e.g. '3-C')",
    )
    ap.add_argument(
        "--dry-run", action="store_true", help="Report changes without writing the deck"
    )
    args = ap.parse_args()

    with open(args.deck, encoding="utf-8") as f:
        deck = json.load(f)
    by_ref = {
        (v["book"], v["chapter"], v["verse"]): v for v in deck.get("verses", [])
    }

    with tempfile.TemporaryDirectory(prefix="vv-colpkg-") as tmp:
        db_path = extract_collection(args.colpkg, tmp)
        updated = 0
        unchanged = 0
        missing: List[str] = []
        for book, chapter, verse, clubs in query_verse_notes(db_path, args.year):
            key = (book, chapter, verse)
            v = by_ref.get(key)
            if v is None:
                missing.append(f"{book} {chapter}:{verse}")
                continue
            if v.get("clubs") == clubs:
                unchanged += 1
                continue
            v["clubs"] = clubs
            updated += 1

    print(f"Updated clubs on {updated} verses")
    print(f"Unchanged: {unchanged}")
    if missing:
        print(f"In colpkg but not in deck: {len(missing)}")
        for ref in missing[:10]:
            print(f"  {ref}")
        if len(missing) > 10:
            print(f"  …and {len(missing) - 10} more")

    if args.dry_run:
        print("\n(dry-run; deck file unchanged)")
        return

    if updated:
        with open(args.deck, "w", encoding="utf-8") as f:
            json.dump(deck, f, indent=2, ensure_ascii=False)
        print(f"\nUpdated {args.deck}")


if __name__ == "__main__":
    main()
