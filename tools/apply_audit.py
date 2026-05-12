#!/usr/bin/env python3
"""Apply the audit reports from ``find_keywords.py`` and
``find_ftvs.py`` to a deck file.

Reads each finding from its JSON report and rewrites the deck's
``annotations`` and ``ftvWordCount`` fields to match what the
quizzing rules say. A timestamped copy of the deck is written to
``data/backups/<deck>-<utc>.json`` before any mutation; if the
apply pass would change nothing, no backup is created.

Keyword (``annotations``) verdicts handled:

- ``under-marked`` → add an annotation at every wordIndex where
  the token matches in each ref'd verse, with the rule's expected
  kind (``bold`` for keywords / ``boldItalic`` for context-keys).
- ``over-marked``  → remove every annotation on a token that
  shouldn't be marked.
- ``wrong-kind``   → flip the annotation's ``kind`` to the rule's
  expected kind in-place.

FTV (``ftvWordCount``):

- ``too_short`` / ``longer_than_minimum`` → set the deck's
  ``ftvWordCount`` to the computed shortest unique prefix.
- Ambiguous verses (no unique prefix anywhere in the material) are
  left alone — they need human disambiguation (extending the cue
  with a verse reference or distinguishing tail words).

Word matching uses the same normalisation as ``find_keywords.py``
(``phrase_splitter.helpers.normalise_word``) so the script and
the auditor agree on what counts as the same token.

Usage:
    python3 tools/apply_audit.py \\
        --deck data/3-corinthians.json \\
        --keywords /tmp/keywords-3-corinthians.json \\
        --ftvs /tmp/ftvs-3-corinthians.json
        [--dry-run]
"""

import argparse
import json
import os
import shutil
import sys
import time
from typing import Any, Dict, List, Tuple

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from audit_colpkg import KEYWORD_KINDS  # noqa: E402
from phrase_splitter.apibible import (  # noqa: E402
    DEFAULT_DB_PATH,
    DEFAULT_NKJV_ID,
    load_canonical_for_deck,
    open_cache,
)
from phrase_splitter.helpers import normalise_word, parse_reference  # noqa: E402


def find_token_indices(tokens: List[str], target_norm: str) -> List[int]:
    """All wordIndex positions where the normalised token matches."""
    return [i for i, tok in enumerate(tokens) if normalise_word(tok) == target_norm]


def apply_keyword_findings(
    deck: Dict[str, Any],
    findings: List[Dict[str, Any]],
    canonical: Dict[Tuple[str, int, int], List[str]],
) -> Tuple[int, int, int, List[str]]:
    """Mutate ``deck['verses']`` to align annotations with the audit
    report. Returns ``(added, removed, changed, warnings)``."""
    verses_by_key = {
        (v["book"], v["chapter"], v["verse"]): v for v in deck.get("verses", [])
    }
    added = removed = changed = 0
    warnings: List[str] = []

    for f in findings:
        word = f["word"]
        expected = f["expected"]
        verdict = f["verdict"]
        for ref in f["refs"]:
            try:
                key = parse_reference(ref)
            except ValueError:
                warnings.append(f"bad ref: {ref!r}")
                continue
            verse = verses_by_key.get(key)
            if verse is None:
                warnings.append(f"verse not in deck: {ref}")
                continue
            tokens = canonical.get(key) or []
            if not tokens:
                warnings.append(f"no canonical tokens for {ref}")
                continue
            positions = set(find_token_indices(tokens, word))
            if not positions:
                warnings.append(f"token {word!r} not found in {ref}")
                continue

            anno_list = list(verse.get("annotations") or [])

            if verdict == "under-marked":
                anno_by_index = {a["wordIndex"]: a for a in anno_list}
                for idx in sorted(positions):
                    a = anno_by_index.get(idx)
                    if a is None:
                        anno_list.append({"wordIndex": idx, "kind": expected})
                        added += 1
                    elif a["kind"] != expected:
                        # Pre-existing weaker annotation at the same slot — upgrade.
                        a["kind"] = expected
                        changed += 1
            elif verdict == "over-marked":
                kept: List[Dict[str, Any]] = []
                for a in anno_list:
                    if a["wordIndex"] in positions and a.get("kind") in KEYWORD_KINDS:
                        removed += 1
                        continue
                    kept.append(a)
                anno_list = kept
            elif verdict == "wrong-kind":
                for a in anno_list:
                    if a["wordIndex"] in positions and a.get("kind") in KEYWORD_KINDS:
                        if a["kind"] != expected:
                            a["kind"] = expected
                            changed += 1
            else:
                warnings.append(f"unknown verdict: {verdict!r}")
                continue

            anno_list.sort(key=lambda a: a["wordIndex"])
            verse["annotations"] = anno_list

    return added, removed, changed, warnings


def apply_ftv_findings(
    deck: Dict[str, Any],
    rows: List[Dict[str, Any]],
) -> Tuple[int, int, List[str]]:
    """Set ``ftvWordCount`` to the shortest computed unique prefix per
    verse. Skips ambiguous rows (no unique prefix exists). Returns
    ``(updated, skipped_ambiguous, warnings)``."""
    verses_by_key = {
        (v["book"], v["chapter"], v["verse"]): v for v in deck.get("verses", [])
    }
    updated = 0
    skipped = 0
    warnings: List[str] = []
    for r in rows:
        n = r.get("shortest_unique_prefix_words")
        if n is None:
            skipped += 1
            continue
        ref = r.get("ref")
        try:
            key = parse_reference(ref)
        except (ValueError, TypeError):
            warnings.append(f"bad ref: {ref!r}")
            continue
        verse = verses_by_key.get(key)
        if verse is None:
            warnings.append(f"verse not in deck: {ref}")
            continue
        current = verse.get("ftvWordCount") or 0
        if current == n:
            continue
        verse["ftvWordCount"] = n
        updated += 1
    return updated, skipped, warnings


def make_backup(deck_path: str) -> str:
    backup_dir = os.path.join(os.path.dirname(deck_path) or ".", "backups")
    os.makedirs(backup_dir, exist_ok=True)
    stem, ext = os.path.splitext(os.path.basename(deck_path))
    stamp = time.strftime("%Y%m%dT%H%M%SZ", time.gmtime())
    out = os.path.join(backup_dir, f"{stem}-{stamp}{ext}")
    shutil.copy2(deck_path, out)
    return out


def main() -> None:
    ap = argparse.ArgumentParser(
        description=__doc__,
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    ap.add_argument("--deck", required=True, help="Structural deck JSON to mutate")
    ap.add_argument("--keywords", help="find_keywords.py --out JSON path")
    ap.add_argument("--ftvs", help="find_ftvs.py --out JSON path")
    ap.add_argument("--dry-run", action="store_true",
                    help="Compute changes without writing the deck or backup")
    ap.add_argument("--db", default=DEFAULT_DB_PATH, help="api.bible SQLite cache path")
    ap.add_argument("--bible", default=DEFAULT_NKJV_ID, help="api.bible bibleId (default: NKJV)")
    args = ap.parse_args()

    if not args.keywords and not args.ftvs:
        sys.exit("nothing to apply: pass --keywords and/or --ftvs")

    with open(args.deck, encoding="utf-8") as f:
        deck = json.load(f)

    keyword_findings: List[Dict[str, Any]] = []
    if args.keywords:
        with open(args.keywords, encoding="utf-8") as f:
            keyword_findings = json.load(f)

    ftv_rows: List[Dict[str, Any]] = []
    if args.ftvs:
        with open(args.ftvs, encoding="utf-8") as f:
            ftv_rows = json.load(f)

    conn = open_cache(args.db)
    try:
        if keyword_findings:
            verse_keys = [(v["book"], v["chapter"], v["verse"]) for v in deck.get("verses", [])]
            canonical = load_canonical_for_deck(conn, verse_keys, bible_id=args.bible)
        else:
            canonical = {}
    finally:
        conn.close()

    added = removed = changed = 0
    kw_warnings: List[str] = []
    if keyword_findings:
        added, removed, changed, kw_warnings = apply_keyword_findings(
            deck, keyword_findings, canonical
        )

    ftv_updated = 0
    ftv_skipped = 0
    ftv_warnings: List[str] = []
    if ftv_rows:
        ftv_updated, ftv_skipped, ftv_warnings = apply_ftv_findings(deck, ftv_rows)

    total_changes = added + removed + changed + ftv_updated
    print(f"Deck: {args.deck}")
    print(f"  annotations added   : {added}")
    print(f"  annotations removed : {removed}")
    print(f"  annotations changed : {changed}")
    print(f"  ftvWordCount updated: {ftv_updated}")
    print(f"  ftv ambiguous skipped: {ftv_skipped}")
    if kw_warnings:
        print(f"  keyword warnings ({len(kw_warnings)}):")
        for w in kw_warnings[:10]:
            print(f"    {w}")
    if ftv_warnings:
        print(f"  ftv warnings ({len(ftv_warnings)}):")
        for w in ftv_warnings[:10]:
            print(f"    {w}")

    if total_changes == 0:
        print("\n(no changes — backup not written)")
        return

    if args.dry_run:
        print(f"\n(dry-run; {total_changes} change(s) computed but not written)")
        return

    backup_path = make_backup(args.deck)
    print(f"\nWrote backup: {backup_path}")
    with open(args.deck, "w", encoding="utf-8") as f:
        json.dump(deck, f, indent=2, ensure_ascii=False)
    print(f"Updated: {args.deck}")


if __name__ == "__main__":
    main()
