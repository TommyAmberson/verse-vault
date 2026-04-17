#!/usr/bin/env python3
"""Validate chunked batches and merge into final JSON.

Usage:
    python3 tools/validate_and_merge.py data/corinthians-test.json data/corinthians.json
"""

import json
import os
import sys
import difflib


def _try_fix_json_quotes(raw: str) -> str:
    """Try to fix unescaped quotes inside JSON strings.

    LLM agents sometimes write "text with "quotes" inside" instead of
    "text with \\"quotes\\" inside". This attempts to fix that by escaping
    quotes that appear inside string values.
    """
    import re
    # Find strings between [ ] and escape inner quotes
    # Strategy: replace " that are NOT at string boundaries with \"
    lines = raw.split("\n")
    fixed_lines = []
    for line in lines:
        stripped = line.strip()
        # Lines that are just structural JSON (brackets, commas) — skip
        if stripped in ("", "[", "]", "],", "[],"):
            fixed_lines.append(line)
            continue
        # Lines that are string values: start with " and end with " or ",
        if stripped.startswith('"') and (stripped.endswith('"') or stripped.endswith('",') or stripped.endswith('",')):
            # Find the content between the outer quotes
            trailing = ""
            if stripped.endswith('",'):
                trailing = ","
                inner = stripped[1:-2]
            elif stripped.endswith('"'):
                inner = stripped[1:-1]
            else:
                fixed_lines.append(line)
                continue
            # Escape any unescaped quotes in the inner content
            inner = inner.replace('\\"', '\x00')  # protect already-escaped
            inner = inner.replace('"', '\\"')       # escape unescaped
            inner = inner.replace('\x00', '\\"')    # restore
            indent = line[:len(line) - len(line.lstrip())]
            fixed_lines.append(f'{indent}"{inner}"{trailing}')
        else:
            fixed_lines.append(line)
    return "\n".join(fixed_lines)


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
            raw = f.read()
        try:
            chunks = json.loads(raw)
        except json.JSONDecodeError:
            # Try to fix common agent JSON errors: unescaped quotes inside strings
            fixed = _try_fix_json_quotes(raw)
            try:
                chunks = json.loads(fixed)
                print(f"  Batch {batch_num}: {len(chunks)} entries (fixed JSON quote escaping)")
            except json.JSONDecodeError as e:
                print(f"  Batch {batch_num}: INVALID JSON even after fix attempt: {e}")
                batch_num += 1
                continue
        else:
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
