#!/usr/bin/env python3
"""Audit phrase splits in a committed structural deck file.

Reads the deck's ``phraseWordCounts`` against the canonical api.bible
NKJV tokens, then emits one record per verse with two layers:

* **Blockers** — structural failures (missing/wrong-shape word counts,
  sum drift, missing canonical tokens, unbalanced HTML inside a phrase).
  A non-empty blockers list means the deck and the canonical text
  disagree; a human must fix the deck before any re-split is meaningful.

* **Signals + composite score** — deterministic features of the current
  split (``boundary_severance`` with ``severance_kind``, ``stub_phrase``,
  ``cognitive_overload``, ``missing_split``, …). These don't say a split
  is wrong; they surface what's worth a look. The composite
  ``signal_score`` is a weighted sum in ``[0, 1]`` and drives ``--top`` /
  ``--min-score``.

The judge step is gone — the splitter prompt now folds in that
judgement using the current split + signals + a stability clause.

Usage:
    python3 tools/evaluate_phrases.py
    python3 tools/evaluate_phrases.py data/4-john.json --top 20
    python3 tools/evaluate_phrases.py data/4-john.json --min-score 0.3
    python3 tools/evaluate_phrases.py data/4-john.json --refs "John 1:14"
    python3 tools/evaluate_phrases.py data/4-john.json --all --out report.json
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
from phrase_splitter.features import _signal_float, slice_phrases  # noqa: E402
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


def _top_signals(signals: Dict[str, Any], k: int = 3) -> List[str]:
    """Extract the k most anomalous signal bullets for stdout display.
    Emits at most k human-readable strings; for ``--out`` JSON callers
    write the full ``signals`` dict directly."""
    if not isinstance(signals, dict):
        return []

    bullets: List[Tuple[float, str]] = []  # (severity, message)

    for i, b in enumerate(signals.get("boundaries") or []):
        sev = _signal_float(b, "boundary_severance")
        kind = b.get("severance_kind") if isinstance(b, dict) else None
        if sev > 0.0 and kind:
            bullets.append((sev, f"boundary {i+1}→{i+2}: {kind} (severance={sev:.2f})"))

    for i, p in enumerate(signals.get("phrases") or []):
        stub = _signal_float(p, "stub_phrase")
        if stub > 0.0:
            wc = p.get("word_count") if isinstance(p, dict) else None
            bullets.append((stub * 0.5, f"phrase {i+1}: stub ({wc}w)"))
        ov = _signal_float(p, "cognitive_overload")
        if ov > 0.0:
            cw = p.get("content_word_count") if isinstance(p, dict) else None
            bullets.append((ov * 0.6, f"phrase {i+1}: overload ({cw} content words)"))

    missing = _signal_float(signals, "missing_split")
    if missing > 0.0:
        token_count = signals.get("token_count", 0)
        bullets.append((missing * 0.7, f"single phrase, {token_count} tokens — likely missing split"))

    bullets.sort(reverse=True)
    return [msg for _, msg in bullets[:k]]


def evaluate(
    deck: Dict[str, Any],
    conn,
    bible_id: str,
    ref_filter: Optional[Set[str]] = None,
) -> List[Dict[str, Any]]:
    """Walk the structural deck verse-by-verse, fetching each chapter's
    canonical tokens once and reusing them across the chapter's verses.
    Returns one record per verse that was checked (filtering happens in
    main, not here)."""
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
        record = check_verse(v, tokens)
        record["ref"] = ref
        report.append(record)
    return report


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
    args = ap.parse_args()

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
