#!/usr/bin/env python3
"""Re-split verses in the committed structural deck file.

Operates on ``data/<N>-<book>.json`` (durable source for
``phraseWordCounts``) plus the api.bible canonical-text cache for the
verse content fed to the LLM.

Subcommands, in pipeline order:

  ``print-prompt``   — emit the splitter prompt for one or more verse refs:
                       the criteria, the verse text (with its em dashes),
                       and by default the current split and a Signals
                       block. The splitter replies with one to three
                       candidate splits per verse.

  ``rate-prompts``   — merge each verse's candidates with its current
                       split (validated, de-duplicated, given ids that
                       don't reveal which is current), write the
                       candidate sets, and emit one rating prompt per
                       candidate, batched so no batch holds two
                       candidates of the same verse.

  ``select-prompts`` — emit one prompt per verse showing every candidate
                       with its rating, for a selector to pick one;
                       ``--churn-guard`` keeps the current split unless
                       another is clearly better.

  ``apply``          — write the chosen splits (``--candidates`` +
                       ``--choices``) or, for a force-fresh pass, the
                       splitter's first candidates (``--input``) back to
                       ``phraseWordCounts``. Annotation ``wordIndex``
                       values and ``ftvWordCount`` are positions in the
                       token stream and don't shift when only the split
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
    extract_verse_features,
    format_split_prompt,
    normalize_reference,
)
from phrase_splitter.features import criterion_flags, slice_phrases  # noqa: E402
from phrase_splitter.prompts import format_rate_prompt, format_select_prompt  # noqa: E402
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


_CRITERION_NAMES = {
    1: "Cut where you'd pause",
    2: "One run per chunk",
    5: "Lists",
    6: "Parallel halves",
}


def _render_signals(signals: Dict[str, Any]) -> str:
    """Render the audit's findings for an LLM prompt: plain-language flags
    under the criterion each one tests, marked strong or weak, with no
    numbers (``criterion_flags`` owns thresholds and wording)."""
    flags = criterion_flags(signals)
    lines = ["  Hints, not verdicts: strong flags usually matter, weak ones often don't."]
    for criterion, name in _CRITERION_NAMES.items():
        found = flags.get(criterion, [])
        lines.append(f"  {criterion}. {name}: " + ("none flagged" if not found else ""))
        for strength, text in found:
            lines.append(f"     - [{strength}] {text}")
    lines.append(
        "  Not checked by signals: 3 (lead-in and speech-tag handoffs), "
        "4 (chunks that can fail on their own)."
    )
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


def _proposal_candidates(item: Dict[str, Any]) -> List[Any]:
    """Candidate phrase lists from one splitter reply entry: the
    ``candidates`` list, or the older single ``phrases`` list."""
    if isinstance(item.get("candidates"), list):
        return list(item["candidates"])
    if "phrases" in item:
        return [item["phrases"]]
    return []


def _candidate_set(
    tokens: List[str], current_pwc: List[int], proposals: List[Any]
) -> Tuple[List[Dict[str, Any]], str, List[str]]:
    """Validate proposals against the canonical tokens and merge them with
    the current split. Identical splits share one id; ids follow the
    splits' word counts, so they say nothing about which one is current.
    Returns ``(candidates, current_id, errors)``."""
    errors: List[str] = []
    distinct = {tuple(current_pwc)}
    for n, phrases in enumerate(proposals, 1):
        errs, counts = _validate(phrases, tokens)
        if errs:
            errors.append(f"candidate {n}: " + "; ".join(errs))
            continue
        distinct.add(tuple(counts))
    ordered = sorted(distinct)
    candidates = [
        {"id": chr(ord("a") + k), "counts": list(c)} for k, c in enumerate(ordered)
    ]
    current_id = candidates[ordered.index(tuple(current_pwc))]["id"]
    return candidates, current_id, errors


def _rating_batches(entries: List[Dict[str, Any]], size: int) -> List[List[Dict[str, Any]]]:
    """Group rating prompts so no batch holds two candidates of the same
    verse: a rater working through a batch then never sees a verse's
    candidates side by side."""
    by_ref: Dict[str, List[Dict[str, Any]]] = {}
    for e in entries:
        by_ref.setdefault(e["ref"], []).append(e)
    batches: List[List[Dict[str, Any]]] = []
    rank = 0
    while True:
        layer = [group[rank] for group in by_ref.values() if rank < len(group)]
        if not layer:
            return batches
        batches += [layer[i : i + size] for i in range(0, len(layer), size)]
        rank += 1


def _check_ratings(
    cset: Dict[str, Any], ratings: List[Dict[str, Any]]
) -> Tuple[Dict[str, Dict[str, Any]], List[str]]:
    """Keep well-formed ratings of known candidates; report the rest."""
    ids = {c["id"] for c in cset["candidates"]}
    good: Dict[str, Dict[str, Any]] = {}
    errors: List[str] = []
    for r in ratings:
        where = f"{cset['ref']} rating {r.get('id')!r}"
        if r.get("id") not in ids:
            errors.append(f"{where}: unknown candidate")
        elif not isinstance(r.get("score"), int) or not 1 <= r["score"] <= 10:
            errors.append(f"{where}: score must be an integer from 1 to 10")
        elif not isinstance(r.get("pros"), list) or not isinstance(r.get("cons"), list):
            errors.append(f"{where}: pros and cons must be lists")
        else:
            good[r["id"]] = r
    return good, errors


def _check_choice(
    cset: Dict[str, Any], choice: Dict[str, Any]
) -> Tuple[Optional[List[int]], Optional[str]]:
    """The chosen candidate's word counts, or an error naming the verse."""
    for c in cset["candidates"]:
        if c["id"] == choice.get("choice"):
            return c["counts"], None
    return None, f"{cset['ref']}: choice {choice.get('choice')!r} is not a candidate"


def _write_batches(outdir: str, batches: List[List[Dict[str, Any]]]) -> None:
    os.makedirs(outdir, exist_ok=True)
    for stale in os.listdir(outdir):
        if stale.startswith("batch_") and stale.endswith(".json"):
            os.remove(os.path.join(outdir, stale))
    for idx, batch in enumerate(batches):
        with open(os.path.join(outdir, f"batch_{idx:02d}.json"), "w", encoding="utf-8") as f:
            json.dump(batch, f, ensure_ascii=False, indent=2)
            f.write("\n")
    sys.stderr.write(f"wrote {len(batches)} batches → {outdir}/\n")


def _load_json(path: str) -> Any:
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def _dump_json(path: str, data: Any) -> None:
    with open(path, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2, ensure_ascii=False)
        f.write("\n")


def cmd_rate_prompts(args: argparse.Namespace) -> None:
    """Collect the splitter's candidates with each verse's current split,
    write the candidate sets, and emit one rating prompt per candidate."""
    if not (args.out or args.outdir):
        raise SystemExit("rate-prompts needs --out or --outdir")
    deck = _load_json(args.deck)
    by_ref = _verse_by_ref(deck)
    csets: List[Dict[str, Any]] = []
    entries: List[Dict[str, Any]] = []
    conn = open_cache(args.db)
    try:
        chapter_cache: Dict[tuple, Dict[str, Any]] = {}
        for item in _load_json(args.proposals):
            ref = normalize_reference(item["ref"])
            verse = by_ref.get(ref)
            if not verse:
                sys.stderr.write(f"{ref}: not in deck; skipped\n")
                continue
            tokens, text = _verse_tokens_and_text(conn, chapter_cache, verse, args.bible)
            current = verse.get("phraseWordCounts") or []
            if not tokens or sum(current) != len(tokens):
                sys.stderr.write(f"{ref}: deck split doesn't match canonical text; skipped\n")
                continue
            candidates, current_id, errors = _candidate_set(
                tokens, current, _proposal_candidates(item)
            )
            for err in errors:
                sys.stderr.write(f"{ref} {err}\n")
            if len(candidates) < 2:
                continue
            csets.append({"ref": ref, "current": current_id, "candidates": candidates})
            for c in candidates:
                entries.append({
                    "ref": ref,
                    "id": c["id"],
                    "prompt": format_rate_prompt(
                        text,
                        _render_current_split(tokens, c["counts"]),
                        _render_signals(extract_verse_features(tokens, c["counts"])),
                    ),
                })
    finally:
        conn.close()

    _dump_json(args.candidates_out, csets)
    batches = _rating_batches(entries, args.batch_size)
    if args.outdir:
        _write_batches(args.outdir, batches)
    else:
        _dump_json(args.out, [e for b in batches for e in b])
    sys.stderr.write(
        f"{len(csets)} verses with alternatives, {len(entries)} rating prompts\n"
    )


def cmd_select_prompts(args: argparse.Namespace) -> None:
    """Emit one selection prompt per verse whose candidates are all rated."""
    deck = _load_json(args.deck)
    by_ref = _verse_by_ref(deck)
    ratings_by_ref: Dict[str, List[Dict[str, Any]]] = {}
    for r in _load_json(args.ratings):
        ratings_by_ref.setdefault(normalize_reference(r["ref"]), []).append(r)
    prompts: List[Dict[str, Any]] = []
    conn = open_cache(args.db)
    try:
        chapter_cache: Dict[tuple, Dict[str, Any]] = {}
        for cset in _load_json(args.candidates):
            ref = cset["ref"]
            good, errors = _check_ratings(cset, ratings_by_ref.get(ref, []))
            for err in errors:
                sys.stderr.write(err + "\n")
            missing = [c["id"] for c in cset["candidates"] if c["id"] not in good]
            if missing:
                sys.stderr.write(f"{ref}: unrated candidates {missing}; skipped\n")
                continue
            tokens, text = _verse_tokens_and_text(conn, chapter_cache, by_ref[ref], args.bible)
            options = [
                {
                    "id": c["id"],
                    "split": _render_current_split(tokens, c["counts"]),
                    "score": good[c["id"]]["score"],
                    "pros": good[c["id"]]["pros"],
                    "cons": good[c["id"]]["cons"],
                    "current": c["id"] == cset["current"],
                }
                for c in cset["candidates"]
            ]
            prompts.append({
                "ref": ref,
                "prompt": format_select_prompt(text, options, args.churn_guard),
            })
    finally:
        conn.close()
    _dump_json(args.out, prompts)
    sys.stderr.write(f"{len(prompts)} selection prompts → {args.out}\n")


def _new_counts_from_choices(
    args: argparse.Namespace, by_ref: Dict[str, Dict[str, Any]], failures: List[Dict[str, Any]]
) -> List[Tuple[str, List[int]]]:
    """Chosen candidates that differ from the current split. Candidate
    counts were validated when the candidate sets were written."""
    out: List[Tuple[str, List[int]]] = []
    choices = {normalize_reference(c["ref"]): c for c in _load_json(args.choices)}
    for cset in _load_json(args.candidates):
        ref = cset["ref"]
        choice = choices.get(ref)
        if choice is None:
            failures.append({"ref": ref, "errors": ["no choice; left unchanged"]})
            continue
        counts, error = _check_choice(cset, choice)
        if error:
            failures.append({"ref": ref, "errors": [error]})
            continue
        if choice["choice"] != cset["current"] and ref in by_ref:
            out.append((ref, counts))
    return out


def _new_counts_from_input(
    args: argparse.Namespace, by_ref: Dict[str, Dict[str, Any]], failures: List[Dict[str, Any]]
) -> List[Tuple[str, List[int]]]:
    """Splits proposed directly (a force-fresh pass with no rating step):
    each verse's first candidate, validated against the canonical words."""
    proposed = json.load(sys.stdin) if args.input in (None, "-") else _load_json(args.input)
    if not isinstance(proposed, list):
        raise SystemExit("input must be a JSON array of {ref, phrases} or {ref, candidates}")
    out: List[Tuple[str, List[int]]] = []
    conn = open_cache(args.db)
    try:
        chapter_cache: Dict[tuple, Dict[str, Any]] = {}
        for item in proposed:
            ref = normalize_reference(item["ref"])
            verse = by_ref.get(ref)
            if not verse:
                failures.append({"ref": ref, "errors": ["not in deck"]})
                continue
            candidates = _proposal_candidates(item)
            tokens, _ = _verse_tokens_and_text(conn, chapter_cache, verse, args.bible)
            errs, counts = _validate(candidates[0] if candidates else [], tokens)
            if errs:
                failures.append({"ref": ref, "errors": errs})
                continue
            out.append((ref, counts))
    finally:
        conn.close()
    return out


def cmd_apply(args: argparse.Namespace) -> None:
    deck = _load_json(args.deck)
    by_ref = _verse_by_ref(deck)
    failures: List[Dict[str, Any]] = []
    if args.choices or args.candidates:
        if not (args.choices and args.candidates):
            raise SystemExit("--choices and --candidates go together")
        updates = _new_counts_from_choices(args, by_ref, failures)
    else:
        updates = _new_counts_from_input(args, by_ref, failures)

    applied = 0
    skipped = 0
    for ref, counts in updates:
        verse = by_ref[ref]
        if verse.get("phraseWordCounts") == counts:
            skipped += 1
            continue
        verse["phraseWordCounts"] = counts
        applied += 1

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
        _dump_json(args.deck, deck)
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

    rp = sub.add_parser(
        "rate-prompts",
        help="Collect candidate splits and emit one rating prompt per candidate",
    )
    rp.add_argument(
        "--proposals",
        required=True,
        help="Splitter replies: JSON array of {ref, candidates} (or {ref, phrases})",
    )
    rp.add_argument(
        "--candidates-out", required=True, help="Write the candidate sets to this path"
    )
    rp.add_argument("--out", help="Write all rating prompts to this path")
    rp.add_argument(
        "--outdir",
        help="Write rating prompts as batch_NN.json files, no batch holding two "
        "candidates of the same verse",
    )
    rp.add_argument("--batch-size", type=int, default=15, help="Prompts per batch (default 15)")
    rp.set_defaults(func=cmd_rate_prompts)

    sp = sub.add_parser(
        "select-prompts", help="Emit one selection prompt per verse from its rated candidates"
    )
    sp.add_argument("--candidates", required=True, help="Candidate sets from rate-prompts")
    sp.add_argument("--ratings", required=True, help="Rater replies: JSON array of ratings")
    sp.add_argument("--out", required=True, help="Write the {ref, prompt} array to this path")
    sp.add_argument(
        "--churn-guard",
        action="store_true",
        help="Tell the selector to keep the current split unless another is clearly better",
    )
    sp.set_defaults(func=cmd_select_prompts)

    ap_apply = sub.add_parser("apply", help="Validate proposed splits and write them back")
    ap_apply.add_argument(
        "--input",
        "-i",
        help="Splits to apply directly: {ref, phrases} or {ref, candidates} (first one); "
        "'-' for stdin",
    )
    ap_apply.add_argument("--candidates", help="Candidate sets from rate-prompts")
    ap_apply.add_argument(
        "--choices", help="Selector replies: JSON array of {ref, choice}; needs --candidates"
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
