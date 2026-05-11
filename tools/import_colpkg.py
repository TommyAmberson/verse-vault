#!/usr/bin/env python3
"""Import an Anki .colpkg directly into verse-vault's intermediate JSON.

Replaces the older `parse_anki.py` flow that depended on a manual
`Notes in Plain Text` export. A `.colpkg` is a zip of:
    collection.anki21b   (Anki 23+, zstd-compressed SQLite)
    collection.anki21    (Anki 2.1.40+, plain SQLite)
    collection.anki2     (legacy compatibility stub — usually 1 row)
    media + numbered media files

We prefer anki21b → anki21 → anki2 in that order. zstd decompression
shells out to `/usr/bin/zstd` to keep this dependency-free.

Phrase splits aren't carried in Anki — they come from the LLM chunking
pipeline (see tools/README.md). To avoid re-running the LLM after every
content update, pass `--phrases path/to/phrases.json`. Each verse whose
text matches the cached fingerprint reuses the cached phrases; mismatches
fall back to `[whole verse]` and are listed at exit so you know what to
re-chunk.

Usage:
    python3 tools/import_colpkg.py \\
        data/collection-2026-05-08.colpkg \\
        data/corinthians-parsed.json \\
        --year 3-C \\
        --phrases data/corinthians-phrases.json
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

import parse_anki

VERSE_FIELDS = ("Sort", "Ref", "Text", "FTV", "club")
HEADING_FIELDS = ("Sort", "Front", "Back", "Add Reverse")
ANKI_FIELD_SEP = "\x1f"


COLLECTION_CANDIDATES = ("collection.anki21b", "collection.anki21", "collection.anki2")


def extract_collection(colpkg_path: str, dest_dir: str) -> str:
    """Extract the .colpkg's collection file, return path to readable SQLite.

    A .colpkg also contains media files (potentially MB of images) — extract
    just the collection candidates we care about.
    """
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
    # Legacy fallback for anki2: in modern backups it's a 1-row stub — the
    # caller should sanity-check note count after.
    chosen = "collection.anki21" if "collection.anki21" in present else "collection.anki2"
    return os.path.join(dest_dir, chosen)


def query_notes(db_path: str):
    """Yield (notetype_name, deck_name, fields_tuple, tags) per note."""
    con = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
    # Anki declares a custom `unicase` collation on a few columns. SQLite
    # refuses to open the DB until it's registered, so stand in with a
    # case-insensitive Python comparator (we don't ORDER BY collated cols
    # but the DDL still references unicase).
    con.create_collation("unicase", lambda a, b: (a.casefold() > b.casefold()) - (a.casefold() < b.casefold()))
    try:
        cur = con.execute(
            """
            SELECT n.id, n.flds, n.tags, m.name AS notetype,
                   (SELECT d.name FROM cards c
                    JOIN decks d ON c.did = d.id
                    WHERE c.nid = n.id LIMIT 1) AS deck
            FROM notes n
            JOIN notetypes m ON n.mid = m.id
            WHERE m.name IN ('Verse', 'Heading')
            """
        )
        for _id, flds, tags, notetype, deck in cur:
            if deck is None:
                # Note has no card → orphaned; skip
                continue
            yield notetype, deck, flds.split(ANKI_FIELD_SEP), tags
    finally:
        con.close()


def load_phrases_cache(path: str | None) -> dict[str, dict]:
    if path is None or not os.path.exists(path):
        return {}
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("colpkg", help="Anki .colpkg backup file")
    ap.add_argument("output", help="Path to output JSON file")
    ap.add_argument("--year", required=True, help="Year prefix to match in deck names (e.g. '3-C')")
    ap.add_argument(
        "--phrases",
        default=None,
        help="Optional path to a phrases cache JSON (see tools/extract_phrases.py)",
    )
    args = ap.parse_args()

    cache = load_phrases_cache(args.phrases)
    if args.phrases:
        print(f"Loaded {len(cache)} cached phrase splits from {args.phrases}")

    with tempfile.TemporaryDirectory(prefix="vv-colpkg-") as tmp:
        db = extract_collection(args.colpkg, tmp)
        verses, headings, stats = process(db, args.year, cache)

    verses.sort(key=lambda v: (v["book"], v["chapter"], v["verse"]))
    chapters = parse_anki.build_chapters(verses)
    books = sorted({v["book"] for v in verses})
    year_num = int(args.year.split("-")[0]) if "-" in args.year else 0

    out = {
        "year": year_num,
        "books": books,
        "chapters": chapters,
        "verses": verses,
        "headings": headings,
    }
    os.makedirs(os.path.dirname(args.output) or ".", exist_ok=True)
    with open(args.output, "w", encoding="utf-8") as f:
        json.dump(out, f, indent=2, ensure_ascii=False)

    print(f"\nWritten to {args.output}")
    print(f"  {len(verses)} verses, {len(headings)} headings, {len(chapters)} chapters")
    print(
        f"  {stats['cached']} cached, "
        f"{stats['needs_chunking']} need re-chunking, "
        f"{stats['empty']} empty (no text)"
    )
    missing = stats["missing_refs"]
    if missing:
        print("\nVerses without a cached split (using [whole verse] placeholder):")
        for ref in missing[:20]:
            print(f"  {ref}")
        if len(missing) > 20:
            print(f"  …and {len(missing) - 20} more")


def process(db_path: str, year_prefix: str, cache: dict[str, dict]):
    verses: list[dict] = []
    headings: list[dict] = []
    stats = {"cached": 0, "needs_chunking": 0, "empty": 0, "missing_refs": []}

    for notetype, deck, fields, _tags in query_notes(db_path):
        if year_prefix not in deck:
            continue

        if notetype == "Verse":
            if len(fields) < 5:
                continue
            _sort, ref_str, text_html, ftv_html, club = fields[:5]
            try:
                book, chapter, verse = parse_anki.parse_reference(ref_str)
            except ValueError:
                continue
            text = parse_anki.clean_text(text_html)
            ftv = parse_anki.clean_text(ftv_html) if ftv_html else ""
            clubs = parse_anki.parse_clubs(club)

            ref_key = parse_anki.format_reference(book, chapter, verse)
            if not text:
                phrases = []
                stats["empty"] += 1
            else:
                cached = cache.get(ref_key)
                if cached and cached.get("text") == text and isinstance(cached.get("phrases"), list):
                    phrases = cached["phrases"]
                    stats["cached"] += 1
                else:
                    phrases = [text]
                    stats["needs_chunking"] += 1
                    stats["missing_refs"].append(ref_key)

            verses.append({
                "book": book,
                "chapter": chapter,
                "verse": verse,
                "text": text,
                "ftv": ftv,
                "clubs": clubs,
                "phrases": phrases,
            })

        elif notetype == "Heading":
            if len(fields) < 3:
                continue
            sort_field, front, back, *_ = fields
            heading_text = back.strip()
            try:
                start_ch, start_v, end_ch, end_v = parse_anki.parse_heading_id(sort_field)
            except ValueError:
                continue
            headings.append({
                "text": heading_text,
                "book": front.strip(),
                "start_chapter": start_ch,
                "start_verse": start_v,
                "end_chapter": end_ch,
                "end_verse": end_v,
            })

    return verses, headings, stats


if __name__ == "__main__":
    main()
