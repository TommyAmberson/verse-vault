"""Shared api.bible canonical-text access for the phrase / FTV / keyword
audit tools.

These tools operate on:
  - ``data/3-corinthians.json``    — the committed structural deck file
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
from typing import Dict, List, Optional

# Shared find→replace overrides for confirmed api.bible content errors
# (missing word-spaces in NKJV verses like 1 Cor 15:55 / 11:1). Applied
# on every cache read so downstream tools never see the raw defect.
# Same file the server's ``ApibibleCache.getPassageHtml`` reads, so a
# fix in one place propagates to both runtimes.
_PATCHES_PATH = os.path.normpath(
    os.path.join(
        os.path.dirname(os.path.abspath(__file__)),
        "..", "..", "packages", "api", "src", "lib", "apibible-patches.json",
    )
)


def _load_patches() -> Dict[str, Dict[str, List[Dict[str, str]]]]:
    try:
        with open(_PATCHES_PATH, encoding="utf-8") as f:
            raw = json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        return {}
    # Drop the JSON schema banner so iteration hits only bibleId entries.
    return {k: v for k, v in raw.items() if not k.startswith("$")}


_PATCHES = _load_patches()


def _apply_patches(bible_id: str, passage_id: str, html: str) -> str:
    by_passage = _PATCHES.get(bible_id, {})
    for entry in by_passage.get(passage_id, []) or []:
        find = entry.get("find")
        replace = entry.get("replace", "")
        if find:
            html = html.replace(find, replace)
    return html

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
    """Open the shared api.bible SQLite cache. Creates the tables if
    they don't exist yet (so tools work on fresh dev boxes that haven't
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
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS apibible_sections (
            bible_id TEXT NOT NULL,
            book_code TEXT NOT NULL,
            sections_json TEXT NOT NULL,
            fetched_at INTEGER NOT NULL,
            PRIMARY KEY (bible_id, book_code)
        )
        """
    )
    cutoff = int(time.time()) - CACHE_TTL_SECS
    dropped = conn.execute(
        "DELETE FROM apibible_passages WHERE fetched_at < ?", (cutoff,)
    ).rowcount
    dropped += conn.execute(
        "DELETE FROM apibible_sections WHERE fetched_at < ?", (cutoff,)
    ).rowcount
    if dropped:
        print(f"Pruned {dropped} api.bible row(s) past the 30-day TTL")
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
    falling through to api.bible on miss/stale (writing back). Known
    api.bible content quirks (see ``apibible-patches.json``) are
    applied at the read boundary so downstream tools see corrected
    text. Set ``BIBLE_API_KEY`` in the env or pass ``api_key`` for
    the fallback fetch — without it, a cache miss aborts."""
    pid = passage_id(book, chapter)
    now = int(time.time())
    row = conn.execute(
        "SELECT content_html, fetched_at FROM apibible_passages "
        "WHERE bible_id = ? AND passage_id = ?",
        (bible_id, pid),
    ).fetchone()
    if row and now - row[1] < CACHE_TTL_SECS:
        return _apply_patches(bible_id, pid, row[0])

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
    return _apply_patches(bible_id, pid, html)


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


def _strip_to_text(chunk: str) -> str:
    """Drop tags, injecting a space at the boundaries that separate
    distinct content blocks but *not* at the seams that interrupt a
    single word.

    api.bible's HTML has three relevant patterns:

    * ``Foo<span>bar</span>`` — text → opening tag. ``foo`` and the
      span content are separate words and need a space between them
      (e.g. ``“For<span class="it">as</span>`` in Isa 55:9 becomes
      ``“Foras`` with a naive strip).
    * ``<span>foo</span><span>bar</span>`` — close → open. Two
      separate content blocks; need a space between them (Acts 9:4
      serves ``</span><span>`` between ``Saul,`` and ``why``).
    * ``<span>Lord</span>'s`` — close → text. The closing tag merely
      ends a typography wrapper around a single word; ``'s`` is the
      possessive that follows the same word. No space wanted.

    The rule that fits all three: insert a space before an opening
    tag only when it's preceded by a word character (text ending mid-
    flow) or a closing tag's ``>`` (block-to-block transition). Don't
    insert when preceded by punctuation — opening quotes etc. are
    meant to sit tight against the following word
    (``"<span class="it">Let</span>`` → ``"Let``, not ``" Let``).
    Closing tags drop without a leading space (preserves
    ``<span>Lord</span>'s``). ``</p>`` always inserts a space
    (block boundary even when followed by raw text)."""
    chunk = re.sub(r"</p\s*>", " ", chunk, flags=re.IGNORECASE)
    chunk = re.sub(r"(?<=[A-Za-z0-9>])<(?!/)", " <", chunk)
    chunk = _TAG_RE.sub("", chunk)
    # api.bible occasionally inserts a literal space between curly
    # quotation marks and the italicised supplied word they hug:
    # ``“ <i>It</i>`` and ``<i>Him.</i> ”``. Standard NKJV typography
    # has no such space (``"It`` / ``Him."``). Strip them here so
    # downstream tokenisers see the canonical tight form.
    # Preserve the legitimate space between adjacent closing quotes
    # at the end of nested speech (``...inner.' "``): the lookbehind
    # skips stripping when the preceding character is itself a quote.
    chunk = re.sub(r"([“‘])\s+(?![“‘])", r"\1", chunk)
    chunk = re.sub(r"(?<![“‘”’\"'])\s+([”’])", r"\1", chunk)
    return _decode_entities(chunk)


_TOKEN_SPLIT_RE = re.compile(r"[\s—]+")


def _tokenise(text: str) -> List[str]:
    """Whitespace-or-em-dash split. NKJV uses ``—`` between words
    without surrounding spaces (e.g. ``body—whether``), and the
    structural ``phraseWordCounts`` was generated treating those as
    two tokens. Match here so audit/edit tools agree with the deck."""
    return [t for t in _TOKEN_SPLIT_RE.split(text) if t]


def extract_verse_tokens(html: str, book: str, chapter: int, verse: int) -> List[str]:
    """Pull the visible-token stream for a single verse out of the
    chapter HTML. Tokens are whitespace-separated after stripping all
    inline tags (verse markers, typography spans, paragraph wrappers).
    Punctuation glues to the adjacent token, matching the project's
    locked tokenisation rule (see ``packages/api/src/lib/render.ts``
    on the runtime side)."""
    target_sid = f"{book_code(book)} {chapter}:{verse}"
    markers = list(_VERSE_MARKER_RE.finditer(html))
    if not markers:
        return []
    for i, m in enumerate(markers):
        if m.group(1) != target_sid:
            continue
        start = m.end()
        end = markers[i + 1].start() if i + 1 < len(markers) else len(html)
        return _tokenise(_strip_to_text(html[start:end]))
    return []


def load_canonical_for_deck(
    conn: sqlite3.Connection,
    verse_keys: List[tuple],
    bible_id: str = DEFAULT_NKJV_ID,
) -> Dict[tuple, List[str]]:
    """Fetch canonical tokens for every ``(book, chapter, verse)`` in
    ``verse_keys``, caching chapter HTML across verses of the same
    chapter. Returns ``{(book, chapter, verse): [tokens]}`` — verses
    with no canonical text are simply absent from the result."""
    chapter_cache: Dict[tuple, Dict[int, List[str]]] = {}
    out: Dict[tuple, List[str]] = {}
    for book, ch, verse in verse_keys:
        ckey = (book, ch)
        if ckey not in chapter_cache:
            html = get_chapter_html(conn, book, ch, bible_id=bible_id)
            chapter_cache[ckey] = extract_chapter_verses(html, book, ch)
        tokens = chapter_cache[ckey].get(verse, [])
        if tokens:
            out[(book, ch, verse)] = tokens
    return out


def _fetch_sections(bible_id: str, book: str, api_key: str) -> List[Dict[str, str]]:
    code = book_code(book)
    url = f"{API_BASE}/bibles/{bible_id}/books/{urllib.parse.quote(code)}/sections"
    req = urllib.request.Request(
        url, headers={"api-key": api_key, "accept": "application/json"}
    )
    try:
        with urllib.request.urlopen(req, timeout=20) as resp:
            body = json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        msg = e.read().decode("utf-8", "replace")
        raise SystemExit(f"api.bible HTTP {e.code} for {code} sections: {msg[:200]}") from e
    out: List[Dict[str, str]] = []
    for s in (body.get("data", []) or []):
        out.append({
            "id": s.get("id", ""),
            "title": s.get("title", "") or "",
            "firstVerseId": s.get("firstVerseId", ""),
            "lastVerseId": s.get("lastVerseId", ""),
        })
    return out


def get_book_sections(
    conn: sqlite3.Connection,
    book: str,
    bible_id: str = DEFAULT_NKJV_ID,
    api_key: Optional[str] = None,
) -> List[Dict[str, str]]:
    """Return api.bible's section list for a book, cache-aware.

    Sections are the editorial passage headings ("Greeting", "Spiritual
    Gifts at Corinth", …). Each entry is ``{id, title, firstVerseId,
    lastVerseId}`` where the verse IDs are USX form (``JHN.1.1``).
    Mirrors ``packages/api/src/lib/apibible-cache.ts``'s ``getSections``
    so deck-building Python tools and the runtime server share the
    same on-disk cache."""
    code = book_code(book)
    now = int(time.time())
    row = conn.execute(
        "SELECT sections_json, fetched_at FROM apibible_sections "
        "WHERE bible_id = ? AND book_code = ?",
        (bible_id, code),
    ).fetchone()
    if row and now - row[1] < CACHE_TTL_SECS:
        return json.loads(row[0])

    key = api_key or os.environ.get("BIBLE_API_KEY") or os.environ.get("API_BIBLE_KEY")
    if not key:
        raise SystemExit(
            f"{code} sections not in cache and BIBLE_API_KEY not set — can't fetch"
        )
    sections = _fetch_sections(bible_id, book, key)
    conn.execute(
        "INSERT INTO apibible_sections (bible_id, book_code, sections_json, fetched_at) "
        "VALUES (?, ?, ?, ?) "
        "ON CONFLICT(bible_id, book_code) DO UPDATE SET "
        "sections_json = excluded.sections_json, fetched_at = excluded.fetched_at",
        (bible_id, code, json.dumps(sections, ensure_ascii=False), now),
    )
    conn.commit()
    return sections


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
        out[v] = _tokenise(_strip_to_text(html[start:end]))
    return out
