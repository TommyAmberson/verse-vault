#!/usr/bin/env python3
"""Audit phrase splits in a committed structural deck file.

Reads the deck's ``phraseWordCounts`` against the canonical api.bible
NKJV tokens, then emits one record per verse with two layers:

* **Blockers** — structural failures (missing/wrong-shape word counts,
  sum drift, missing canonical tokens, unbalanced HTML inside a phrase).
  A non-empty blockers list means the deck and the canonical text
  disagree; a human must fix the deck before any re-split is meaningful.

* **Signals + composite score** — deterministic features of the current
  split measured against recitation runs (``long_run`` with its
  ``pause_points``, ``no_pause_cue``, ``boundary_severance``,
  ``lost_line_break``, ``parallel_asymmetry``, ``list_breaks``, …). These
  don't say a split is wrong; they surface what's worth a look. The
  composite ``signal_score`` is a weighted sum in ``[0, 1]`` and drives
  ``--top`` / ``--min-score``.

Usage:
    python3 tools/evaluate_phrases.py
    python3 tools/evaluate_phrases.py data/4-john.json --top 20
    python3 tools/evaluate_phrases.py data/4-john.json --min-score 0.3
    python3 tools/evaluate_phrases.py data/4-john.json --refs "John 1:14"
    python3 tools/evaluate_phrases.py data/4-john.json --all --out report.json
    python3 tools/evaluate_phrases.py --calibrate --show-text
"""

import argparse
import json
import os
import sys
from typing import Any, Dict, List, Optional, Sequence, Set, Tuple

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from phrase_splitter import (  # noqa: E402
    composite_signal_score,
    extract_verse_features,
    normalize_reference,
)
from phrase_splitter.helpers import html_tags_balanced  # noqa: E402
from phrase_splitter.features import (  # noqa: E402
    COMPOSITE_COMPONENTS,
    LIST_BREAK_WEIGHTS,
    component_value,
    slice_phrases,
)
from phrase_splitter.apibible import (  # noqa: E402
    DEFAULT_DB_PATH,
    DEFAULT_NKJV_ID,
    extract_chapter_verses,
    get_chapter_html,
    open_cache,
)

# Default cutoff for emitting a verse based on its composite signal
# score. Tuned so a single boundary signal (≈ 0.35) lands above the line
# while pure length-balance / weak-connector signals only emit if they
# accumulate. Override with --min-score.
DEFAULT_MIN_SCORE = 0.2

# Maintainer-reviewed splits, stored as word counts so no verse text is
# committed. ``--calibrate`` scores the audit against them.
REFERENCE_SET_PATH = os.path.join(
    os.path.dirname(os.path.abspath(__file__)), "phrase_splitter", "reference_set.json"
)


def check_verse(verse: Dict[str, Any], tokens: List[str]) -> Dict[str, Any]:
    """Return ``{blockers, signal_score, signals}`` for one verse.

    ``blockers`` is a list of human-readable strings. Non-empty means
    the deck disagrees with the canonical text and the rest of the
    record is meaningless. ``signals`` is the full feature payload
    from ``extract_verse_features`` (or ``None`` when a blocker
    short-circuits the computation).
    """
    blockers: List[str] = []
    pwc = verse.get("phraseWordCounts") or []

    if not isinstance(pwc, list) or not pwc:
        return {
            "blockers": ["missing or empty phraseWordCounts"],
            "signal_score": 0.0,
            "signals": None,
        }

    api_count = len(tokens)
    if api_count == 0:
        return {
            "blockers": ["no canonical tokens — verse missing from api.bible cache"],
            "signal_score": 0.0,
            "signals": None,
        }

    pwc_sum = sum(pwc)
    if pwc_sum != api_count:
        blockers.append(
            f"phraseWordCounts sum ({pwc_sum}) differs from api.bible "
            f"token count ({api_count}) — deck/canonical drift"
        )

    # HTML balance: each phrase must keep its inline tags closed within
    # the phrase. A phrase that opens <b> but never closes it (or vice
    # versa) is the canary for a split that fell inside a tag.
    if pwc_sum == api_count:
        phrase_token_lists = slice_phrases(tokens, pwc)
        for i, ptoks in enumerate(phrase_token_lists):
            if not html_tags_balanced(" ".join(ptoks)):
                blockers.append(
                    f"phrase {i + 1} has unbalanced HTML tags — split fell inside a tag"
                )

    if blockers:
        return {"blockers": blockers, "signal_score": 0.0, "signals": None}

    signals = extract_verse_features(tokens, pwc)
    score = composite_signal_score(signals)

    ftv = verse.get("ftvWordCount")
    if ftv is not None and (not isinstance(ftv, int) or ftv < 1 or ftv > api_count):
        # ftv out-of-range is a deck/canonical disagreement → blocker.
        return {
            "blockers": [f"ftvWordCount={ftv} out of [1, {api_count}]"],
            "signal_score": 0.0,
            "signals": None,
        }

    return {"blockers": [], "signal_score": round(score, 3), "signals": signals}


def _describe(signals: Dict[str, Any], container: str, key: str) -> str:
    """Name where a signal fired: the strongest phrase or boundary, with
    the detail a reader needs to find it."""
    if container == "verse":
        if key == "missing_split":
            return f"single phrase, {signals.get('token_count', 0)} tokens"
        return key
    items = signals.get(container) or []
    best = max(range(len(items)), key=lambda i: float(items[i].get(key) or 0))
    item = items[best]
    if container == "boundaries":
        kind = item.get("severance_kind") if key == "boundary_severance" else None
        return f"boundary {best + 1}→{best + 2}: {kind or key}"
    detail = f"{item.get('word_count')}w"
    kinds = sorted({p["kind"] for p in item.get("pause_points") or []})
    if kinds:
        detail += ", pauses: " + "/".join(kinds)
    return f"phrase {best + 1}: {key} ({detail})"


def _top_signals(signals: Dict[str, Any], k: int = 3) -> List[str]:
    """The k signals contributing most to the composite score, as
    human-readable bullets. ``--out`` callers get the full payload."""
    if not isinstance(signals, dict):
        return []
    bullets: List[Tuple[float, str]] = []
    for container, key, weight in COMPOSITE_COMPONENTS:
        value = component_value(signals, container, key)
        if value > 0.0:
            bullets.append((value * weight, f"{_describe(signals, container, key)} ({value:.2f})"))
    for lb in signals.get("list_breaks") or []:
        bullets.append((LIST_BREAK_WEIGHTS.get(lb["kind"], 0.0), f"phrase {lb['phrase']}: {lb['kind']}"))
    bullets.sort(key=lambda b: -b[0])
    return [msg for _, msg in bullets[:k]]


def evaluate(
    deck: Dict[str, Any],
    conn,
    bible_id: str,
    ref_filter: Optional[Set[str]] = None,
    tokens_out: Optional[Dict[str, List[str]]] = None,
) -> List[Dict[str, Any]]:
    """Walk the structural deck verse-by-verse, fetching each chapter's
    canonical tokens once and reusing them across the chapter's verses.
    Returns one record per verse that was checked (filtering happens in
    main, not here). When ``tokens_out`` is given, each checked verse's
    canonical tokens are stored in it by ref."""
    report: List[Dict[str, Any]] = []
    chapter_tokens: Dict[tuple, Dict[int, List[str]]] = {}
    for v in deck.get("verses", []):
        ref = f"{v['book']} {v['chapter']}:{v['verse']}"
        if ref_filter is not None and ref not in ref_filter:
            continue
        key = (v["book"], v["chapter"])
        if key not in chapter_tokens:
            html = get_chapter_html(conn, v["book"], v["chapter"], bible_id=bible_id)
            chapter_tokens[key] = extract_chapter_verses(html, v["book"], v["chapter"])
        tokens = chapter_tokens[key].get(v["verse"], [])
        if tokens_out is not None:
            tokens_out[ref] = tokens
        record = check_verse(v, tokens)
        record["ref"] = ref
        report.append(record)
    return report


def validate_reference_set(
    entries: List[Dict[str, Any]], token_counts: Dict[str, int]
) -> List[str]:
    """Return one error per broken reference entry. ``token_counts`` maps
    each ref to its canonical token count; a ref missing from it is an
    error too, since the entry can't be checked."""
    errors: List[str] = []
    seen: Set[str] = set()
    for e in entries:
        ref = e.get("ref", "?")
        if ref in seen:
            errors.append(f"{ref}: duplicate entry")
            continue
        seen.add(ref)
        total = token_counts.get(ref)
        if total is None:
            errors.append(f"{ref}: no canonical tokens")
            continue
        problems = []
        agreed = e.get("agreed") or []
        if sum(agreed) != total:
            problems.append(f"agreed sums to {sum(agreed)}, canonical has {total}")
        for r in e.get("rejected") or []:
            counts = r.get("counts") or []
            if sum(counts) != total:
                problems.append(f"rejected {counts} sums to {sum(counts)}, canonical has {total}")
            if counts == agreed:
                problems.append(f"rejected {counts} equals agreed")
        if problems:
            errors.append(f"{ref}: " + "; ".join(problems))
    return errors


def calibration_results(
    entries: List[Dict[str, Any]],
    deck_counts: Dict[str, List[int]],
    records: Dict[str, Dict[str, Any]],
    min_score: float,
) -> List[Dict[str, Any]]:
    """Score the audit against each scored reference entry. A ``changed``
    entry (agreed split differs from the deck) should be flagged; a
    ``kept`` one should stay under ``min_score``. ``unresolved`` entries
    are left out."""
    results: List[Dict[str, Any]] = []
    for e in entries:
        if e.get("confidence") == "unresolved":
            continue
        ref = e["ref"]
        record = records[ref]
        state = "kept" if deck_counts[ref] == e["agreed"] else "changed"
        flagged = record["signal_score"] >= min_score
        results.append({
            "ref": ref,
            "confidence": e.get("confidence"),
            "state": state,
            "score": record["signal_score"],
            "flagged": flagged,
            "ok": flagged if state == "changed" else not flagged,
            "fired": _top_signals(record.get("signals") or {}, k=10),
        })
    return results


def _split_text(tokens: List[str], pwc: List[int]) -> str:
    return " / ".join(" ".join(p) for p in slice_phrases(tokens, pwc))


def run_calibration(db_path: str, bible_id: str, min_score: float) -> Dict[str, Any]:
    """Audit every reference verse. Returns the entries, the validation
    errors, per-verse results, and what ``--show-text`` needs."""
    with open(REFERENCE_SET_PATH, encoding="utf-8") as f:
        entries = json.load(f)

    by_deck: Dict[str, List[Dict[str, Any]]] = {}
    for e in entries:
        by_deck.setdefault(e["deck"], []).append(e)

    records: Dict[str, Dict[str, Any]] = {}
    deck_counts: Dict[str, List[int]] = {}
    tokens_by_ref: Dict[str, List[str]] = {}
    conn = open_cache(db_path)
    try:
        for deck_path, deck_entries in by_deck.items():
            with open(deck_path, encoding="utf-8") as f:
                deck = json.load(f)
            refs = {e["ref"] for e in deck_entries}
            for v in deck.get("verses", []):
                ref = f"{v['book']} {v['chapter']}:{v['verse']}"
                if ref in refs:
                    deck_counts[ref] = v.get("phraseWordCounts") or []
            for record in evaluate(deck, conn, bible_id, refs, tokens_by_ref):
                records[record["ref"]] = record
    finally:
        conn.close()

    token_counts = {ref: len(toks) for ref, toks in tokens_by_ref.items() if toks}
    errors = validate_reference_set(entries, token_counts)
    errors += [f"{ref}: {'; '.join(r['blockers'])}" for ref, r in records.items() if r["blockers"]]
    results = [] if errors else calibration_results(entries, deck_counts, records, min_score)
    return {
        "entries": entries,
        "errors": errors,
        "results": results,
        "deck_counts": deck_counts,
        "tokens": tokens_by_ref,
    }


def calibrate(db_path: str, bible_id: str, min_score: float, show_text: bool) -> int:
    """Print how the audit's flags line up with the maintainer's verdicts.
    Returns the exit status: non-zero only when the reference set itself
    fails validation."""
    run = run_calibration(db_path, bible_id, min_score)
    entries, results, deck_counts = run["entries"], run["results"], run["deck_counts"]
    if run["errors"]:
        print("Reference set failed validation:")
        for err in run["errors"]:
            print(f"  - {err}")
        return 1

    agreed_by_ref = {e["ref"]: e["agreed"] for e in entries}
    for r in results:
        verdict = "ok" if r["ok"] else ("MISS" if r["state"] == "changed" else "FALSE ALARM")
        weak = " (weak)" if r["confidence"] == "weak" else ""
        print(f"[{r['score']:.2f}] {verdict:<11} {r['state']:<7} {r['ref']}{weak}")
        for sig in r["fired"]:
            print(f"    - {sig}")
        if show_text:
            toks = run["tokens"][r["ref"]]
            print(f"    deck:   {_split_text(toks, deck_counts[r['ref']])}")
            if r["state"] == "changed":
                print(f"    agreed: {_split_text(toks, agreed_by_ref[r['ref']])}")

    def count(state: str, ok: bool, weak: bool) -> int:
        return sum(
            1 for r in results
            if r["state"] == state and r["ok"] == ok and (r["confidence"] == "weak") == weak
        )

    excluded = sum(1 for e in entries if e.get("confidence") == "unresolved")
    print(f"\nmin_score={min_score}")
    for label, weak in (("agreed", False), ("weak", True)):
        print(
            f"{label}: changed caught {count('changed', True, weak)}, "
            f"missed {count('changed', False, weak)}; "
            f"kept quiet {count('kept', True, weak)}, flagged {count('kept', False, weak)}"
        )
    print(f"unresolved (excluded): {excluded}")
    return 0


def _emit(record: Dict[str, Any], min_score: float, show_all: bool) -> bool:
    if record["blockers"]:
        return True
    if show_all:
        return True
    return record["signal_score"] >= min_score


def main() -> None:
    ap = argparse.ArgumentParser(
        description=__doc__,
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    ap.add_argument(
        "deck",
        nargs="?",
        default="data/3-corinthians.json",
        help="Structural deck JSON (default: data/3-corinthians.json)",
    )
    ap.add_argument("--refs", help="Comma-separated refs to limit the check to")
    ap.add_argument(
        "--top",
        type=int,
        help="Emit only the top N entries (sorted: blockers first, then by signal_score desc)",
    )
    ap.add_argument(
        "--min-score",
        type=float,
        default=DEFAULT_MIN_SCORE,
        help=f"Composite signal-score threshold for emission (default: {DEFAULT_MIN_SCORE})",
    )
    ap.add_argument(
        "--all",
        action="store_true",
        dest="show_all",
        help="Bypass --min-score; emit every checked verse",
    )
    ap.add_argument("--db", default=DEFAULT_DB_PATH, help="Shared api.bible SQLite cache")
    ap.add_argument("--bible", default=DEFAULT_NKJV_ID, help="api.bible bibleId (default: NKJV)")
    ap.add_argument("--out", help="Write the JSON report to this path")
    ap.add_argument(
        "--calibrate",
        action="store_true",
        help="Score the audit against the reference set instead of auditing a deck",
    )
    ap.add_argument(
        "--show-text",
        action="store_true",
        help="With --calibrate, print the deck and agreed splits as text",
    )
    args = ap.parse_args()

    if args.calibrate:
        sys.exit(calibrate(args.db, args.bible, args.min_score, args.show_text))

    with open(args.deck, encoding="utf-8") as f:
        deck = json.load(f)

    ref_filter = None
    if args.refs:
        ref_filter = {normalize_reference(r.strip()) for r in args.refs.split(",") if r.strip()}

    conn = open_cache(args.db)
    try:
        full_report = evaluate(deck, conn, args.bible, ref_filter)
    finally:
        conn.close()

    emitted = [r for r in full_report if _emit(r, args.min_score, args.show_all)]
    # Blockers float to the top; within each layer, sort by score desc, ref asc.
    emitted.sort(key=lambda r: (0 if r["blockers"] else 1, -r["signal_score"], r["ref"]))
    if args.top is not None:
        emitted = emitted[: args.top]

    checked = len(full_report)
    blocker_count = sum(1 for r in emitted if r["blockers"])
    print(f"Checked {checked} verses (filter min_score={args.min_score}, all={args.show_all}).")
    print(f"Emitted: {len(emitted)} ({blocker_count} blocker, {len(emitted) - blocker_count} signal).")
    for r in emitted:
        if r["blockers"]:
            print(f"\n  [BLOCK] {r['ref']}")
            for b in r["blockers"]:
                print(f"    - {b}")
        else:
            print(f"\n  [{r['signal_score']:.2f}] {r['ref']}")
            if r["signals"]:
                for s in _top_signals(r["signals"]):
                    print(f"    - {s}")

    if args.out:
        os.makedirs(os.path.dirname(args.out) or ".", exist_ok=True)
        with open(args.out, "w", encoding="utf-8") as f:
            json.dump(emitted, f, indent=2, ensure_ascii=False)
        print(f"\nWrote report to {args.out}")

    sys.exit(1 if blocker_count else 0)


if __name__ == "__main__":
    main()
