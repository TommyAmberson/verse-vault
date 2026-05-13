#!/usr/bin/env python3
"""Audit phrase splits in the committed structural deck file.

Operates on ``data/3-corinthians.json`` (the durable source of truth for
``phraseWordCounts`` and ``annotations``) plus the api.bible HTML
cache (canonical NKJV tokens). Phrase text shown in the report is
sliced from api.bible tokens by the deck's word counts — no per-verse
text crosses through the deck anymore.

Checks (deterministic, run on every verse):

- ``phraseWordCounts`` sum matches the api.bible token count → drift
  between the deck's structural metadata and the canonical text.
- Each phrase word count is in [3, 12] with edge phrases allowed to
  be shorter (an intro / closing stub).
- Single-phrase verse whose token count exceeds the missing-split
  threshold → almost certainly a split that was never applied.
- No phrase ends in a perception/speech verb (``know``, ``see``,
  ``tell``, …) immediately followed by a phrase starting with
  ``that`` / ``what`` / ``how`` / ``whether`` / ``if`` — that splits
  a verb from its content clause, which is one rhetorical unit.
- ``ftvWordCount`` is in range when set.

The optional ``--llm-judge`` flag adds a Claude-Haiku quality check
for verses that pass the deterministic checks but might still feel
awkward.

Usage:
    python3 tools/evaluate_phrases.py
    python3 tools/evaluate_phrases.py --top 10
    python3 tools/evaluate_phrases.py --refs "1 Cor 12:11,1 Cor 1:26"
    python3 tools/evaluate_phrases.py --out report.json
    python3 tools/evaluate_phrases.py --llm-judge
"""

import argparse
import json
import os
import sys
from typing import Any, Dict, List, Optional, Set

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from phrase_splitter import (  # noqa: E402
    JUDGE_PROMPT,
    SEVERITIES,
    normalize_reference,
    severity_rank,
)
from phrase_splitter.apibible import (  # noqa: E402
    DEFAULT_DB_PATH,
    DEFAULT_NKJV_ID,
    extract_chapter_verses,
    get_chapter_html,
    open_cache,
)

WORD_MIN = 3
# Soft ceiling above which the auditor flags a phrase as too long. There is
# no validator cap in split_phrases.py — long phrases are a quality flag for
# human review, not a hard error.
WORD_MAX = 12
# A single-phrase verse longer than this is almost certainly a missed
# split. Tunable; 10 words is roughly the point where reciters benefit
# from a break.
MISSING_SPLIT_THRESHOLD = 10

# Verbs of perception / speech that commonly take a ``that``-clause
# (or ``what`` / ``how`` / ``whether`` / ``if``) as their direct
# object. Splitting between such a verb and its content clause breaks
# a single rhetorical/cognitive unit and should be flagged. The
# heuristic is intentionally narrow — it only matches when the
# *last word of one phrase* is one of these verbs and the *first word*
# of the next phrase is one of the listed complementisers. See
# ``references/quality-criteria.md`` for the rationale.
CONTENT_CLAUSE_VERBS = frozenset({
    "know", "knew", "known", "knows",
    "see", "saw", "seen", "sees",
    "hear", "heard", "hears",
    "tell", "told", "tells",
    "say", "said", "says",
    "believe", "believed", "believes",
    "think", "thought", "thinks",
    "understand", "understood", "understands",
    "remember", "remembered", "remembers",
    "perceive", "perceived", "perceives",
    "consider", "considered", "considers",
    "declare", "declared", "declares",
    "suppose", "supposed", "supposes",
    "recognize", "recognized", "recognizes",
    "realize", "realized", "realizes",
    "learn", "learned", "learns",
})
# ``if`` is excluded — it's almost always a conditional in scripture
# rather than the rare ``know if`` complementiser, and including it
# produced more false positives than true positives in practice.
CONTENT_CLAUSE_COMPLEMENTISERS = frozenset({
    "that", "what", "how", "whether",
})

# When the boundary itself carries a stronger break signal — a colon
# (introducing direct/reported speech, e.g. ``say: If any brother…``)
# or an open quote (direct speech, e.g. ``say, "How…"``) — the
# heuristic backs off, because the verb is being read with its
# *quoted* object rather than a content clause.
_QUOTE_OPENERS = ("\"", "“", "‘", "'")


def _strip_punct(word: str) -> str:
    return word.strip(",.?!;:\"'“”‘’()[]")


def check_verse(ref: str, verse: Dict[str, Any], tokens: List[str]) -> List[Dict[str, str]]:
    """Return a list of ``{severity, reason, ...}`` for one structural
    verse entry. ``tokens`` is the canonical token stream from
    api.bible (used both to detect deck/api drift and to quote phrase
    text in the report)."""
    issues: List[Dict[str, str]] = []
    pwc = verse.get("phraseWordCounts") or []

    if not isinstance(pwc, list) or not pwc:
        issues.append({"severity": "blocker", "reason": "missing or empty phraseWordCounts"})
        return issues

    pwc_sum = sum(pwc)
    api_count = len(tokens)
    if api_count == 0:
        issues.append({
            "severity": "blocker",
            "reason": "no canonical tokens — verse missing from api.bible cache",
        })
        return issues

    if pwc_sum != api_count:
        issues.append({
            "severity": "blocker",
            "reason": (
                f"phraseWordCounts sum ({pwc_sum}) differs from api.bible "
                f"token count ({api_count}) — deck/canonical drift"
            ),
        })

    if len(pwc) == 1 and api_count > MISSING_SPLIT_THRESHOLD:
        issues.append({
            "severity": "high",
            "reason": f"single phrase for {api_count}-word verse",
        })

    cursor = 0
    phrase_slices: List[str] = []
    for i, count in enumerate(pwc):
        slice_text = " ".join(tokens[cursor : cursor + count])
        phrase_slices.append(slice_text)
        cursor += count
        is_edge = i == 0 or i == len(pwc) - 1
        if count < WORD_MIN:
            sev = "medium" if is_edge else "high"
            issues.append({
                "severity": sev,
                "reason": f"phrase {i+1} has {count} word{'s' if count != 1 else ''}: {_clip(slice_text)}",
            })
        elif count > WORD_MAX:
            issues.append({
                "severity": "high",
                "reason": f"phrase {i+1} has {count} words: {_clip(slice_text)}",
            })

    # Verb-clause split: phrase ends in a perception/speech verb and
    # the next phrase starts with that/what/how/whether. Skip the
    # colon and open-quote cases where the boundary is itself a
    # stronger reported-speech break.
    for i in range(len(phrase_slices) - 1):
        words = phrase_slices[i].split()
        next_phrase = phrase_slices[i + 1]
        next_words = next_phrase.split()
        if not words or not next_words:
            continue
        last_raw = words[-1]
        last = _strip_punct(last_raw).lower()
        nxt = _strip_punct(next_words[0]).lower()
        if last not in CONTENT_CLAUSE_VERBS or nxt not in CONTENT_CLAUSE_COMPLEMENTISERS:
            continue
        if last_raw.endswith(":"):
            continue  # ``say: If any brother…`` — colon breaks first
        if next_phrase.lstrip().startswith(_QUOTE_OPENERS):
            continue  # ``say, "How…`` — direct-speech quotation
        issues.append({
            "severity": "high",
            "reason": (
                f"verb-clause split between phrase {i+1} (…{last!r}) and "
                f"phrase {i+2} ({nxt!r}…) — keep verb with its content clause"
            ),
        })

    ftv = verse.get("ftvWordCount")
    if ftv is not None:
        if not isinstance(ftv, int) or ftv < 1 or ftv > api_count:
            issues.append({
                "severity": "high",
                "reason": f"ftvWordCount={ftv} out of [1, {api_count}]",
            })

    return issues


def _clip(s: str, n: int = 70) -> str:
    return s if len(s) <= n else s[: n - 1].rstrip() + "…"


def _top_severity(issues: List[Dict[str, str]]) -> str:
    return SEVERITIES[min(severity_rank(i["severity"]) for i in issues)]


def evaluate(
    deck: Dict[str, Any],
    conn,
    bible_id: str,
    ref_filter: Optional[Set[str]] = None,
) -> List[Dict[str, Any]]:
    """Walk the structural deck verse-by-verse, fetching each chapter's
    canonical tokens once and reusing across the chapter's verses."""
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
        issues = check_verse(ref, v, tokens)
        if issues:
            report.append({
                "ref": ref,
                "top_severity": _top_severity(issues),
                "reasons": issues,
            })
    report.sort(key=lambda r: (severity_rank(r["top_severity"]), r["ref"]))
    return report


def call_judge(
    deck: Dict[str, Any],
    conn,
    bible_id: str,
    deterministic_flagged: Set[str],
    ref_filter: Optional[Set[str]],
    model: str,
) -> List[Dict[str, Any]]:
    """Ask Claude Haiku to flag awkward splits among verses that passed
    the deterministic checks. Requires the ``anthropic`` package and
    ``ANTHROPIC_API_KEY`` in the env."""
    try:
        from anthropic import Anthropic  # type: ignore
    except ImportError as e:
        raise SystemExit(
            "--llm-judge requires the 'anthropic' package. "
            "Install with: pip install anthropic"
        ) from e
    if not os.environ.get("ANTHROPIC_API_KEY"):
        raise SystemExit("--llm-judge requires ANTHROPIC_API_KEY in env")

    client = Anthropic()
    extra: List[Dict[str, Any]] = []
    chapter_tokens: Dict[tuple, Dict[int, List[str]]] = {}
    for v in deck.get("verses", []):
        ref = f"{v['book']} {v['chapter']}:{v['verse']}"
        if ref in deterministic_flagged:
            continue
        if ref_filter is not None and ref not in ref_filter:
            continue
        pwc = v.get("phraseWordCounts") or []
        if len(pwc) < 2:
            continue  # single-phrase verses don't have a split to judge
        key = (v["book"], v["chapter"])
        if key not in chapter_tokens:
            html = get_chapter_html(conn, v["book"], v["chapter"], bible_id=bible_id)
            chapter_tokens[key] = extract_chapter_verses(html, v["book"], v["chapter"])
        tokens = chapter_tokens[key].get(v["verse"], [])
        phrases: List[str] = []
        cursor = 0
        for c in pwc:
            phrases.append(" ".join(tokens[cursor : cursor + c]))
            cursor += c
        text = " ".join(tokens)
        phrases_block = "\n".join(f"  - {p}" for p in phrases)
        prompt = JUDGE_PROMPT.format(ref=ref, text=text, phrases_block=phrases_block)
        try:
            resp = client.messages.create(
                model=model,
                max_tokens=400,
                messages=[{"role": "user", "content": prompt}],
            )
            body = resp.content[0].text.strip()
            if body.startswith("```"):
                body = body.split("\n", 1)[1] if "\n" in body else body
                body = body.rsplit("```", 1)[0]
            verdict = json.loads(body)
        except Exception as e:
            sys.stderr.write(f"  judge failed for {ref}: {e}\n")
            continue
        if verdict.get("verdict") == "needs_resplit":
            reasons = [
                {"severity": "medium", "reason": r}
                for r in verdict.get("reasons", []) or ["llm judge flagged"]
            ]
            extra.append({"ref": ref, "top_severity": "medium", "reasons": reasons})
    return extra


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
        "--llm-judge",
        action="store_true",
        help="Ask Claude Haiku to audit splits that passed the deterministic checks",
    )
    ap.add_argument("--judge-model", default="claude-haiku-4-5-20251001")
    ap.add_argument("--db", default=DEFAULT_DB_PATH, help="Shared api.bible SQLite cache")
    ap.add_argument("--bible", default=DEFAULT_NKJV_ID, help="api.bible bibleId (default: NKJV)")
    ap.add_argument("--out", help="Write the JSON report to this path")
    ap.add_argument("--top", type=int, help="Print only the top N worst entries")
    args = ap.parse_args()

    with open(args.deck, encoding="utf-8") as f:
        deck = json.load(f)

    ref_filter = None
    if args.refs:
        ref_filter = {normalize_reference(r.strip()) for r in args.refs.split(",") if r.strip()}

    conn = open_cache(args.db)
    try:
        report = evaluate(deck, conn, args.bible, ref_filter)
        if args.llm_judge:
            deterministic_flagged = {r["ref"] for r in report}
            report.extend(
                call_judge(deck, conn, args.bible, deterministic_flagged, ref_filter, args.judge_model)
            )
            report.sort(key=lambda r: (severity_rank(r["top_severity"]), r["ref"]))
    finally:
        conn.close()

    print(f"Checked {sum(1 for v in deck.get('verses', []) if v.get('phraseWordCounts'))} verses.")
    print(f"Flagged: {len(report)}")
    to_show = report if args.top is None else report[: args.top]
    for r in to_show:
        print(f"\n  [{r['top_severity']}] {r['ref']}")
        for i in r["reasons"]:
            print(f"    - {i['reason']}")

    if args.out:
        os.makedirs(os.path.dirname(args.out) or ".", exist_ok=True)
        with open(args.out, "w", encoding="utf-8") as f:
            json.dump(report, f, indent=2, ensure_ascii=False)
        print(f"\nWrote report to {args.out}")

    sys.exit(1 if any(r["top_severity"] == "blocker" for r in report) else 0)


if __name__ == "__main__":
    main()
