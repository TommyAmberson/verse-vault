#!/usr/bin/env python3
"""Prepare batch input files for LLM phrase chunking.

Usage:
    python3 tools/prepare_batches.py data/corinthians-parsed.json --batch-size 50

Outputs batch-N-input.txt files and prints the agent prompt template.
After agents produce chunks-N.json files, run validate_and_merge.py.
"""

import argparse
import json
import os

AGENT_PROMPT = """Read {path} using the Read tool.
There are {count} lines, each a Bible verse that may contain HTML tags (<b>, <i>, <span>).

Split each line into memorization phrases (4-12 words). Rules:
- Break AFTER commas, semicolons, colons
- Break BEFORE conjunctions: and, but, for, that, who, which, or
- Short verses (< 8 words) stay as one phrase
- CRITICAL: Preserve ALL text exactly, including HTML tags. Do NOT modify
  any text, fix typos, or change quotes. Phrases joined with " " MUST
  exactly equal the original line.

Write ONLY valid JSON to {output} — an array of {count} arrays of strings.
Do NOT use Bash or Python. Use only Read and Write tools."""


def main():
    parser = argparse.ArgumentParser(description="Prepare batch files for LLM chunking")
    parser.add_argument("input", help="Parsed JSON (from parse_anki.py)")
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

    abs_dir = os.path.abspath(args.output_dir)

    print(f"\n{'='*60}")
    print("AGENT PROMPT TEMPLATE")
    print(f"{'='*60}")
    for batch_num in range(batch_count):
        start = batch_num * args.batch_size
        end = min(start + args.batch_size, total)
        count = end - start
        prompt = AGENT_PROMPT.format(
            path=f"{abs_dir}/batch-{batch_num + 1}-input.txt",
            count=count,
            output=f"{abs_dir}/chunks-{batch_num + 1}.json",
        )
        if batch_num == 0:
            print(f"\nBatch 1 (use as template, change numbers for other batches):\n")
            print(prompt)
            print()
    print(f"Total: {batch_count} batches. Dispatch as background Haiku agents.")
    print(f"\nAfter all complete, run:")
    print(f"  python3 tools/validate_and_merge.py {args.input} data/corinthians.json")


if __name__ == "__main__":
    main()
