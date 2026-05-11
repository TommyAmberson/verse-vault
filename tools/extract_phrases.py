#!/usr/bin/env python3
"""Extract a phrase-cache sidecar from a chunked verse-vault JSON.

The chunking pipeline (`tools/split_phrases.py` driven by the LLM) is
slow and costs real money to re-run. To make `import_colpkg.py` cheap
when only an Anki backup changes, dump a flat phrase cache once and reuse
it forever — verses whose text matches a cache entry skip re-chunking.

Usage:
    python3 tools/extract_phrases.py data/corinthians-parsed.json data/corinthians-phrases.json

Output shape (keyed by 'Book Chapter:Verse'; `text` is the fingerprint):

    {
      "1 Corinthians 1:1": {
        "text": "Paul, called to be an apostle …",
        "phrases": ["Paul, called …", "and <b>Sosthenes</b> our brother,"]
      },
      …
    }
"""

import argparse
import json
import os

import parse_anki


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("input", help="Chunked text-bearing JSON (e.g. data/corinthians-parsed.json)")
    ap.add_argument("output", help="Phrase cache JSON to write")
    args = ap.parse_args()

    with open(args.input, "r", encoding="utf-8") as f:
        data = json.load(f)

    cache: dict[str, dict] = {}
    skipped = 0
    for v in data.get("verses", []):
        ref = parse_anki.format_reference(v["book"], v["chapter"], v["verse"])
        text = v.get("text", "")
        phrases = v.get("phrases", [])
        if not text or not isinstance(phrases, list) or not phrases:
            skipped += 1
            continue
        cache[ref] = {"text": text, "phrases": phrases}

    os.makedirs(os.path.dirname(args.output) or ".", exist_ok=True)
    with open(args.output, "w", encoding="utf-8") as f:
        json.dump(cache, f, indent=2, ensure_ascii=False)

    print(f"Wrote {len(cache)} phrase entries to {args.output}")
    if skipped:
        print(f"Skipped {skipped} verses with empty text/phrases")


if __name__ == "__main__":
    main()
