#!/usr/bin/env python3
"""Parse an Anki text export into the verse-vault intermediate JSON format.

Usage:
    python3 tools/parse_anki.py data/anki-export.txt data/corinthians-parsed.json --year 3-C

The output JSON has phrases set to [whole verse] as placeholder. Use
prepare_batches.py + LLM agents + validate_and_merge.py to chunk them.
"""

import argparse
import html
import json
import os
import re

SMALL_CAPS_SPAN = re.compile(
    r'<span\s+style="[^"]*small-caps[^"]*">',
    re.IGNORECASE,
)
CANONICAL_SMALL_CAPS = '<span style="font-variant: small-caps;">'
KEEP_TAGS = re.compile(
    r'(</?b>|</?i>|</span>)',
    re.IGNORECASE,
)
STRIP_HTML_RE = re.compile(r"<[^>]+>")
NBSP_RE = re.compile(r"&nbsp;")


def clean_text(text: str) -> str:
    """Clean Anki HTML into text with formatting preserved.

    Keeps: <b>, <i>, <span style="font-variant: small-caps;">
    Removes: &nbsp;, <br>, all other tags
    Cleans: Anki CSV quote escaping ("" → ")
    Normalizes: multi-word <b>/<i> spans → per-word tags
    """
    text = _clean_anki_quotes(text)
    text = NBSP_RE.sub(" ", text)
    text = re.sub(r"<br\s*/?>", " ", text, flags=re.IGNORECASE)
    text = _strip_unwanted_tags(text)
    text = html.unescape(text)
    text = _normalize_tag_spans(text, "b")
    text = _normalize_tag_spans(text, "i")
    text = re.sub(r"<(b|i)>\s+", r" <\1>", text)
    text = re.sub(r"\s+</(b|i)>", r"</\1> ", text)
    text = re.sub(r"\s+", " ", text).strip()
    return text


def _clean_anki_quotes(text: str) -> str:
    if text.startswith('"') and text.endswith('"'):
        text = text[1:-1]
    text = text.replace('""', '"')
    return text


def _strip_unwanted_tags(text: str) -> str:
    # Normalize any small-caps span (however verbose) to canonical form
    text = SMALL_CAPS_SPAN.sub(CANONICAL_SMALL_CAPS, text)

    placeholders = []

    def save_tag(m):
        placeholders.append(m.group(0))
        return f"\x00{len(placeholders) - 1}\x00"

    # Now keep canonical small-caps spans too
    text = re.sub(
        re.escape(CANONICAL_SMALL_CAPS),
        lambda m: save_tag(m),
        text,
    )
    text = KEEP_TAGS.sub(save_tag, text)
    text = STRIP_HTML_RE.sub("", text)
    for i, tag in enumerate(placeholders):
        text = text.replace(f"\x00{i}\x00", tag)
    return text


def _normalize_tag_spans(text: str, tag: str) -> str:
    pattern = re.compile(rf"<{tag}>(.*?)</{tag}>", re.DOTALL)

    def split_span(m):
        content = m.group(1).strip()
        words = content.split()
        if len(words) <= 1:
            return f"<{tag}>{content}</{tag}>"
        return " ".join(f"<{tag}>{w}</{tag}>" for w in words)

    return pattern.sub(split_span, text)


def strip_tags(text: str) -> str:
    return re.sub(r"<[^>]+>", "", text)


def parse_reference(ref_str: str) -> tuple[str, int, int]:
    match = re.match(r"(.+?)\s+(\d+):(\d+)", ref_str.strip())
    if not match:
        raise ValueError(f"Cannot parse reference: {ref_str}")
    return match.group(1), int(match.group(2)), int(match.group(3))


def parse_heading_id(id_str: str) -> tuple[int, int, int, int]:
    parts = id_str.strip().rstrip(",").split(",")
    if len(parts) != 2:
        raise ValueError(f"Cannot parse heading ID: {id_str}")
    start_match = re.match(r"\d+-\d+-(\d+)-(\d+)", parts[0].strip())
    end_match = re.match(r"(\d+)-(\d+)", parts[1].strip())
    if not start_match or not end_match:
        raise ValueError(f"Cannot parse heading ID parts: {id_str}")
    return (
        int(start_match.group(1)),
        int(start_match.group(2)),
        int(end_match.group(1)),
        int(end_match.group(2)),
    )


def parse_anki_export(filepath: str, year_prefix: str):
    verses = []
    headings = []

    with open(filepath, "r", encoding="utf-8") as f:
        for line in f:
            if line.startswith("#"):
                continue
            parts = line.strip().split("\t")
            if len(parts) < 7:
                continue

            note_type = parts[0]
            deck = parts[1]
            note_id = parts[2]
            reference = parts[3]
            text_html = parts[4] if len(parts) > 4 else ""
            ftv = parts[5] if len(parts) > 5 else ""
            club = parts[6] if len(parts) > 6 else ""

            if year_prefix not in deck:
                continue

            if note_type == "Verse":
                book, chapter, verse = parse_reference(reference)
                cleaned = clean_text(text_html)
                ftv_clean = clean_text(ftv) if ftv else ""

                clubs = []
                if "150" in club:
                    clubs.append(150)
                if "300" in club:
                    clubs.append(300)

                verses.append({
                    "book": book,
                    "chapter": chapter,
                    "verse": verse,
                    "text": cleaned,
                    "ftv": ftv_clean,
                    "clubs": clubs,
                    "phrases": [cleaned] if cleaned else [],
                })

            elif note_type == "Heading":
                heading_text = text_html.strip()
                try:
                    start_ch, start_v, end_ch, end_v = parse_heading_id(note_id)
                    book = reference.strip()
                    headings.append({
                        "text": heading_text,
                        "book": book,
                        "start_chapter": start_ch,
                        "start_verse": start_v,
                        "end_chapter": end_ch,
                        "end_verse": end_v,
                    })
                except ValueError:
                    pass

    verses.sort(key=lambda v: (v["book"], v["chapter"], v["verse"]))
    return verses, headings


def build_chapters(verses: list[dict]) -> list[dict]:
    chapters = {}
    for v in verses:
        key = (v["book"], v["chapter"])
        if key not in chapters:
            chapters[key] = {"book": v["book"], "number": v["chapter"],
                             "start_verse": v["verse"], "end_verse": v["verse"]}
        else:
            chapters[key]["start_verse"] = min(chapters[key]["start_verse"], v["verse"])
            chapters[key]["end_verse"] = max(chapters[key]["end_verse"], v["verse"])
    result = list(chapters.values())
    result.sort(key=lambda c: (c["book"], c["number"]))
    return result


def main():
    parser = argparse.ArgumentParser(description="Parse Anki export into verse-vault JSON")
    parser.add_argument("input", help="Path to Anki export file")
    parser.add_argument("output", help="Path to output JSON file")
    parser.add_argument("--year", required=True, help="Year prefix (e.g., '3-C')")
    args = parser.parse_args()

    print(f"Parsing {args.input} for year {args.year}...")
    verses, headings = parse_anki_export(args.input, args.year)
    print(f"Found {len(verses)} verses, {len(headings)} headings")

    books = sorted(set(v["book"] for v in verses))
    print(f"Books: {', '.join(books)}")

    chapters = build_chapters(verses)
    year_num = int(args.year.split("-")[0]) if "-" in args.year else 0

    output = {
        "year": year_num,
        "books": books,
        "chapters": chapters,
        "verses": verses,
        "headings": headings,
    }

    os.makedirs(os.path.dirname(args.output) or ".", exist_ok=True)
    with open(args.output, "w", encoding="utf-8") as f:
        json.dump(output, f, indent=2, ensure_ascii=False)

    verses_with_text = [v for v in verses if v["text"]]
    print(f"\nWritten to {args.output}")
    print(f"  {len(verses_with_text)} verses with text ({len(verses) - len(verses_with_text)} empty)")
    print(f"  {len(chapters)} chapters")
    print(f"  {len(headings)} headings")


if __name__ == "__main__":
    main()
