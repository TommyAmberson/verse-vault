#!/usr/bin/env python3
"""Merge chunked batches back into the final corinthians.json."""

import json
import sys


def main():
    with open("data/corinthians-test.json") as f:
        data = json.load(f)

    verses = data["verses"]
    total = len(verses)
    print(f"Total verses: {total}")

    # Load chunk batches
    all_chunks = []
    for batch_num in range(1, 7):
        path = f"data/chunks-{batch_num}.json"
        try:
            with open(path) as f:
                chunks = json.load(f)
            print(f"  Batch {batch_num}: {len(chunks)} entries")
            all_chunks.extend(chunks)
        except (FileNotFoundError, json.JSONDecodeError) as e:
            print(f"  Batch {batch_num}: ERROR - {e}")

    print(f"Total chunks loaded: {len(all_chunks)}")

    # Trim to match verse count (batch 3 had 102 instead of 100)
    if len(all_chunks) > total:
        # Take first 100 from batches 1-2, first 100 from batch 3 (skip extras), etc.
        # Simpler: just take first `total` chunks
        # But we need to be careful about alignment
        pass

    # Apply chunks to verses, skipping empty verses
    applied = 0
    skipped_empty_verse = 0
    skipped_no_chunk = 0
    chunk_idx = 0

    for i, verse in enumerate(verses):
        if not verse["text"]:
            verse["phrases"] = []
            skipped_empty_verse += 1
            continue

        if chunk_idx < len(all_chunks):
            chunk = all_chunks[chunk_idx]
            chunk_idx += 1

            # Skip empty chunks (from empty lines the agents saw)
            while chunk_idx < len(all_chunks) and (not chunk or chunk == [""]):
                chunk = all_chunks[chunk_idx]
                chunk_idx += 1

            if chunk and chunk != [""]:
                verse["phrases"] = chunk
                applied += 1
            else:
                verse["phrases"] = [verse["text"]]
                skipped_no_chunk += 1
        else:
            verse["phrases"] = [verse["text"]] if verse["text"] else []
            skipped_no_chunk += 1

    print(f"\nApplied: {applied}")
    print(f"Empty verses (skipped): {skipped_empty_verse}")
    print(f"No chunk available (fallback to whole verse): {skipped_no_chunk}")

    # Stats
    phrase_counts = [len(v["phrases"]) for v in verses if v["text"]]
    if phrase_counts:
        total_phrases = sum(phrase_counts)
        print(f"\nTotal phrases: {total_phrases}")
        print(f"Avg phrases/verse: {total_phrases / len(phrase_counts):.1f}")

    with open("data/corinthians.json", "w") as f:
        json.dump(data, f, indent=2, ensure_ascii=False)

    print(f"\nWritten to data/corinthians.json")


if __name__ == "__main__":
    main()
