"""Helpers and prompts for the phrase-splitter CLI tools.

The package keeps deterministic helpers (rejoin invariant, HTML-aware word
counter, severity ranker, reference parser) and LLM prompts (split, judge)
behind a single import surface so the evaluator and re-splitter share one
source of truth.
"""

from .helpers import (
    SEVERITIES,
    html_tags_balanced,
    normalize_reference,
    parse_reference,
    rejoin_matches,
    severity_rank,
    strip_html,
    tokens,
    word_count,
)
from .prompts import JUDGE_PROMPT, SPLIT_PROMPT

__all__ = [
    "JUDGE_PROMPT",
    "SEVERITIES",
    "SPLIT_PROMPT",
    "html_tags_balanced",
    "normalize_reference",
    "parse_reference",
    "rejoin_matches",
    "severity_rank",
    "strip_html",
    "tokens",
    "word_count",
]
