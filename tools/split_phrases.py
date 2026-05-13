#!/usr/bin/env python3
"""Re-split verses in the committed structural deck file.

Operates on ``data/3-corinthians.json`` (durable source for
``phraseWordCounts``) plus the api.bible canonical-text cache for the
verse content fed to the LLM.

Two subcommands:

  ``print-prompt`` — emit the LLM prompt for one or more verse refs
                     (canonical text + the existing split, asking for
                     an improved split as a JSON array of phrases).

  ``apply``        — read proposed ``{ref, phrases}`` JSON, count the
                     words per phrase, validate that the per-verse
                     sum matches the canonical token count, then
                     rewrite the verse's ``phraseWordCounts`` in the
                     deck file. Annotation ``wordIndex`` values and
                     ``ftvWordCount`` are positions in the token
                     stream and don't shift when only the split
                     boundaries change, so they're preserved.

The split keeps the CLI free of network dependencies — the LLM call
is the skill's job — while letting the deck file remain the single
source of truth for what counts as a valid split.

Usage:
    python3 tools/split_phrases.py print-prompt \\
        --refs "1 Cor 12:11,1 Cor 1:26"

    python3 tools/split_phrases.py apply --input /tmp/proposed.json [--dry-run]

    # Pull refs from an evaluator report:
    python3 tools/split_phrases.py print-prompt \\
        --from-report /tmp/report.json --top 10
"""

import argparse
import json
import os
import sys
from typing import Any, Dict, List, Optional

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from phrase_splitter import SPLIT_PROMPT, normalize_reference  # noqa: E402
from phrase_splitter.apibible import (  # noqa: E402
    DEFAULT_DB_PATH,
    DEFAULT_NKJV_ID,
    extract_chapter_verses,
    get_chapter_html,
    open_cache,
)

WORD_MIN_HARD = 1
# No upper word-count cap in the validator: the soft target ceiling lives in
# quality-criteria.md (≈10, audit warning at >12), but recitation phrases for
# continuous clauses without a natural internal break can legitimately exceed
# that. ``apply`` enforces only structural invariants (sum matches canonical
# tokens, phrases non-empty); phrase length is a quality judgement the LLM
# split / human reviewer makes, not a hard-coded cutoff.


def _collect_refs(
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


def _verse_by_ref(deck: Dict[str, Any]) -> Dict[str, Dict[str, Any]]:
    return {
        f"{v['book']} {v['chapter']}:{v['verse']}": v
        for v in deck.get("verses", [])
    }


def cmd_print_prompt(args: argparse.Namespace) -> None:
    with open(args.deck, encoding="utf-8") as f:
        deck = json.load(f)
    refs = _collect_refs(args.refs, args.from_report, args.top)
    by_ref = _verse_by_ref(deck)

    conn = open_cache(args.db)
    try:
        prompts: List[Dict[str, Any]] = []
        chapter_cache: Dict[tuple, Dict[int, List[str]]] = {}
        for ref in refs:
            verse = by_ref.get(ref)
            if not verse:
                sys.stderr.write(f"warning: {ref!r} not in deck; skipping\n")
                continue
            key = (verse["book"], verse["chapter"])
            if key not in chapter_cache:
                html = get_chapter_html(conn, verse["book"], verse["chapter"], bible_id=args.bible)
                chapter_cache[key] = extract_chapter_verses(html, verse["book"], verse["chapter"])
            tokens = chapter_cache[key].get(verse["verse"], [])
            text = " ".join(tokens)
            prompts.append({"ref": ref, "prompt": SPLIT_PROMPT.format(verse_text=text)})
    finally:
        conn.close()

    if args.json:
        json.dump(prompts, sys.stdout, indent=2, ensure_ascii=False)
        sys.stdout.write("\n")
    else:
        divider = "\n" + "=" * 72 + "\n"
        for item in prompts:
            sys.stdout.write(f"### {item['ref']}\n\n")
            sys.stdout.write(item["prompt"])
            sys.stdout.write(divider)


def _word_count(s: str) -> int:
    return len(s.split())


def _validate(ref: str, phrases: List[str], canonical_tokens: int) -> List[str]:
    """Return a list of human-readable validation errors. Empty = OK."""
    errors: List[str] = []
    if not isinstance(phrases, list) or not phrases:
        return ["phrases is empty or not a list"]
    if any(not isinstance(p, str) or not p for p in phrases):
        errors.append("phrases contains an empty or non-string entry")
    counts: List[int] = []
    for i, p in enumerate(phrases):
        if not isinstance(p, str) or not p:
            counts.append(0)
            continue
        wc = _word_count(p)
        counts.append(wc)
        if wc < WORD_MIN_HARD:
            errors.append(f"phrase {i+1} has 0 words")
    total = sum(counts)
    if total != canonical_tokens:
        errors.append(
            f"phrase word counts sum to {total}; canonical verse has {canonical_tokens} words"
        )
    return errors


def cmd_apply(args: argparse.Namespace) -> None:
    with open(args.deck, encoding="utf-8") as f:
        deck = json.load(f)

    if args.input == "-" or args.input is None:
        proposed = json.load(sys.stdin)
    else:
        with open(args.input, encoding="utf-8") as f:
            proposed = json.load(f)
    if not isinstance(proposed, list):
        raise SystemExit("input must be a JSON array of {ref, phrases} objects")

    by_ref = _verse_by_ref(deck)
    applied = 0
    skipped = 0
    failures: List[Dict[str, Any]] = []

    conn = open_cache(args.db)
    try:
        chapter_cache: Dict[tuple, Dict[int, List[str]]] = {}
        for item in proposed:
            ref = normalize_reference(item["ref"])
            phrases = item.get("phrases")
            verse = by_ref.get(ref)
            if not verse:
                failures.append({"ref": ref, "errors": ["not in deck"]})
                continue
            key = (verse["book"], verse["chapter"])
            if key not in chapter_cache:
                html = get_chapter_html(conn, verse["book"], verse["chapter"], bible_id=args.bible)
                chapter_cache[key] = extract_chapter_verses(html, verse["book"], verse["chapter"])
            tokens = chapter_cache[key].get(verse["verse"], [])
            errs = _validate(ref, phrases, len(tokens))
            if errs:
                failures.append({"ref": ref, "errors": errs})
                continue
            new_pwc = [_word_count(p) for p in phrases]
            if verse.get("phraseWordCounts") == new_pwc:
                skipped += 1
                continue
            verse["phraseWordCounts"] = new_pwc
            applied += 1
    finally:
        conn.close()

    print(f"Applied: {applied}")
    print(f"Skipped (already current): {skipped}")
    print(f"Failed: {len(failures)}")
    for fail in failures:
        print(f"\n  {fail['ref']}")
        for e in fail["errors"]:
            print(f"    - {e}")

    if args.dry_run:
        print("\n(dry-run; deck file unchanged)")
    elif applied:
        with open(args.deck, "w", encoding="utf-8") as f:
            json.dump(deck, f, indent=2, ensure_ascii=False)
        print(f"\nUpdated {args.deck}")

    if failures and not args.allow_failures:
        sys.exit(1)


def main() -> None:
    ap = argparse.ArgumentParser(
        description=__doc__,
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    ap.add_argument("--deck", default="data/3-corinthians.json", help="Structural deck JSON")
    ap.add_argument("--db", default=DEFAULT_DB_PATH, help="Shared api.bible SQLite cache")
    ap.add_argument("--bible", default=DEFAULT_NKJV_ID, help="api.bible bibleId (default: NKJV)")

    sub = ap.add_subparsers(dest="cmd", required=True)

    pp = sub.add_parser("print-prompt", help="Emit LLM prompts for the given refs")
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
    ap_apply.add_argument(
        "--input",
        "-i",
        help="Path to a JSON file of {ref, phrases} objects (use '-' for stdin)",
    )
    ap_apply.add_argument(
        "--dry-run", action="store_true", help="Validate without writing the deck"
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
