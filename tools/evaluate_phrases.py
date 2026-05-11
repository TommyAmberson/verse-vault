#!/usr/bin/env python3
"""Audit phrase splits in the verse-vault phrases cache.

Reports verses whose splits violate the project's memorisation-quality
criteria — rejoin failures, missing splits, fragments out of bounds,
imbalanced HTML markup. Pure-stdlib so it runs anywhere; the optional
``--llm-judge`` flag adds a Claude-Haiku quality check for verses that
pass the deterministic checks but might still feel awkward.

Usage:
    python3 tools/evaluate_phrases.py data/corinthians-phrases.json
    python3 tools/evaluate_phrases.py data/corinthians-phrases.json --top 10
    python3 tools/evaluate_phrases.py data/corinthians-phrases.json --refs "1 Cor 12:11,1 Cor 1:26"
    python3 tools/evaluate_phrases.py data/corinthians-phrases.json --out report.json
    python3 tools/evaluate_phrases.py data/corinthians-phrases.json --llm-judge
"""

import argparse
import json
import os
import sys
from typing import Any, Dict, List, Optional, Set

# Allow `python3 tools/evaluate_phrases.py …` from the repo root and
# `python3 evaluate_phrases.py …` from inside tools/.
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from phrase_splitter import (  # noqa: E402
    JUDGE_PROMPT,
    SEVERITIES,
    html_tags_balanced,
    normalize_reference,
    rejoin_matches,
    severity_rank,
    word_count,
)

WORD_MIN = 3
WORD_MAX = 12
# A single-phrase verse longer than this is almost certainly a missed
# split. Tunable; 10 words is roughly the point where reciters benefit
# from a break.
MISSING_SPLIT_THRESHOLD = 10


def check_verse(ref: str, entry: Dict[str, Any]) -> List[Dict[str, str]]:
    """Return a list of ``{severity, reason}`` for one cache entry.

    All checks are pure (no I/O, no LLM). Designed to run on every entry
    in the cache in a single sub-second pass.
    """
    issues: List[Dict[str, str]] = []
    text = entry.get("text", "")
    phrases = entry.get("phrases", [])

    if not isinstance(phrases, list) or not phrases:
        return [{"severity": "blocker", "reason": "missing or non-list phrases"}]

    # Empty phrase entries are a blocker — they break rejoin and corrupt
    # downstream tooling.
    if any(not isinstance(p, str) or not p for p in phrases):
        issues.append({"severity": "blocker", "reason": "empty or non-string phrase in list"})

    if not rejoin_matches(phrases, text):
        rejoined = " ".join(phrases)
        issues.append({
            "severity": "blocker",
            "reason": f"rejoin mismatch (joined {len(rejoined)} chars; original {len(text)})",
        })

    total_words = word_count(text)
    if len(phrases) == 1 and total_words > MISSING_SPLIT_THRESHOLD:
        issues.append({
            "severity": "high",
            "reason": f"single phrase for {total_words}-word verse",
        })

    for i, p in enumerate(phrases):
        if not isinstance(p, str) or not p:
            continue
        wc = word_count(p)
        is_edge = i == 0 or i == len(phrases) - 1
        if wc < WORD_MIN:
            # Stranded short fragments mid-verse almost always read as a
            # bad break (e.g. ``"But one"`` in 1 Cor 12:11). The same
            # length at the verse's edge is often a deliberate intro or
            # closing stub (``"Moreover,"``, ``"and Him crucified."``),
            # so downgrade those rather than treat them as equivalent.
            sev = "medium" if is_edge else "high"
            issues.append({
                "severity": sev,
                "reason": f"phrase {i+1} has {wc} word{'s' if wc != 1 else ''}: {_clip(p)}",
            })
        elif wc > WORD_MAX:
            issues.append({
                "severity": "high",
                "reason": f"phrase {i+1} has {wc} words: {_clip(p)}",
            })
        if not html_tags_balanced(p):
            issues.append({
                "severity": "blocker",
                "reason": f"phrase {i+1} has unbalanced HTML tags: {_clip(p)}",
            })

    return issues


def _clip(s: str, n: int = 70) -> str:
    return s if len(s) <= n else s[: n - 1].rstrip() + "…"


def _top_severity(issues: List[Dict[str, str]]) -> str:
    return SEVERITIES[min(severity_rank(i["severity"]) for i in issues)]


def evaluate(
    cache: Dict[str, Any], ref_filter: Optional[Set[str]] = None
) -> List[Dict[str, Any]]:
    report = []
    for ref, entry in cache.items():
        if ref_filter is not None and ref not in ref_filter:
            continue
        issues = check_verse(ref, entry)
        if issues:
            report.append({
                "ref": ref,
                "top_severity": _top_severity(issues),
                "reasons": issues,
            })
    report.sort(key=lambda r: (severity_rank(r["top_severity"]), r["ref"]))
    return report


def call_judge(
    cache: Dict[str, Any],
    deterministic_flagged: Set[str],
    ref_filter: Optional[Set[str]],
    model: str,
) -> List[Dict[str, Any]]:
    """Ask Claude Haiku to flag splits that look awkward despite passing
    the deterministic checks. Requires the ``anthropic`` package and
    ``ANTHROPIC_API_KEY`` in the environment; raises a clean error
    otherwise so the caller can tell the user what to install.
    """
    try:
        from anthropic import Anthropic  # type: ignore
    except ImportError as e:  # pragma: no cover — depends on env
        raise SystemExit(
            "--llm-judge requires the 'anthropic' package. "
            "Install with: pip install anthropic"
        ) from e
    if not os.environ.get("ANTHROPIC_API_KEY"):
        raise SystemExit("--llm-judge requires ANTHROPIC_API_KEY in env")

    client = Anthropic()
    extra = []
    for ref, entry in cache.items():
        if ref in deterministic_flagged:
            continue
        if ref_filter is not None and ref not in ref_filter:
            continue
        phrases = entry.get("phrases") or []
        text = entry.get("text", "")
        if not phrases or len(phrases) == 1:
            # Single-phrase verses that survived the deterministic checks
            # are short enough that judging adds little; skip to keep
            # cost down.
            continue
        phrases_block = "\n".join(f"  - {p}" for p in phrases)
        prompt = JUDGE_PROMPT.format(ref=ref, text=text, phrases_block=phrases_block)
        try:
            resp = client.messages.create(
                model=model,
                max_tokens=400,
                messages=[{"role": "user", "content": prompt}],
            )
            body = resp.content[0].text.strip()
            # Strip code fences if the model added any.
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
    ap.add_argument("cache", help="Phrases cache JSON (e.g. data/corinthians-phrases.json)")
    ap.add_argument("--refs", help="Comma-separated refs to limit the check to")
    ap.add_argument(
        "--llm-judge",
        action="store_true",
        help="Ask Claude Haiku to audit splits that passed the deterministic checks",
    )
    ap.add_argument(
        "--judge-model",
        default="claude-haiku-4-5-20251001",
        help="Anthropic model id for the LLM judge",
    )
    ap.add_argument("--out", help="Write the JSON report to this path")
    ap.add_argument("--top", type=int, help="Print only the top N worst entries")
    args = ap.parse_args()

    with open(args.cache, encoding="utf-8") as f:
        cache = json.load(f)

    ref_filter = None
    if args.refs:
        ref_filter = {normalize_reference(r.strip()) for r in args.refs.split(",") if r.strip()}
        missing = ref_filter - set(cache.keys())
        if missing:
            sys.stderr.write(
                f"warning: {len(missing)} ref(s) not in cache: {sorted(missing)}\n"
            )

    report = evaluate(cache, ref_filter)

    if args.llm_judge:
        deterministic_flagged = {r["ref"] for r in report}
        report.extend(call_judge(cache, deterministic_flagged, ref_filter, args.judge_model))
        report.sort(key=lambda r: (severity_rank(r["top_severity"]), r["ref"]))

    print(f"Checked {len(cache)} entries.")
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
