#!/usr/bin/env python3
"""Audit an Anki ``.colpkg`` backup against the structural deck file
and the canonical NKJV from api.bible.

The structural deck (``data/corinthians.json``) is the runtime source
of truth for ``phraseWordCounts``, ``annotations``, ``ftvWordCount``,
and ``clubs``. The colpkg is where the user authors content. This
script surfaces drift between the two — and against canonical NKJV —
so the author knows what to fix where.

Read-only. Never writes the deck file or the colpkg.

Checks per verse:

- ``text``   — Anki verse text (markup stripped) vs api.bible canonical.
               Flags typos / textual drift (UK/US spelling differences
               and en-dash / em-dash typography are not flagged).
- ``ftv``    — Anki's FTV-field word count vs deck ``ftvWordCount``.
- ``keys``   — Anki keyword markup (``<b>``, ``<b><i>``) vs structural
               ``annotations``. Reports positions/kinds that differ.
- ``clubs``  — Anki ``club`` field vs deck ``clubs``.

Usage:
    python3 tools/audit_colpkg.py \\
        data/collection-2026-05-08.colpkg \\
        --year 3-C \\
        [--deck data/corinthians.json]
        [--checks text,ftv,keys,clubs]
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
from typing import Any, Dict, Iterable, List, Optional, Tuple

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from phrase_splitter.apibible import (  # noqa: E402
    DEFAULT_DB_PATH,
    DEFAULT_NKJV_ID,
    extract_chapter_verses,
    get_chapter_html,
    open_cache,
)

ANKI_FIELD_SEP = "\x1f"
COLLECTION_CANDIDATES = ("collection.anki21b", "collection.anki21", "collection.anki2")

# Match the structural file's reference convention.
_REF_RE = re.compile(r"^([0-9]?\s*[A-Za-z]+)\s+(\d+):(\d+)$")

# Anki markup we care about for keyword auditing.
_BOLD_ITALIC_RE = re.compile(r"<b><i>([^<]+)</i></b>", re.IGNORECASE)
_ITALIC_BOLD_RE = re.compile(r"<i><b>([^<]+)</b></i>", re.IGNORECASE)
_BOLD_RE = re.compile(r"<b>([^<]+)</b>", re.IGNORECASE)
# Any tag at all (for plain-text extraction after marker substitution).
_ANY_TAG_RE = re.compile(r"<[^>]+>")
_NBSP_RE = re.compile(r"&nbsp;")
# Curly quotes the deck sometimes uses but api.bible's plain text
# returns straight; normalise both sides before comparing.
_QUOTE_PAIRS = {"“": '"', "”": '"', "‘": "'", "’": "'"}


# --- colpkg extraction --------------------------------------------------------


def extract_collection(colpkg_path: str, dest_dir: str) -> str:
    """Pull the SQLite collection out of the .colpkg zip. Mirrors
    ``import_colpkg.py`` — keep them in sync if the Anki format
    shifts."""
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


def parse_reference(ref_str: str) -> Tuple[str, int, int]:
    m = _REF_RE.match(ref_str.strip())
    if not m:
        raise ValueError(f"invalid reference: {ref_str!r}")
    return m.group(1).strip(), int(m.group(2)), int(m.group(3))


def parse_clubs(club_str: str) -> List[int]:
    if not club_str:
        return []
    out: List[int] = []
    for piece in club_str.split(","):
        piece = piece.strip()
        if piece:
            try:
                out.append(int(piece))
            except ValueError:
                pass
    return sorted(set(out))


def query_verse_notes(
    db_path: str, year_prefix: str
) -> Iterable[Tuple[str, int, int, str, str, List[int]]]:
    """Yield ``(book, chapter, verse, raw_text, raw_ftv, clubs)`` per
    Anki ``Verse`` note in decks whose name contains ``year_prefix``.
    Text and FTV are returned with markup intact so the auditor can
    parse keyword positions and FTV word boundaries."""
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
            _sort, ref_str, text_html, ftv_html, club = fields[:5]
            try:
                book, chapter, verse = parse_reference(ref_str)
            except ValueError:
                continue
            yield book, chapter, verse, text_html, ftv_html, parse_clubs(club)
    finally:
        con.close()


# --- text helpers -------------------------------------------------------------


def _strip_anki_outer_quotes(s: str) -> str:
    if s.startswith('"') and s.endswith('"'):
        s = s[1:-1]
    return s.replace('""', '"')


def _clean_for_tokenisation(html_text: str) -> str:
    """Anki-side cleanup: remove the CSV-export double-quote escaping,
    normalise &nbsp; to a regular space, and tidy whitespace. Keeps all
    markup so callers can decide what to do with it."""
    s = _strip_anki_outer_quotes(html_text)
    s = _NBSP_RE.sub(" ", s)
    s = re.sub(r"<br\s*/?>", " ", s, flags=re.IGNORECASE)
    return s


_DASH_RE = re.compile(r"\s*(?:—|--)\s*")


def _normalise_for_diff(text: str) -> str:
    """Apples-to-apples form for comparing deck text against api.bible:
    strip every tag, decode entities, fold curly quotes to straight,
    fold em-dash / ASCII ``--`` into a single space (the deck spells the
    dash as ``--`` with surrounding spaces, the canonical uses em-dash
    without spaces — same punctuation, different glyphs), squash whitespace."""
    text = _ANY_TAG_RE.sub("", text)
    for k, v in _QUOTE_PAIRS.items():
        text = text.replace(k, v)
    text = (
        text.replace("&nbsp;", " ")
        .replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", '"')
        .replace("&#39;", "'")
        .replace("&apos;", "'")
    )
    text = _DASH_RE.sub(" ", text)
    return re.sub(r"\s+", " ", text).strip()


def extract_keyword_positions(html_text: str) -> Dict[int, str]:
    """Walk the Anki verse text and return ``{wordIndex: kind}`` for
    each token wrapped in ``<b>`` or ``<b><i>`` (and the alternate
    ``<i><b>`` ordering). Word indices are positions in the
    markup-stripped, whitespace-tokenised stream."""
    s = _clean_for_tokenisation(html_text)

    # Stamp each markup span with a placeholder marker so we can
    # identify which post-tokenise word it produced.
    annotations: Dict[str, str] = {}
    counter = [0]

    def stamp(kind: str):
        def repl(m: re.Match[str]) -> str:
            counter[0] += 1
            marker = f"\x00{counter[0]}\x00"
            annotations[marker] = kind
            return marker + m.group(1)

        return repl

    s = _BOLD_ITALIC_RE.sub(stamp("boldItalic"), s)
    s = _ITALIC_BOLD_RE.sub(stamp("boldItalic"), s)
    s = _BOLD_RE.sub(stamp("bold"), s)
    # Strip any remaining tags (small-caps span etc.) — we only care
    # about word positions; markup outside b/i isn't a keyword class.
    s = _ANY_TAG_RE.sub("", s)
    tokens = s.split()
    out: Dict[int, str] = {}
    for i, tok in enumerate(tokens):
        for marker, kind in list(annotations.items()):
            if tok.startswith(marker):
                out[i] = kind
                annotations.pop(marker, None)
                break
    return out


def ftv_word_count(ftv_html: str) -> int:
    """How many visible tokens the deck's FTV field carries."""
    return len(_normalise_for_diff(ftv_html).split())


# --- per-verse comparison -----------------------------------------------------


def compare_verse(
    book: str,
    chapter: int,
    verse: int,
    anki_text: str,
    anki_ftv: str,
    anki_clubs: List[int],
    deck_verse: Optional[Dict[str, Any]],
    canonical_tokens: List[str],
    checks: set[str],
) -> List[Dict[str, Any]]:
    diffs: List[Dict[str, Any]] = []
    ref = f"{book} {chapter}:{verse}"

    if deck_verse is None:
        return [{"ref": ref, "kind": "missing-in-deck"}]

    if "text" in checks:
        anki_plain = _normalise_for_diff(anki_text)
        # Normalise the canonical side too so the diff isn't dominated
        # by typography (curly vs straight quotes) — the actual concern
        # is wording.
        canon_plain = _normalise_for_diff(" ".join(canonical_tokens))
        if canonical_tokens and anki_plain != canon_plain:
            diffs.append({
                "ref": ref,
                "kind": "text",
                "anki": anki_plain,
                "canonical": canon_plain,
            })

    if "ftv" in checks:
        anki_n = ftv_word_count(anki_ftv) if anki_ftv else 0
        deck_n = deck_verse.get("ftvWordCount")
        if anki_n != (deck_n or 0):
            diffs.append({
                "ref": ref,
                "kind": "ftv",
                "anki_word_count": anki_n,
                "deck_word_count": deck_n,
            })

    if "keys" in checks:
        anki_keys = extract_keyword_positions(anki_text)
        deck_keys = {
            int(a["wordIndex"]): a["kind"]
            for a in (deck_verse.get("annotations") or [])
            if a.get("kind") in ("bold", "boldItalic")
        }
        if anki_keys != deck_keys:
            diffs.append({
                "ref": ref,
                "kind": "keys",
                "anki": dict(sorted(anki_keys.items())),
                "deck": dict(sorted(deck_keys.items())),
            })

    if "clubs" in checks:
        deck_clubs = sorted(deck_verse.get("clubs") or [])
        if anki_clubs != deck_clubs:
            diffs.append({
                "ref": ref,
                "kind": "clubs",
                "anki": anki_clubs,
                "deck": deck_clubs,
            })

    return diffs


# --- main ---------------------------------------------------------------------


def main() -> None:
    ap = argparse.ArgumentParser(
        description=__doc__,
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    ap.add_argument("colpkg", help="Anki .colpkg backup file")
    ap.add_argument(
        "--deck",
        default="data/corinthians.json",
        help="Structural deck JSON (default: data/corinthians.json)",
    )
    ap.add_argument(
        "--year",
        required=True,
        help="Year prefix matching the Anki deck name (e.g. '3-C')",
    )
    ap.add_argument(
        "--checks",
        default="text,ftv,keys,clubs",
        help="Comma-separated subset of: text, ftv, keys, clubs",
    )
    ap.add_argument("--db", default=DEFAULT_DB_PATH, help="api.bible SQLite cache path")
    ap.add_argument("--bible", default=DEFAULT_NKJV_ID, help="api.bible bibleId (default: NKJV)")
    ap.add_argument("--out", help="Write the full diff list as JSON to this path")
    ap.add_argument("--top", type=int, help="Print only the first N diffs per kind")
    args = ap.parse_args()

    checks = {c.strip() for c in args.checks.split(",") if c.strip()}
    unknown = checks - {"text", "ftv", "keys", "clubs"}
    if unknown:
        sys.exit(f"unknown --checks values: {sorted(unknown)}")

    with open(args.deck, encoding="utf-8") as f:
        deck = json.load(f)
    deck_by_ref = {
        (v["book"], v["chapter"], v["verse"]): v for v in deck.get("verses", [])
    }

    conn = open_cache(args.db) if "text" in checks else None
    diffs: List[Dict[str, Any]] = []
    chapter_cache: Dict[Tuple[str, int], Dict[int, List[str]]] = {}

    try:
        with tempfile.TemporaryDirectory(prefix="vv-colpkg-audit-") as tmp:
            db_path = extract_collection(args.colpkg, tmp)
            for book, chapter, verse, text_html, ftv_html, clubs in query_verse_notes(
                db_path, args.year
            ):
                canonical: List[str] = []
                if "text" in checks and conn is not None:
                    ckey = (book, chapter)
                    if ckey not in chapter_cache:
                        html = get_chapter_html(
                            conn, book, chapter, bible_id=args.bible
                        )
                        chapter_cache[ckey] = extract_chapter_verses(html, book, chapter)
                    canonical = chapter_cache[ckey].get(verse, [])
                diffs.extend(
                    compare_verse(
                        book, chapter, verse,
                        text_html, ftv_html, clubs,
                        deck_by_ref.get((book, chapter, verse)),
                        canonical, checks,
                    )
                )
    finally:
        if conn is not None:
            conn.close()

    by_kind: Dict[str, List[Dict[str, Any]]] = {}
    for d in diffs:
        by_kind.setdefault(d["kind"], []).append(d)

    print(f"Audited {len(deck_by_ref)} deck verses; {len(diffs)} diffs across {len(by_kind)} kinds.")
    for kind in ("missing-in-deck", "text", "ftv", "keys", "clubs"):
        rows = by_kind.get(kind, [])
        if not rows:
            continue
        print(f"\n=== {kind} ({len(rows)}) ===")
        shown = rows if args.top is None else rows[: args.top]
        for d in shown:
            print(f"  {d['ref']}")
            if kind == "text":
                print(f"    anki      : {d['anki'][:160]}")
                print(f"    canonical : {d['canonical'][:160]}")
            elif kind == "ftv":
                print(f"    anki word count: {d['anki_word_count']}; deck: {d['deck_word_count']}")
            elif kind == "keys":
                print(f"    anki: {d['anki']}")
                print(f"    deck: {d['deck']}")
            elif kind == "clubs":
                print(f"    anki: {d['anki']}; deck: {d['deck']}")
        if args.top is not None and len(rows) > args.top:
            print(f"  …and {len(rows) - args.top} more")

    if args.out:
        os.makedirs(os.path.dirname(args.out) or ".", exist_ok=True)
        with open(args.out, "w", encoding="utf-8") as f:
            json.dump(diffs, f, indent=2, ensure_ascii=False)
        print(f"\nWrote full report to {args.out}")

    sys.exit(1 if diffs else 0)


if __name__ == "__main__":
    main()
