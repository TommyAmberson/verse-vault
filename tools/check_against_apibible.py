#!/usr/bin/env python3
"""Diagnostic: diff verse text in a verse-vault JSON against the canonical
NKJV pulled from api.bible.

Useful for catching typos or accidental edits introduced when maintaining
the source Anki deck. The API.Bible endpoint returns plain text; this
script strips the deck text of its <b>/<i>/<span> markup before
comparison so the diff is over actual wording, not formatting.

API.Bible Minimum Acceptable Use (paraphrased):
  - Don't modify scripture content. Cite per the citation rules.
  - Cached content must be refreshed every 30 days.
  - Do NOT use the content to train an AI / LLM. Runtime use,
    diagnostics, and downstream display in the user's app are fine.
  - Starter plan callers must include a visible citation + link to
    https://api.bible in any UI surfacing the content.

Usage:
    export BIBLE_API_KEY=<your key>     # or API_BIBLE_KEY
    python3 tools/check_against_apibible.py \\
        data/corinthians.json \\
        --book "1 Corinthians" --chapter 1 \\
        [--bible de4e12af7f28f599-01]   # NKJV id; well-known
        [--cache data/apibible-cache.json]

The cache stores fetched passages keyed by (bibleId, passageId) with a
fetched-at timestamp. Entries older than 30 days are re-fetched per the
API terms.
"""

import argparse
import json
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

# api.bible's well-known NKJV id (English, Thomas Nelson). Override via
# --bible if needed; full list at GET /v1/bibles.
DEFAULT_NKJV_ID = "de4e12af7f28f599-01"
API_BASE = "https://api.scripture.api.bible/v1"
CACHE_TTL_SECS = 30 * 24 * 60 * 60  # 30 days per the API terms

# USX book codes used by api.bible's passageId.
BOOK_CODES = {
    "1 Corinthians": "1CO",
    "2 Corinthians": "2CO",
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
    "Romans": "ROM", "Galatians": "GAL", "Ephesians": "EPH", "Philippians": "PHP",
    "Colossians": "COL", "1 Thessalonians": "1TH", "2 Thessalonians": "2TH",
    "1 Timothy": "1TI", "2 Timothy": "2TI", "Titus": "TIT", "Philemon": "PHM",
    "Hebrews": "HEB", "James": "JAS", "1 Peter": "1PE", "2 Peter": "2PE",
    "1 John": "1JN", "2 John": "2JN", "3 John": "3JN", "Jude": "JUD",
    "Revelation": "REV",
}


def passage_id(book: str, chapter: int) -> str:
    code = BOOK_CODES.get(book)
    if code is None:
        raise SystemExit(f"No USX code mapped for book: {book!r}")
    return f"{code}.{chapter}"


def fetch_passage(bible_id: str, pid: str, api_key: str) -> dict:
    """GET a passage as plain text. Returns api.bible's data envelope."""
    qs = urllib.parse.urlencode({
        "content-type": "text",
        "include-notes": "false",
        "include-titles": "false",
        "include-chapter-numbers": "false",
        "include-verse-numbers": "true",
        "include-verse-spans": "false",
    })
    url = f"{API_BASE}/bibles/{bible_id}/passages/{urllib.parse.quote(pid)}?{qs}"
    req = urllib.request.Request(url, headers={"api-key": api_key, "accept": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=20) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", "replace")
        raise SystemExit(f"api.bible HTTP {e.code} for {pid}: {body[:200]}")


def load_cache(path: str | None) -> dict:
    if not path or not os.path.exists(path):
        return {}
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


def save_cache(path: str, cache: dict) -> None:
    os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(cache, f, indent=2, ensure_ascii=False)


def get_passage(bible_id: str, pid: str, api_key: str, cache: dict) -> str:
    """Cache-aware passage fetch. Returns the plain-text passage."""
    key = f"{bible_id}|{pid}"
    entry = cache.get(key)
    now = int(time.time())
    if entry and now - entry.get("fetched_at", 0) < CACHE_TTL_SECS:
        return entry["content"]
    data = fetch_passage(bible_id, pid, api_key)
    content = data.get("data", {}).get("content", "")
    cache[key] = {"content": content, "fetched_at": now, "passageId": pid}
    return content


# api.bible returns chapter text with verse numbers inline like
# "[1] Paul, called…  [2] To the church…". This regex pulls each (n, text).
VERSE_PREFIX = re.compile(r"\[(\d+)\]\s*")


def parse_verses_from_passage(passage: str) -> dict[int, str]:
    """Map verse number → plain-text content."""
    out: dict[int, str] = {}
    pieces = VERSE_PREFIX.split(passage)
    # split returns [prefix, n, text, n, text, …]
    for i in range(1, len(pieces), 2):
        n = int(pieces[i])
        text = pieces[i + 1].strip()
        # Squash runs of whitespace.
        text = re.sub(r"\s+", " ", text).strip()
        out[n] = text
    return out


# Strip the deck markup so we compare apples to apples.
DECK_MARKUP = re.compile(r"<[^>]+>")


def normalize_deck_text(s: str) -> str:
    s = DECK_MARKUP.sub("", s)
    s = re.sub(r"\s+", " ", s).strip()
    # api.bible's plain text uses curly quotes by default; deck text may use
    # straight quotes. Normalise both ways.
    s = s.replace("“", '"').replace("”", '"').replace("‘", "'").replace("’", "'")
    return s


def normalize_api_text(s: str) -> str:
    s = re.sub(r"\s+", " ", s).strip()
    s = s.replace("“", '"').replace("”", '"').replace("‘", "'").replace("’", "'")
    return s


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("input", help="verse-vault chunked JSON (e.g. data/corinthians.json)")
    ap.add_argument("--book", help="Limit to one book name (e.g. '1 Corinthians')")
    ap.add_argument("--chapter", type=int, help="Limit to one chapter")
    ap.add_argument("--bible", default=DEFAULT_NKJV_ID, help="api.bible bibleId (default: NKJV)")
    ap.add_argument(
        "--cache",
        default="data/apibible-cache.json",
        help="Cache file for fetched passages (refreshed every 30 days per API terms)",
    )
    args = ap.parse_args()

    api_key = os.environ.get("BIBLE_API_KEY") or os.environ.get("API_BIBLE_KEY")
    if not api_key:
        sys.exit("BIBLE_API_KEY (or API_BIBLE_KEY) not set in environment")

    with open(args.input, "r", encoding="utf-8") as f:
        data = json.load(f)

    cache = load_cache(args.cache)

    # Group verses by (book, chapter) so we fetch one passage per chapter.
    by_chapter: dict[tuple[str, int], list[dict]] = {}
    for v in data.get("verses", []):
        if args.book and v["book"] != args.book:
            continue
        if args.chapter and v["chapter"] != args.chapter:
            continue
        if not v.get("text"):
            continue
        by_chapter.setdefault((v["book"], v["chapter"]), []).append(v)

    if not by_chapter:
        print("No verses to compare (filters too strict, or input has no text).")
        return

    total = 0
    diffs: list[dict] = []
    for (book, chapter), verses in sorted(by_chapter.items()):
        pid = passage_id(book, chapter)
        passage = get_passage(args.bible, pid, api_key, cache)
        canonical = parse_verses_from_passage(passage)
        for v in verses:
            total += 1
            theirs = normalize_deck_text(v["text"])
            ours = normalize_api_text(canonical.get(v["verse"], ""))
            if not ours:
                diffs.append({"ref": f"{book} {chapter}:{v['verse']}", "kind": "missing-canonical", "deck": theirs})
                continue
            if theirs != ours:
                diffs.append({
                    "ref": f"{book} {chapter}:{v['verse']}",
                    "kind": "diff",
                    "deck": theirs,
                    "canonical": ours,
                })

    save_cache(args.cache, cache)

    print(f"Compared {total} verses; {len(diffs)} diffs found.\n")
    for d in diffs:
        print(f"--- {d['ref']} ({d['kind']})")
        print(f"  deck     : {d['deck'][:200]}")
        if "canonical" in d:
            print(f"  canonical: {d['canonical'][:200]}")
        print()

    print(
        "NKJV © Thomas Nelson. Used by permission via API.Bible "
        "(https://api.bible). Cached entries refreshed every 30 days "
        "per the Minimum Acceptable Use Agreement."
    )


if __name__ == "__main__":
    main()
