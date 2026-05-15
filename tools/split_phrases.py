#!/usr/bin/env python3
"""Re-split verses in the committed structural deck file.

Operates on ``data/<N>-<book>.json`` (durable source for
``phraseWordCounts``) plus the api.bible canonical-text cache for the
verse content fed to the LLM.

Two subcommands:

  ``print-prompt`` — emit the LLM prompt for one or more verse refs.
                     The prompt includes the canonical text plus, by
                     default, the verse's current split (with the
                     stability clause) and a Signals block of
                     deterministic features. Use ``--no-current`` to
                     propose from scratch; use ``--no-signals`` for
                     wording iterations.

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
    python3 tools/split_phrases.py --deck data/4-john.json print-prompt \\
        --refs "John 1:14"

    python3 tools/split_phrases.py --deck data/4-john.json print-prompt \\
        --refs "John 1:14" --no-current --no-signals

    python3 tools/split_phrases.py --deck data/4-john.json apply \\
        --input /tmp/proposed.json --dry-run

    # Pull refs from an evaluator report (signals reused from report):
    python3 tools/split_phrases.py --deck data/4-john.json print-prompt \\
        --from-report /tmp/report.json --top 10
"""

import argparse
import json
import os
import sys
from typing import Any, Dict, List, Optional

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from phrase_splitter import (  # noqa: E402
    composite_signal_score,
    extract_verse_features,
    format_split_prompt,
    normalize_reference,
)
from phrase_splitter.features import _signal_float, slice_phrases  # noqa: E402
from phrase_splitter.prompts import format_judge_prompt  # noqa: E402
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


def _render_current_split(tokens: List[str], pwc: List[int]) -> str:
    """One bullet per phrase, with quotes around the phrase text."""
    phrase_token_lists = slice_phrases(tokens, pwc)
    return "\n".join(f'  - "{" ".join(pt)}"' for pt in phrase_token_lists)


def _render_signals(signals: Dict[str, Any]) -> str:
    """Render the signal payload as a compact text block for the
    prompt's signals section."""
    lines: List[str] = []
    tc = signals.get("token_count")
    pc = signals.get("phrase_count")
    header_bits: List[str] = []
    if isinstance(tc, int):
        header_bits.append(f"tokens={tc}")
    if isinstance(pc, int):
        header_bits.append(f"phrases={pc}")
    # length_balance and verse_function_ratio stay in the report payload
    # but are not rendered here — the splitter has tended to over-balance
    # phrase lengths when shown the raw balance number.
    if header_bits:
        lines.append("  " + " ".join(header_bits))

    for i, p in enumerate(signals.get("phrases") or []):
        if not isinstance(p, dict):
            continue
        wc = p.get("word_count", 0)
        cw = p.get("content_word_count", 0)
        bits = [f"phrase {i+1}: {wc}w ({cw} content)"]
        stub = _signal_float(p, "stub_phrase")
        if stub > 0:
            bits.append(f"stub={stub:.2f}")
        ov = _signal_float(p, "cognitive_overload")
        if ov > 0:
            bits.append(f"overload={ov:.2f}")
        if p.get("ends_mid_clause"):
            bits.append("ends-mid-clause")
        if p.get("starts_with_weak_connector"):
            bits.append("opens-with-connector")
        lines.append("  " + " ".join(bits))

    for i, b in enumerate(signals.get("boundaries") or []):
        sev = _signal_float(b, "boundary_severance")
        if sev > 0:
            kind = (b.get("severance_kind") if isinstance(b, dict) else None) or "?"
            lines.append(f"  boundary {i+1}→{i+2}: {kind} severance={sev:.2f}")

    missing = _signal_float(signals, "missing_split")
    if missing > 0:
        lines.append(f"  missing_split={missing:.2f}")

    lines.append(f"  composite={composite_signal_score(signals):.2f}")
    return "\n".join(lines)


def _signals_for_ref(
    ref: str,
    tokens: List[str],
    pwc: List[int],
    from_report: Optional[List[Dict[str, Any]]],
) -> Optional[Dict[str, Any]]:
    """Prefer signals from a pre-computed report when available; else
    compute fresh from the canonical tokens + the deck's pwc."""
    if from_report is not None:
        for entry in from_report:
            if entry.get("ref") == ref and entry.get("signals"):
                return entry["signals"]
    if not tokens or not pwc:
        return None
    return extract_verse_features(tokens, pwc)


def cmd_print_prompt(args: argparse.Namespace) -> None:
    with open(args.deck, encoding="utf-8") as f:
        deck = json.load(f)
    refs = _collect_refs(args.refs, args.from_report, args.top)
    by_ref = _verse_by_ref(deck)

    report_data: Optional[List[Dict[str, Any]]] = None
    if args.from_report:
        with open(args.from_report, encoding="utf-8") as f:
            report_data = json.load(f)

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
            pwc = verse.get("phraseWordCounts") or []

            current_split: Optional[str] = None
            if not args.no_current and tokens and pwc and sum(pwc) == len(tokens):
                current_split = _render_current_split(tokens, pwc)

            signals_block: Optional[str] = None
            if not args.no_signals:
                signals = _signals_for_ref(ref, tokens, pwc, report_data)
                if signals is not None:
                    signals_block = _render_signals(signals)

            prompts.append({
                "ref": ref,
                "prompt": format_split_prompt(text, current_split, signals_block),
            })
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


def _render_split_from_tokens(tokens: List[str], pwc: List[int]) -> str:
    """One bullet per phrase, identical to ``_render_current_split`` —
    kept as a separate name so the judge-pairs code reads clearly when
    it renders option B (the proposed split, not "current")."""
    return _render_current_split(tokens, pwc)


def cmd_judge_pairs(args: argparse.Namespace) -> None:
    """Emit one JUDGE_PROMPT per verse whose proposed split differs
    from the deck's current split. Signal blocks for both sides come
    from the auditor's features module, freshly recomputed against
    each pwc — there's no signal carryover from earlier reports."""
    with open(args.deck, encoding="utf-8") as f:
        deck = json.load(f)
    with open(args.proposals, encoding="utf-8") as f:
        proposals = json.load(f)
    if not isinstance(proposals, list):
        raise SystemExit("proposals must be a JSON array of {ref, phrases}")

    by_ref = _verse_by_ref(deck)
    prompts: List[Dict[str, Any]] = []
    skipped_match = 0
    skipped_unknown = 0
    skipped_invalid = 0

    conn = open_cache(args.db)
    try:
        chapter_cache: Dict[tuple, Dict[int, List[str]]] = {}
        for item in proposals:
            ref = normalize_reference(item["ref"])
            phrases = item.get("phrases")
            verse = by_ref.get(ref)
            if not verse:
                skipped_unknown += 1
                continue
            current_pwc = verse.get("phraseWordCounts") or []
            proposed_pwc = [_word_count(p) for p in phrases] if isinstance(phrases, list) else []
            key = (verse["book"], verse["chapter"])
            if key not in chapter_cache:
                html = get_chapter_html(conn, verse["book"], verse["chapter"], bible_id=args.bible)
                chapter_cache[key] = extract_chapter_verses(html, verse["book"], verse["chapter"])
            tokens = chapter_cache[key].get(verse["verse"], [])
            if not tokens or not current_pwc or sum(current_pwc) != len(tokens):
                skipped_invalid += 1
                continue
            if sum(proposed_pwc) != len(tokens):
                skipped_invalid += 1
                continue
            if current_pwc == proposed_pwc:
                skipped_match += 1
                continue
            current_split = _render_current_split(tokens, current_pwc)
            proposed_split = _render_split_from_tokens(tokens, proposed_pwc)
            current_signals = _render_signals(extract_verse_features(tokens, current_pwc))
            proposed_signals = _render_signals(extract_verse_features(tokens, proposed_pwc))
            text = " ".join(tokens)
            prompts.append({
                "ref": ref,
                "prompt": format_judge_prompt(
                    verse_text=text,
                    option_a_split=current_split,
                    signals_a=current_signals,
                    option_b_split=proposed_split,
                    signals_b=proposed_signals,
                ),
            })
    finally:
        conn.close()

    if args.out:
        with open(args.out, "w", encoding="utf-8") as f:
            json.dump(prompts, f, indent=2, ensure_ascii=False)
            f.write("\n")
        sys.stderr.write(
            f"Wrote {len(prompts)} judge prompts to {args.out}"
            f" (skipped: {skipped_match} match, {skipped_unknown} unknown, "
            f"{skipped_invalid} invalid)\n"
        )
    else:
        divider = "\n" + "=" * 72 + "\n"
        for item in prompts:
            sys.stdout.write(f"### {item['ref']}\n\n")
            sys.stdout.write(item["prompt"])
            sys.stdout.write(divider)
        sys.stderr.write(
            f"\n{len(prompts)} judge prompts emitted "
            f"(skipped: {skipped_match} match, {skipped_unknown} unknown, "
            f"{skipped_invalid} invalid)\n"
        )


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

    # When verdicts are supplied, drop every proposal whose verdict is
    # "A" (keep current). Refs absent from the verdicts file pass
    # through unchanged — letting the caller mix unjudged proposals
    # (e.g. force-fresh) with judged ones in one apply.
    judge_filtered = 0
    if args.verdicts:
        with open(args.verdicts, encoding="utf-8") as f:
            verdicts = json.load(f)
        verdict_by_ref = {
            normalize_reference(v["ref"]): str(v.get("verdict", "")).strip().upper()
            for v in verdicts
        }
        kept: List[Dict[str, Any]] = []
        for item in proposed:
            r = normalize_reference(item["ref"])
            verdict = verdict_by_ref.get(r)
            if verdict == "A":
                judge_filtered += 1
                continue
            kept.append(item)
        proposed = kept

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
    if args.verdicts:
        print(f"Skipped (judge picked A): {judge_filtered}")
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
    pp.add_argument(
        "--no-current",
        action="store_true",
        help="Omit the Current split section (ask the splitter to propose from scratch)",
    )
    pp.add_argument(
        "--no-signals",
        action="store_true",
        help="Omit the Signals block (use when iterating on prompt wording)",
    )
    pp.set_defaults(func=cmd_print_prompt)

    jp = sub.add_parser(
        "judge-pairs",
        help="Emit one JUDGE_PROMPT per ref where the proposal differs from the deck",
    )
    jp.add_argument(
        "--proposals",
        required=True,
        help="Path to a JSON file of {ref, phrases} objects (the splitter's output)",
    )
    jp.add_argument(
        "--out",
        help="Write the {ref, prompt} array to this path (default: stdout text form)",
    )
    jp.set_defaults(func=cmd_judge_pairs)

    ap_apply = sub.add_parser("apply", help="Validate proposed splits and write them back")
    ap_apply.add_argument(
        "--input",
        "-i",
        help="Path to a JSON file of {ref, phrases} objects (use '-' for stdin)",
    )
    ap_apply.add_argument(
        "--verdicts",
        help="Path to a JSON file of {ref, verdict} objects from the judge step. "
        "Refs with verdict=A are dropped before applying.",
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
