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
    _tokenise,
    extract_chapter_text,
    extract_chapter_verses,
    get_chapter_html,
    open_cache,
)

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
) -> tuple[List[str], Optional[List[Dict[str, Any]]]]:
    if refs_arg:
        raw = [r.strip() for r in refs_arg.split(",") if r.strip()]
        return [normalize_reference(r) for r in raw], None
    if from_report:
        with open(from_report, encoding="utf-8") as f:
            report = json.load(f)
        refs = [entry["ref"] for entry in report]
        if top is not None:
            refs = refs[:top]
            report = report[:top]
        return refs, report
    raise SystemExit("must pass --refs or --from-report")


def _verse_by_ref(deck: Dict[str, Any]) -> Dict[str, Dict[str, Any]]:
    return {
        f"{v['book']} {v['chapter']}:{v['verse']}": v
        for v in deck.get("verses", [])
    }


def _verse_tokens_and_text(
    conn, chapter_cache: Dict[tuple, Dict[str, Any]], verse: Dict[str, Any], bible_id: str
) -> Tuple[List[str], str]:
    """Canonical tokens (the word-count convention) and display text (with
    em dashes, for the LLM) for a deck verse, caching chapter HTML."""
    key = (verse["book"], verse["chapter"])
    if key not in chapter_cache:
        html = get_chapter_html(conn, verse["book"], verse["chapter"], bible_id=bible_id)
        chapter_cache[key] = {
            "tokens": extract_chapter_verses(html, verse["book"], verse["chapter"]),
            "text": extract_chapter_text(html, verse["book"], verse["chapter"]),
        }
    cached = chapter_cache[key]
    return cached["tokens"].get(verse["verse"], []), cached["text"].get(verse["verse"], "")


def _render_current_split(tokens: List[str], pwc: List[int]) -> str:
    """One bullet per phrase, with quotes around the phrase text."""
    phrase_token_lists = slice_phrases(tokens, pwc)
    return "\n".join(f'  - "{" ".join(pt)}"' for pt in phrase_token_lists)


def _render_signals(signals: Dict[str, Any]) -> str:
    """Render the signal payload as a compact text block for the
    prompt's signals section. Names match contracts in
    ``specs/008-recitation-splits/contracts/signals.md``."""
    lines: List[str] = []
    header_bits: List[str] = []
    for key in ("token_count", "phrase_count"):
        if isinstance(signals.get(key), int):
            header_bits.append(f"{key.split('_')[0]}s={signals[key]}")
    if header_bits:
        lines.append("  " + " ".join(header_bits))

    for i, p in enumerate(signals.get("phrases") or []):
        if not isinstance(p, dict):
            continue
        bits = [f"phrase {i+1}: {p.get('word_count', 0)}w"]
        long_run = _signal_float(p, "long_run")
        if long_run > 0:
            bits.append(f"long_run={long_run:.2f}")
        points = p.get("pause_points") or []
        if points:
            words = (p.get("text") or "").split(" ")
            bits.append("pause_points=" + ",".join(
                f"{pp['kind']}@'{words[pp['index']] if pp['index'] < len(words) else '?'}'"
                for pp in points
            ))
        if p.get("lost_line_break"):
            bits.append("lost_line_break")
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
        cue = _signal_float(b, "no_pause_cue")
        if cue > 0:
            lines.append(f"  boundary {i+1}→{i+2}: no_pause_cue={cue:.2f}")

    for key in ("parallel_asymmetry", "missing_split"):
        value = _signal_float(signals, key)
        if value > 0:
            lines.append(f"  {key}={value:.2f}")
    for lb in signals.get("list_breaks") or []:
        lines.append(f"  list_breaks: {lb['kind']} in phrase {lb['phrase']}")

    lines.append(f"  composite={composite_signal_score(signals):.2f}")
    return "\n".join(lines)


def _signals_for_ref(
    ref: str,
    tokens: List[str],
    pwc: List[int],
    report_by_ref: Optional[Dict[str, Dict[str, Any]]],
) -> Optional[Dict[str, Any]]:
    """Prefer signals from a pre-computed report when available; else
    compute fresh from the canonical tokens + the deck's pwc."""
    if report_by_ref is not None:
        signals = report_by_ref.get(ref)
        if signals:
            return signals
    if not tokens or not pwc:
        return None
    return extract_verse_features(tokens, pwc)


def cmd_print_prompt(args: argparse.Namespace) -> None:
    with open(args.deck, encoding="utf-8") as f:
        deck = json.load(f)
    if args.all_verses:
        if args.refs or args.from_report or args.top is not None:
            raise SystemExit("--all-verses is exclusive with --refs / --from-report / --top")
        refs = [
            f"{v['book']} {v['chapter']}:{v['verse']}" for v in deck.get("verses", [])
        ]
        report_data = None
    else:
        refs, report_data = _collect_refs(args.refs, args.from_report, args.top)
    by_ref = _verse_by_ref(deck)

    report_by_ref: Optional[Dict[str, Dict[str, Any]]] = None
    if report_data is not None:
        report_by_ref = {
            e["ref"]: e["signals"] for e in report_data if e.get("signals")
        }

    conn = open_cache(args.db)
    try:
        prompts: List[Dict[str, Any]] = []
        chapter_cache: Dict[tuple, Dict[str, Any]] = {}
        for ref in refs:
            verse = by_ref.get(ref)
            if not verse:
                sys.stderr.write(f"warning: {ref!r} not in deck; skipping\n")
                continue
            tokens, text = _verse_tokens_and_text(conn, chapter_cache, verse, args.bible)
            pwc = verse.get("phraseWordCounts") or []

            current_split: Optional[str] = None
            if not args.no_current and tokens and pwc and sum(pwc) == len(tokens):
                current_split = _render_current_split(tokens, pwc)

            signals_block: Optional[str] = None
            if not args.no_signals:
                signals = _signals_for_ref(ref, tokens, pwc, report_by_ref)
                if signals is not None:
                    signals_block = _render_signals(signals)

            prompts.append({
                "ref": ref,
                "prompt": format_split_prompt(text, current_split, signals_block),
                "n_words": len(tokens),
                "text": text,
            })
    finally:
        conn.close()

    if args.outdir:
        if args.batch_size < 1:
            raise SystemExit("--batch-size must be a positive integer")
        os.makedirs(args.outdir, exist_ok=True)
        # Clear stale batch + index files from a prior run so a smaller
        # second pass doesn't leave orphan batches that look like results.
        for stale in os.listdir(args.outdir):
            if stale == "manifest.json" or stale == "verse_text.json" or (
                stale.startswith("batch_") and stale.endswith(".json")
            ):
                os.remove(os.path.join(args.outdir, stale))
        manifest = []
        bs = args.batch_size
        for i in range(0, len(prompts), bs):
            batch = prompts[i : i + bs]
            idx = i // bs
            path = os.path.join(args.outdir, f"batch_{idx:02d}.json")
            with open(path, "w", encoding="utf-8") as f:
                json.dump(
                    [
                        {"ref": e["ref"], "prompt": e["prompt"], "n_words": e["n_words"]}
                        for e in batch
                    ],
                    f, ensure_ascii=False, indent=2,
                )
                f.write("\n")
            manifest.append(
                {"batch": idx, "path": path, "refs": [e["ref"] for e in batch]}
            )
        with open(os.path.join(args.outdir, "manifest.json"), "w", encoding="utf-8") as f:
            json.dump(manifest, f, ensure_ascii=False, indent=2)
            f.write("\n")
        with open(os.path.join(args.outdir, "verse_text.json"), "w", encoding="utf-8") as f:
            json.dump({e["ref"]: e["text"] for e in prompts}, f, ensure_ascii=False, indent=2)
            f.write("\n")
        sys.stderr.write(f"wrote {len(manifest)} batches → {args.outdir}/\n")
        return

    if args.json:
        json.dump(
            [{"ref": e["ref"], "prompt": e["prompt"]} for e in prompts],
            sys.stdout, indent=2, ensure_ascii=False,
        )
        sys.stdout.write("\n")
    else:
        divider = "\n" + "=" * 72 + "\n"
        for item in prompts:
            sys.stdout.write(f"### {item['ref']}\n\n")
            sys.stdout.write(item["prompt"])
            sys.stdout.write(divider)


# LLM replies sometimes write ASCII quotes where the canonical text has
# curly ones; fold both sides before comparing.
_QUOTE_FOLD = str.maketrans({"‘": "'", "’": "'", "“": '"', "”": '"'})


def _validate(
    phrases: List[str], canonical_tokens: List[str]
) -> Tuple[List[str], List[int]]:
    """Check a reply against the canonical verse. Phrases are tokenised the
    same way as the deck's word counts (whitespace or em dash), so a reply
    that keeps, drops, or spaces a dash still matches. Returns
    ``(errors, phrase_word_counts)``; errors empty means OK."""
    if not isinstance(phrases, list) or not phrases:
        return ["phrases is empty or not a list"], []
    if any(not isinstance(p, str) or not _tokenise(p) for p in phrases):
        return ["phrases contains an empty or non-string entry"], []
    phrase_tokens = [_tokenise(p) for p in phrases]
    counts = [len(t) for t in phrase_tokens]
    if sum(counts) != len(canonical_tokens):
        return [
            f"phrase word counts sum to {sum(counts)}; "
            f"canonical verse has {len(canonical_tokens)} words"
        ], counts
    got = [t.translate(_QUOTE_FOLD) for toks in phrase_tokens for t in toks]
    want = [t.translate(_QUOTE_FOLD) for t in canonical_tokens]
    if got != want:
        return ["phrases don't rejoin to canonical text"], counts
    return [], counts


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
        chapter_cache: Dict[tuple, Dict[str, Any]] = {}
        for item in proposals:
            ref = normalize_reference(item["ref"])
            phrases = item.get("phrases")
            verse = by_ref.get(ref)
            if not verse:
                skipped_unknown += 1
                continue
            current_pwc = verse.get("phraseWordCounts") or []
            tokens, text = _verse_tokens_and_text(conn, chapter_cache, verse, args.bible)
            if not tokens or not current_pwc or sum(current_pwc) != len(tokens):
                skipped_invalid += 1
                continue
            errors, proposed_pwc = _validate(phrases, tokens)
            if errors:
                skipped_invalid += 1
                continue
            if current_pwc == proposed_pwc:
                skipped_match += 1
                continue
            current_split = _render_current_split(tokens, current_pwc)
            proposed_split = _render_current_split(tokens, proposed_pwc)
            current_signals = _render_signals(extract_verse_features(tokens, current_pwc))
            proposed_signals = _render_signals(extract_verse_features(tokens, proposed_pwc))
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
        chapter_cache: Dict[tuple, Dict[str, Any]] = {}
        for item in proposed:
            ref = normalize_reference(item["ref"])
            phrases = item.get("phrases")
            verse = by_ref.get(ref)
            if not verse:
                failures.append({"ref": ref, "errors": ["not in deck"]})
                continue
            tokens, _ = _verse_tokens_and_text(conn, chapter_cache, verse, args.bible)
            errs, new_pwc = _validate(phrases, tokens)
            if errs:
                failures.append({"ref": ref, "errors": errs})
                continue
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
    pp.add_argument(
        "--all-verses",
        action="store_true",
        help="Emit one prompt per verse in the deck (force-fresh pass against a "
        "side-deck whose phraseWordCounts are placeholders)",
    )
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
    pp.add_argument(
        "--outdir",
        help="Write batched prompt files to this directory: batch_NN.json + "
        "manifest.json + verse_text.json (consumed by parallel splitter subagents). "
        "Implies --json.",
    )
    pp.add_argument(
        "--batch-size",
        type=int,
        default=15,
        help="Refs per batch when --outdir is set (default 15).",
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
