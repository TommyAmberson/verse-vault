#!/usr/bin/env python3
"""Chunk verses into phrases using punctuation-based heuristics.

Usage:
    python3 tools/chunk_punctuation.py data/corinthians-test.json data/corinthians.json
"""

import json
import re
import sys


def chunk_verse(text: str) -> list[str]:
    """Split a verse into 4-12 word phrases at natural boundaries."""
    # Split on major punctuation that indicates clause boundaries
    # Keep the punctuation with the preceding chunk
    parts = re.split(r'(?<=[,;:])\s+', text)

    # Merge small parts (< 4 words) with neighbors
    phrases = []
    buffer = ""

    for part in parts:
        if buffer:
            candidate = buffer + " " + part
        else:
            candidate = part

        word_count = len(candidate.split())

        if word_count <= 12:
            buffer = candidate
        else:
            # Buffer is already big enough, flush it
            if buffer:
                phrases.append(buffer)
            buffer = part

    if buffer:
        phrases.append(buffer)

    # Second pass: merge any remaining tiny phrases (< 4 words) with neighbors
    merged = []
    for phrase in phrases:
        word_count = len(phrase.split())
        if word_count < 4 and merged:
            # Merge with previous if it won't exceed 12 words
            combined = merged[-1] + " " + phrase
            if len(combined.split()) <= 12:
                merged[-1] = combined
                continue
        merged.append(phrase)

    # Third pass: merge tiny phrases (< 3 words) with neighbors even if it exceeds 12
    final = []
    for phrase in merged:
        word_count = len(phrase.split())
        if word_count < 3 and final:
            final[-1] = final[-1] + " " + phrase
        elif word_count < 3 and not final:
            final.append(phrase)  # will merge forward below
        else:
            final.append(phrase)

    if len(final) > 1 and len(final[0].split()) < 3:
        final = [final[0] + " " + final[1]] + final[2:]

    merged = final

    # If any phrase is > 12 words, try splitting on conjunctions
    final2 = []
    for phrase in merged:
        if len(phrase.split()) > 12:
            final2.extend(split_on_conjunctions(phrase))
        else:
            final2.append(phrase)
    merged = final2

    return merged if merged else [text]


def split_on_conjunctions(text: str) -> list[str]:
    """Split long text on conjunctions as a fallback."""
    # Split before conjunctions that start a new clause
    parts = re.split(r'\s+(?=(?:and|but|for|that|who|which|when|where|if|or|nor|yet|so|then|therefore|because|although|though|unless|until|while|as|since|after|before)\s)', text, flags=re.IGNORECASE)

    if len(parts) == 1:
        # No conjunction splits found, just split by word count
        words = text.split()
        mid = len(words) // 2
        return [" ".join(words[:mid]), " ".join(words[mid:])]

    # Merge small parts
    merged = []
    buffer = ""
    for part in parts:
        if buffer:
            candidate = buffer + " " + part
        else:
            candidate = part

        if len(candidate.split()) <= 12:
            buffer = candidate
        else:
            if buffer:
                merged.append(buffer)
            buffer = part

    if buffer:
        merged.append(buffer)

    return merged if merged else [text]


def main():
    if len(sys.argv) != 3:
        print(f"Usage: {sys.argv[0]} <input.json> <output.json>")
        sys.exit(1)

    input_path = sys.argv[1]
    output_path = sys.argv[2]

    with open(input_path, "r") as f:
        data = json.load(f)

    total_phrases = 0
    for verse in data["verses"]:
        phrases = chunk_verse(verse["text"])
        verse["phrases"] = phrases
        total_phrases += len(phrases)

    with open(output_path, "w") as f:
        json.dump(data, f, indent=2, ensure_ascii=False)

    n = len(data["verses"])
    avg = total_phrases / n if n else 0
    print(f"Chunked {n} verses into {total_phrases} phrases (avg {avg:.1f} per verse)")

    # Show some examples
    for v in data["verses"][:5]:
        ref = f"{v['book']} {v['chapter']}:{v['verse']}"
        print(f"\n  {ref}:")
        for p in v["phrases"]:
            print(f"    [{len(p.split()):2d}w] {p}")


if __name__ == "__main__":
    main()
