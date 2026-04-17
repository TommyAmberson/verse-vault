#!/usr/bin/env python3
"""Validate chunked batches and merge into final JSON.

Usage:
    python3 tools/validate_and_merge.py data/corinthians-test.json data/corinthians.json
"""

import json
import os
import sys
import difflib


def main():
    if len(sys.argv) != 3:
        print(f"Usage: {sys.argv[0]} <input.json> <output.json>")
        sys.exit(1)

    input_path = sys.argv[1]
    output_path = sys.argv[2]

    with open(input_path) as f:
        data = json.load(f)

    verses_with_text = [v for v in data["verses"] if v["text"]]
    total = len(verses_with_text)

    # Load all chunk batches
    batch_dir = os.path.dirname(input_path) or "."
    all_chunks = []
    batch_num = 1
    while True:
        path = os.path.join(batch_dir, f"chunks-{batch_num}.json")
        if not os.path.exists(path):
            break
        with open(path) as f:
            chunks = json.load(f)
        print(f"  Batch {batch_num}: {len(chunks)} entries")
        all_chunks.extend(chunks)
        batch_num += 1

    print(f"Total chunks: {len(all_chunks)}")
    print(f"Verses with text: {total}")

    if len(all_chunks) < total:
        print(f"WARNING: only {len(all_chunks)} chunks for {total} verses")

    # Validate and merge
    clean = 0
    typo_flagged = 0
    fallback = 0
    typo_report = []

    for i, verse in enumerate(verses_with_text):
        if i >= len(all_chunks):
            verse["phrases"] = [verse["text"]]
            fallback += 1
            continue

        chunk = all_chunks[i]
        if not chunk or chunk == [""] or chunk == []:
            verse["phrases"] = [verse["text"]]
            fallback += 1
            continue

        rejoined = " ".join(chunk)
        original = verse["text"]

        if rejoined == original:
            verse["phrases"] = chunk
            clean += 1
        else:
            # Check if it's a typo correction vs other mangling
            diff = list(difflib.unified_diff(
                original.split(), rejoined.split(),
                lineterm="", n=0
            ))
            diff_text = "\n".join(diff[2:]) if len(diff) > 2 else ""

            # Simple heuristic: if only 1-2 words changed, likely typo correction
            changed_words = sum(1 for line in diff if line.startswith("+") or line.startswith("-")) // 2
            ref = f"{verse['book']} {verse['chapter']}:{verse['verse']}"

            if changed_words <= 2 and changed_words > 0:
                typo_report.append({
                    "ref": ref,
                    "original": original,
                    "corrected": rejoined,
                    "diff": diff_text,
                })
                # Use the LLM's version (likely correct) but flag it
                verse["phrases"] = chunk
                typo_flagged += 1
            else:
                # Too many changes — fall back to original as single phrase
                verse["phrases"] = [original]
                fallback += 1
                if fallback <= 5:
                    print(f"\n  FALLBACK {ref}:")
                    print(f"    Original: {original[:80]}")
                    print(f"    Rejoined: {rejoined[:80]}")

    # Apply to empty verses too
    for verse in data["verses"]:
        if not verse["text"]:
            verse["phrases"] = []

    # Write output
    with open(output_path, "w") as f:
        json.dump(data, f, indent=2, ensure_ascii=False)

    print(f"\n{'='*60}")
    print(f"Results:")
    print(f"  Clean:        {clean}/{total}")
    print(f"  Typo flagged: {typo_flagged}/{total}")
    print(f"  Fallback:     {fallback}/{total}")
    print(f"{'='*60}")

    if typo_report:
        print(f"\nPotential typos in source text:")
        for t in typo_report:
            print(f"\n  {t['ref']}:")
            print(f"    Your text:  {t['original'][:90]}")
            print(f"    Suggested:  {t['corrected'][:90]}")

    total_phrases = sum(len(v["phrases"]) for v in data["verses"] if v["text"])
    print(f"\nFinal: {total} verses, {total_phrases} phrases")
    print(f"Written to {output_path}")


if __name__ == "__main__":
    main()
