#!/usr/bin/env python3
"""Re-split verses in the phrases cache.

Workflow:

  1. ``print-prompt`` emits the LLM prompt for one or more verse refs.
     Pipe the result into the LLM of your choice (or let the Claude
     skill consume it directly).
  2. The LLM produces a JSON array of phrases per verse.
  3. ``apply`` reads those proposed splits from a JSON file (or stdin),
     validates them against the deterministic checks (rejoin, word-count
     bounds, HTML balance), and writes the survivors back into the
     cache. Failures are reported but never silently committed.

This split keeps the CLI free of network dependencies — the LLM call is
the skill's job — while letting the cache file remain the single source
of truth for what counts as a "valid" split.

Usage:
    python3 tools/split_phrases.py print-prompt data/corinthians-phrases.json \\
        --refs "1 Cor 12:11,1 Cor 1:26"

    python3 tools/split_phrases.py apply data/corinthians-phrases.json \\
        --input /tmp/proposed.json [--dry-run]

    # Pull refs from an evaluator report:
    python3 tools/split_phrases.py print-prompt data/corinthians-phrases.json \\
        --from-report /tmp/report.json --top 10
"""

import argparse
import json
import os
import sys
from typing import Any, Dict, List, Optional, Set

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from phrase_splitter import (  # noqa: E402
    SPLIT_PROMPT,
    html_tags_balanced,
    normalize_reference,
    rejoin_matches,
    word_count,
)

WORD_MIN_HARD = 1  # Splits with empty phrases fail; 1-word edges pass apply.
WORD_MAX_HARD = 12


def _collect_refs(
    cache: Dict[str, Any],
    refs_arg: Optional[str],
    from_report: Optional[str],
    top: Optional[int],
) -> List[str]:
    if refs_arg:
        raw = [r.strip() for r in refs_arg.split(",") if r.strip()]
        return [normalize_reference(r) for r in raw]
    if from_report:
        with open(from_report, encoding="utf-8") as f:
            report = json.load(f)
        refs = [entry["ref"] for entry in report]
        if top is not None:
            refs = refs[:top]
        return refs
    raise SystemExit("must pass --refs or --from-report")


def cmd_print_prompt(args: argparse.Namespace) -> None:
    with open(args.cache, encoding="utf-8") as f:
        cache = json.load(f)
    refs = _collect_refs(cache, args.refs, args.from_report, args.top)

    out = []
    for ref in refs:
        entry = cache.get(ref)
        if not entry:
            sys.stderr.write(f"warning: {ref!r} not in cache; skipping\n")
            continue
        out.append({"ref": ref, "prompt": SPLIT_PROMPT.format(verse_text=entry["text"])})

    if args.json:
        json.dump(out, sys.stdout, indent=2, ensure_ascii=False)
        sys.stdout.write("\n")
    else:
        # Human-readable: prompts separated by a divider plus the ref label.
        divider = "\n" + "=" * 72 + "\n"
        for item in out:
            sys.stdout.write(f"### {item['ref']}\n\n")
            sys.stdout.write(item["prompt"])
            sys.stdout.write(divider)


def _validate(ref: str, text: str, phrases: List[str]) -> List[str]:
    """Return a list of human-readable validation errors. Empty = OK."""
    errors: List[str] = []
    if not isinstance(phrases, list) or not phrases:
        errors.append("phrases is empty or not a list")
        return errors
    if any(not isinstance(p, str) or not p for p in phrases):
        errors.append("phrases contains an empty or non-string entry")
    if not rejoin_matches(phrases, text):
        errors.append(f"rejoin mismatch: got {' '.join(phrases)!r}, want {text!r}")
    for i, p in enumerate(phrases):
        if not isinstance(p, str) or not p:
            continue
        wc = word_count(p)
        if wc < WORD_MIN_HARD:
            errors.append(f"phrase {i+1} is empty after word count")
        elif wc > WORD_MAX_HARD:
            errors.append(f"phrase {i+1} has {wc} words (max {WORD_MAX_HARD})")
        if not html_tags_balanced(p):
            errors.append(f"phrase {i+1} has unbalanced HTML tags")
    return errors


def cmd_apply(args: argparse.Namespace) -> None:
    with open(args.cache, encoding="utf-8") as f:
        cache = json.load(f)

    if args.input == "-" or args.input is None:
        proposed = json.load(sys.stdin)
    else:
        with open(args.input, encoding="utf-8") as f:
            proposed = json.load(f)

    if not isinstance(proposed, list):
        raise SystemExit("input must be a JSON array of {ref, phrases} objects")

    applied = 0
    skipped = 0
    failures: List[Dict[str, Any]] = []
    for item in proposed:
        ref = normalize_reference(item["ref"])
        phrases = item.get("phrases")
        entry = cache.get(ref)
        if not entry:
            failures.append({"ref": ref, "errors": ["not in cache"]})
            continue
        errs = _validate(ref, entry["text"], phrases)
        if errs:
            failures.append({"ref": ref, "errors": errs})
            skipped += 1
            continue
        if entry.get("phrases") == phrases:
            skipped += 1
            continue
        entry["phrases"] = phrases
        applied += 1

    print(f"Applied: {applied}")
    print(f"Skipped (already current): {skipped - len(failures)}")
    print(f"Failed: {len(failures)}")
    for fail in failures:
        print(f"\n  {fail['ref']}")
        for e in fail["errors"]:
            print(f"    - {e}")

    if args.dry_run:
        print("\n(dry-run; cache file unchanged)")
    elif applied:
        with open(args.cache, "w", encoding="utf-8") as f:
            json.dump(cache, f, indent=2, ensure_ascii=False)
        print(f"\nUpdated {args.cache}")

    if failures and not args.allow_failures:
        sys.exit(1)


def main() -> None:
    ap = argparse.ArgumentParser(
        description=__doc__,
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    sub = ap.add_subparsers(dest="cmd", required=True)

    pp = sub.add_parser("print-prompt", help="Emit LLM prompts for the given refs")
    pp.add_argument("cache", help="Phrases cache JSON")
    pp.add_argument("--refs", help="Comma-separated refs")
    pp.add_argument("--from-report", help="Read refs from an evaluator report JSON")
    pp.add_argument("--top", type=int, help="With --from-report, only the top N refs")
    pp.add_argument(
        "--json",
        action="store_true",
        help="Emit a JSON array of {ref, prompt} instead of human-readable text",
    )
    pp.set_defaults(func=cmd_print_prompt)

    ap_apply = sub.add_parser("apply", help="Validate proposed splits and write them back")
    ap_apply.add_argument("cache", help="Phrases cache JSON")
    ap_apply.add_argument(
        "--input",
        "-i",
        help="Path to a JSON file of {ref, phrases} objects (use '-' for stdin)",
    )
    ap_apply.add_argument(
        "--dry-run", action="store_true", help="Validate without writing the cache"
    )
    ap_apply.add_argument(
        "--allow-failures",
        action="store_true",
        help="Exit 0 even if some refs failed validation",
    )
    ap_apply.set_defaults(func=cmd_apply)

    args = ap.parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
