"""Helpers, features, and prompts for the phrase-splitter CLI tools.

The package keeps deterministic helpers (rejoin invariant, HTML-aware word
counter, reference parser), the feature extractor (signal layer), and
LLM prompts behind a single import surface so the evaluator and
re-splitter share one source of truth.
"""

from .features import (
    FUNCTION_WORDS,
    composite_signal_score,
    extract_boundary_features,
    extract_phrase_features,
    extract_verse_features,
)
from .helpers import (
    html_tags_balanced,
    normalize_reference,
    parse_reference,
    rejoin_matches,
    strip_html,
    tokens,
    word_count,
)
from .prompts import SPLIT_PROMPT, format_split_prompt

__all__ = [
    "FUNCTION_WORDS",
    "SPLIT_PROMPT",
    "composite_signal_score",
    "extract_boundary_features",
    "extract_phrase_features",
    "extract_verse_features",
    "format_split_prompt",
    "html_tags_balanced",
    "normalize_reference",
    "parse_reference",
    "rejoin_matches",
    "strip_html",
    "tokens",
    "word_count",
]
