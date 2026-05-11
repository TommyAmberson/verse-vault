"""Shared api.bible canonical-text access for the phrase / FTV / keyword
audit tools.

These tools operate on:
  - ``data/corinthians.json``    — the committed structural deck file
                                   (phraseWordCounts, annotations,
                                   ftvWordCount, headings, clubs)
  - the api.bible HTML cache     — the API server's SQLite at
                                   ``packages/api/data/verse-vault.db``,
                                   table ``apibible_passages``.

Verse text and word boundaries come from api.bible, never the deck.
The structural file's ``phraseWordCounts`` and ``annotations.wordIndex``
are positions in the api.bible token stream — same convention used by
``packages/api/src/lib/render.ts`` at render time.

This module gives the tools a thin Python-side equivalent: open the
shared SQLite, fetch chapters on demand (writing back), extract a
verse's visible-token stream, and resolve book names to USX codes.
"""

from __future__ import annotations

import json
import os
import re
import sqlite3
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from typing import List, Optional

# Match the runtime cache + the API.Bible MAUA.
CACHE_TTL_SECS = 30 * 24 * 60 * 60
DEFAULT_NKJV_ID = "63097d2a0a2f7db3-01"
DEFAULT_DB_PATH = "packages/api/data/verse-vault.db"
API_BASE = "https://rest.api.bible/v1"

# USX book codes used by api.bible's passageId. Same table as
# ``packages/api/src/lib/book-codes.ts``. Keep in sync when adding
# books; the tools rely on Python-side ``book → code`` lookups.
BOOK_CODES = {
    "Genesis": "GEN", "Exodus": "EXO", "Leviticus": "LEV", "Numbers": "NUM",
    "Deuteronomy": "DEU", "Joshua": "JOS", "Judges": "JDG", "Ruth": "RUT",
    "1 Samuel": "1SA", "2 Samuel": "2SA", "1 Kings": "1KI", "2 Kings": "2KI",
    "1 Chronicles": "1CH", "2 Chronicles": "2CH", "Ezra": "EZR", "Nehemiah": "NEH",
    "Esther": "EST", "Job": "JOB", "Psalms": "PSA", "Proverbs": "PRO",
    "Ecclesiastes": "ECC", "Song of Solomon": "SNG", "Isaiah": "ISA",
    "Jeremiah": "JER", "Lamentations": "LAM", "Ezekiel": "EZK", "Daniel": "DAN",
    "Hosea": "HOS", "Joel": "JOL", "Amos": "AMO", "Obadiah": "OBA", "Jonah": "JON",
    "Micah": "MIC", "Nahum": "NAM", "Habakkuk": "HAB", "Zephaniah": "ZEP",
    "Haggai": "HAG", "Zechariah": "ZEC", "Malachi": "MAL",
    "Matthew": "MAT", "Mark": "MRK", "Luke": "LUK", "John": "JHN", "Acts": "ACT",
    "Romans": "ROM", "1 Corinthians": "1CO", "2 Corinthians": "2CO",
    "Galatians": "GAL", "Ephesians": "EPH", "Philippians": "PHP",
    "Colossians": "COL", "1 Thessalonians": "1TH", "2 Thessalonians": "2TH",
    "1 Timothy": "1TI", "2 Timothy": "2TI", "Titus": "TIT", "Philemon": "PHM",
    "Hebrews": "HEB", "James": "JAS", "1 Peter": "1PE", "2 Peter": "2PE",
    "1 John": "1JN", "2 John": "2JN", "3 John": "3JN", "Jude": "JUD",
    "Revelation": "REV",
}


def book_code(book: str) -> str:
    code = BOOK_CODES.get(book)
    if code is None:
        raise KeyError(f"No USX code mapped for book {book!r}")
    return code


def passage_id(book: str, chapter: int) -> str:
    return f"{book_code(book)}.{chapter}"


def open_cache(db_path: str = DEFAULT_DB_PATH) -> sqlite3.Connection:
    """Open the shared api.bible SQLite cache. Creates the table if it
    doesn't exist yet (so tools work on fresh dev boxes that haven't
    run the API migrations), then prunes any entries past the 30-day
    TTL so a single load never serves stale content."""
    os.makedirs(os.path.dirname(db_path) or ".", exist_ok=True)
    conn = sqlite3.connect(db_path)
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS apibible_passages (
            bible_id TEXT NOT NULL,
            passage_id TEXT NOT NULL,
            content_html TEXT NOT NULL,
            fetched_at INTEGER NOT NULL,
            PRIMARY KEY (bible_id, passage_id)
        )
        """
    )
    cutoff = int(time.time()) - CACHE_TTL_SECS
    dropped = conn.execute(
        "DELETE FROM apibible_passages WHERE fetched_at < ?", (cutoff,)
    ).rowcount
    if dropped:
        print(f"Pruned {dropped} api.bible passage(s) past the 30-day TTL")
    conn.commit()
    return conn


def _fetch_passage_html(bible_id: str, pid: str, api_key: str) -> str:
    qs = urllib.parse.urlencode(
        {
            "content-type": "html",
            "include-notes": "false",
            "include-titles": "false",
            "include-chapter-numbers": "false",
            "include-verse-numbers": "true",
            "include-verse-spans": "false",
        }
    )
    url = f"{API_BASE}/bibles/{bible_id}/passages/{urllib.parse.quote(pid)}?{qs}"
    req = urllib.request.Request(
        url, headers={"api-key": api_key, "accept": "application/json"}
    )
    try:
        with urllib.request.urlopen(req, timeout=20) as resp:
            body = json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        msg = e.read().decode("utf-8", "replace")
        raise SystemExit(f"api.bible HTTP {e.code} for {pid}: {msg[:200]}") from e
    return body.get("data", {}).get("content", "") or ""


def get_chapter_html(
    conn: sqlite3.Connection,
    book: str,
    chapter: int,
    bible_id: str = DEFAULT_NKJV_ID,
    api_key: Optional[str] = None,
) -> str:
    """Return chapter HTML, reading from SQLite cache when fresh and
    falling through to api.bible on miss/stale (writing back). Set
    ``BIBLE_API_KEY`` in the env or pass ``api_key`` for the fallback
    fetch — without it, a cache miss aborts."""
    pid = passage_id(book, chapter)
    now = int(time.time())
    row = conn.execute(
        "SELECT content_html, fetched_at FROM apibible_passages "
        "WHERE bible_id = ? AND passage_id = ?",
        (bible_id, pid),
    ).fetchone()
    if row and now - row[1] < CACHE_TTL_SECS:
        return row[0]

    key = api_key or os.environ.get("BIBLE_API_KEY") or os.environ.get("API_BIBLE_KEY")
    if not key:
        raise SystemExit(
            f"{pid} not in cache and BIBLE_API_KEY not set — can't fetch"
        )
    html = _fetch_passage_html(bible_id, pid, key)
    conn.execute(
        "INSERT INTO apibible_passages (bible_id, passage_id, content_html, fetched_at) "
        "VALUES (?, ?, ?, ?) "
        "ON CONFLICT(bible_id, passage_id) DO UPDATE SET "
        "content_html = excluded.content_html, fetched_at = excluded.fetched_at",
        (bible_id, pid, html, now),
    )
    conn.commit()
    return html


# api.bible's verse-start marker: ``<span data-number="N" data-sid="BOOK C:V"
# class="v">N</span>``. We capture the visible verse number to delimit
# the verse boundary and to strip the marker from the extracted text.
_VERSE_MARKER_RE = re.compile(
    r'<span\b[^>]*\bdata-sid="([^"]+)"[^>]*\bclass="v"[^>]*>\d+</span>',
    re.IGNORECASE,
)
_TAG_RE = re.compile(r"<[^>]+>")
_ENTITIES = {
    "&amp;": "&", "&nbsp;": " ", "&lt;": "<", "&gt;": ">", "&quot;": '"',
    "&#39;": "'", "&apos;": "'",
}


def _decode_entities(s: str) -> str:
    for k, v in _ENTITIES.items():
        s = s.replace(k, v)
    return s


def extract_verse_tokens(html: str, book: str, chapter: int, verse: int) -> List[str]:
    """Pull the visible-token stream for a single verse out of the
    chapter HTML. Tokens are whitespace-separated after stripping all
    inline tags (verse markers, typography spans, paragraph wrappers).
    Punctuation glues to the adjacent token, matching the project's
    locked tokenisation rule (see ``packages/api/src/lib/render.ts``
    and ``tools/derive_structure.py``)."""
    target_sid = f"{book_code(book)} {chapter}:{verse}"
    markers = list(_VERSE_MARKER_RE.finditer(html))
    if not markers:
        return []
    for i, m in enumerate(markers):
        if m.group(1) != target_sid:
            continue
        start = m.end()
        end = markers[i + 1].start() if i + 1 < len(markers) else len(html)
        chunk = html[start:end]
        chunk = _TAG_RE.sub("", chunk)
        chunk = _decode_entities(chunk)
        return chunk.split()
    return []


def extract_chapter_verses(
    html: str, book: str, chapter: int
) -> dict[int, List[str]]:
    """Tokens for every verse in a chapter, keyed by verse number.
    Cheaper than calling ``extract_verse_tokens`` per verse when a
    tool needs the full chapter (e.g. the keyword auditor)."""
    out: dict[int, List[str]] = {}
    markers = list(_VERSE_MARKER_RE.finditer(html))
    for i, m in enumerate(markers):
        sid = m.group(1)
        try:
            book_part, cv = sid.split(" ", 1)
            ch_str, v_str = cv.split(":", 1)
            ch, v = int(ch_str), int(v_str)
        except ValueError:
            continue
        if book_part != book_code(book) or ch != chapter:
            continue
        start = m.end()
        end = markers[i + 1].start() if i + 1 < len(markers) else len(html)
        chunk = _TAG_RE.sub("", html[start:end])
        chunk = _decode_entities(chunk)
        out[v] = chunk.split()
    return out
