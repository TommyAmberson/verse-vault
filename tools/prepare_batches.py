#!/usr/bin/env python3
"""Prepare batch input files for LLM chunking agents.

Usage:
    python3 tools/prepare_batches.py data/corinthians-test.json --batch-size 50
"""

import json
import argparse
import os


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("input", help="Parsed JSON file (from chunk_verses.py --skip-llm)")
    parser.add_argument("--batch-size", type=int, default=50)
    parser.add_argument("--output-dir", default="data")
    args = parser.parse_args()

    with open(args.input) as f:
        data = json.load(f)

    verses = [v for v in data["verses"] if v["text"]]
    total = len(verses)
    batch_count = (total + args.batch_size - 1) // args.batch_size

    print(f"Verses with text: {total}")
    print(f"Batch size: {args.batch_size}")
    print(f"Batches: {batch_count}")

    # Clean old batch files
    for f in os.listdir(args.output_dir):
        if f.startswith("batch-") and f.endswith("-input.txt"):
            os.remove(os.path.join(args.output_dir, f))
        if f.startswith("chunks-") and f.endswith(".json"):
            os.remove(os.path.join(args.output_dir, f))

    for batch_num in range(batch_count):
        start = batch_num * args.batch_size
        end = min(start + args.batch_size, total)
        batch = verses[start:end]

        path = os.path.join(args.output_dir, f"batch-{batch_num + 1}-input.txt")
        with open(path, "w") as out:
            for v in batch:
                out.write(v["text"] + "\n")

        print(f"  Batch {batch_num + 1}: {len(batch)} verses → {path}")

    # Print agent dispatch instructions
    print(f"\n{'='*60}")
    print("AGENT DISPATCH INSTRUCTIONS")
    print(f"{'='*60}")
    print(f"\nDispatch {batch_count} agents with this prompt template:\n")
    print('---')
    print(f"""Read /home/amberson/Code/verse-vault/data/batch-N-input.txt using the Read tool.
Each line is a Bible verse. There are M lines.

Split each line into natural memorization phrases. Rules:
- Each phrase should be 4-12 words
- Break AFTER commas, semicolons, colons
- Break BEFORE conjunctions: and, but, for, that, who, which, or, nor, yet, so
- If a verse is short (< 8 words), keep it as one phrase
- CRITICAL: Do NOT modify the text. No fixing typos, no changing quotes.
  The phrases joined with " " MUST exactly equal the original line.

Write the result to /home/amberson/Code/verse-vault/data/chunks-N.json
The file must contain ONLY a valid JSON array of M arrays of strings.""")
    print('---')
    print(f"\nReplace N with batch number (1-{batch_count}) and M with verse count per batch.")
    print(f"\nAfter all agents complete, run:")
    print(f"  python3 tools/validate_and_merge.py data/corinthians-test.json data/corinthians.json")


if __name__ == "__main__":
    main()
