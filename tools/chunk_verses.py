#!/usr/bin/env python3
"""Parse Anki export and chunk verses into phrases using Claude Haiku.

Usage:
    uv run --with anthropic tools/chunk_verses.py data/anki-export.txt data/corinthians.json --year 3-C

Requires ANTHROPIC_API_KEY environment variable.
"""

import argparse
import html
import json
import os
import re
import sys
import time

STRIP_HTML_RE = re.compile(r"<[^>]+>")
NBSP_RE = re.compile(r"&nbsp;")
QUOTE_RE = re.compile(r"&[a-z]+;")


def strip_html(text: str) -> str:
    text = NBSP_RE.sub(" ", text)
    text = STRIP_HTML_RE.sub("", text)
    text = html.unescape(text)
    text = clean_anki_quotes(text)
    text = re.sub(r"\s+", " ", text).strip()
    return text


def clean_anki_quotes(text: str) -> str:
    """Remove Anki CSV quote escaping."""
    # Remove outer wrapping quotes from Anki CSV export
    if text.startswith('"') and text.endswith('"'):
        text = text[1:-1]
    # Convert doubled quotes to single (Anki's CSV escaping for inner quotes)
    text = text.replace('""', '"')
    return text


def parse_reference(ref_str: str) -> tuple[str, int, int]:
    """Parse '1 Corinthians 1:3' → ('1 Corinthians', 1, 3)"""
    match = re.match(r"(.+?)\s+(\d+):(\d+)", ref_str.strip())
    if not match:
        raise ValueError(f"Cannot parse reference: {ref_str}")
    return match.group(1), int(match.group(2)), int(match.group(3))


def parse_heading_id(id_str: str) -> tuple[int, int, int, int]:
    """Parse '3-01-001-001,001-004,' → (1, 1, 1, 4) = (start_ch, start_v, end_ch, end_v)"""
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
    """Parse the Anki export file, filtering to a specific year."""
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
                plain_text = strip_html(text_html)
                ftv_plain = strip_html(ftv) if ftv else ""

                clubs = []
                if "150" in club:
                    clubs.append(150)
                if "300" in club:
                    clubs.append(300)

                verses.append({
                    "book": book,
                    "chapter": chapter,
                    "verse": verse,
                    "text": plain_text,
                    "text_html": text_html,
                    "ftv": ftv_plain,
                    "clubs": clubs,
                    "phrases": [],  # filled by LLM
                })

            elif note_type == "Heading":
                heading_text = text_html.strip()
                try:
                    start_ch, start_v, end_ch, end_v = parse_heading_id(note_id)
                    # reference field has the book name
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

    # Sort verses by book, chapter, verse
    verses.sort(key=lambda v: (v["book"], v["chapter"], v["verse"]))

    return verses, headings


def chunk_verses_with_llm(verses: list[dict], batch_size: int = 30) -> list[dict]:
    """Use Claude Haiku to split each verse into natural phrases."""
    try:
        import anthropic
    except ImportError:
        print("Error: anthropic SDK not installed. Run: uv run --with anthropic tools/chunk_verses.py ...")
        sys.exit(1)

    client = anthropic.Anthropic()
    total = len(verses)
    chunked = 0

    for i in range(0, total, batch_size):
        batch = verses[i : i + batch_size]
        verse_texts = []
        for v in batch:
            verse_texts.append(f'{v["book"]} {v["chapter"]}:{v["verse"]}: {v["text"]}')

        prompt = """Split each Bible verse into natural phrases for memorization.
Each phrase should be 4-12 words and break at natural clause boundaries (commas, semicolons, conjunctions).
Keep punctuation with each phrase. Do not modify the text.

Return a JSON array of arrays. Each inner array contains the phrases for that verse, in order.

Verses:
"""
        prompt += "\n".join(f"{j+1}. {t}" for j, t in enumerate(verse_texts))

        try:
            response = client.messages.create(
                model="claude-haiku-4-5-20251001",
                max_tokens=4096,
                messages=[{"role": "user", "content": prompt}],
            )
            result_text = response.content[0].text

            # Extract JSON from response
            json_match = re.search(r"\[[\s\S]*\]", result_text)
            if json_match:
                phrase_arrays = json.loads(json_match.group())
                for j, phrases in enumerate(phrase_arrays):
                    if j < len(batch):
                        batch[j]["phrases"] = phrases
                        chunked += 1
            else:
                print(f"  Warning: no JSON found in response for batch {i // batch_size + 1}")
                for v in batch:
                    v["phrases"] = [v["text"]]
                chunked += len(batch)

        except Exception as e:
            print(f"  Error in batch {i // batch_size + 1}: {e}")
            for v in batch:
                v["phrases"] = [v["text"]]
            chunked += len(batch)

        print(f"  Chunked {min(chunked, total)}/{total} verses...")
        time.sleep(0.5)

    return verses


def build_chapters(verses: list[dict]) -> list[dict]:
    """Derive chapter list from verses."""
    chapters = {}
    for v in verses:
        key = (v["book"], v["chapter"])
        if key not in chapters:
            chapters[key] = {"book": v["book"], "number": v["chapter"], "start_verse": v["verse"], "end_verse": v["verse"]}
        else:
            chapters[key]["start_verse"] = min(chapters[key]["start_verse"], v["verse"])
            chapters[key]["end_verse"] = max(chapters[key]["end_verse"], v["verse"])

    result = list(chapters.values())
    result.sort(key=lambda c: (c["book"], c["number"]))
    return result


def main():
    parser = argparse.ArgumentParser(description="Parse Anki export and chunk verses")
    parser.add_argument("input", help="Path to Anki export file")
    parser.add_argument("output", help="Path to output JSON file")
    parser.add_argument("--year", required=True, help="Year prefix to filter (e.g., '3-C')")
    parser.add_argument("--skip-llm", action="store_true", help="Skip LLM chunking (use whole verse as single phrase)")
    args = parser.parse_args()

    print(f"Parsing {args.input} for year {args.year}...")
    verses, headings = parse_anki_export(args.input, args.year)
    print(f"Found {len(verses)} verses, {len(headings)} headings")

    books = sorted(set(v["book"] for v in verses))
    print(f"Books: {', '.join(books)}")

    if not args.skip_llm:
        print("\nChunking verses with Claude Haiku...")
        verses = chunk_verses_with_llm(verses)
    else:
        print("Skipping LLM chunking (using whole verse as single phrase)")
        for v in verses:
            v["phrases"] = [v["text"]]

    chapters = build_chapters(verses)

    # Determine year number from prefix
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

    print(f"\nWritten to {args.output}")
    print(f"  {len(verses)} verses")
    print(f"  {len(chapters)} chapters")
    print(f"  {len(headings)} headings")
    print(f"  {sum(len(v['phrases']) for v in verses)} total phrases")


if __name__ == "__main__":
    main()
