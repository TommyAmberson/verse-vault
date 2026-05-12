"""Unit tests for ``tools/phrase_splitter``.

Covers the small set of pure helpers that the evaluator and re-splitter
both depend on. The CLIs themselves are exercised by the skill-creator
eval loop and by the smoke-test in ``tools/README.md`` rather than by
unittest.
"""

import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from phrase_splitter import (
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


class WordCountTests(unittest.TestCase):
    def test_plain_text(self):
        self.assertEqual(word_count("Paul, called to be"), 4)

    def test_tagged_word_counts_as_one(self):
        self.assertEqual(word_count("and <b>Sosthenes</b> our brother,"), 4)

    def test_nested_tags(self):
        self.assertEqual(word_count("<b><i>asking</i></b> no <b>questions</b>"), 3)

    def test_span_with_attributes(self):
        self.assertEqual(
            word_count('L<span style="font-variant: small-caps;">ord</span>'),
            1,
        )

    def test_strip_html_preserves_inner_text(self):
        self.assertEqual(strip_html("a <b>b</b> c"), "a b c")

    def test_tokens_match_split_after_strip(self):
        self.assertEqual(tokens("a <b>b</b> c"), ["a", "b", "c"])


class RejoinTests(unittest.TestCase):
    def test_rejoin_exact(self):
        self.assertTrue(rejoin_matches(["a,", "b c"], "a, b c"))

    def test_rejoin_mismatch_on_missing_space(self):
        self.assertFalse(rejoin_matches(["a", "b"], "ab"))

    def test_rejoin_preserves_tags(self):
        text = "and <b>Sosthenes</b> our brother,"
        phrases = ["and <b>Sosthenes</b>", "our brother,"]
        self.assertTrue(rejoin_matches(phrases, text))


class HtmlBalanceTests(unittest.TestCase):
    def test_balanced_pair(self):
        self.assertTrue(html_tags_balanced("and <b>Sosthenes</b> our brother,"))

    def test_no_tags_balanced(self):
        self.assertTrue(html_tags_balanced("plain text"))

    def test_orphan_open(self):
        self.assertFalse(html_tags_balanced("and <b>Sosthenes our brother,"))

    def test_orphan_close(self):
        self.assertFalse(html_tags_balanced("and Sosthenes</b> our brother,"))

    def test_mixed_balanced(self):
        self.assertTrue(html_tags_balanced("<b><i>asking</i></b> no questions"))


class ReferenceTests(unittest.TestCase):
    def test_parse_simple(self):
        self.assertEqual(parse_reference("1 Corinthians 12:11"), ("1 Corinthians", 12, 11))

    def test_parse_strips_whitespace(self):
        self.assertEqual(parse_reference("  1 Corinthians 12:11  "), ("1 Corinthians", 12, 11))

    def test_normalize_short_form(self):
        self.assertEqual(normalize_reference("1 cor 12:11"), "1 Corinthians 12:11")
        self.assertEqual(normalize_reference("1Cor 12:11"), "1 Corinthians 12:11")
        self.assertEqual(normalize_reference("I Corinthians 12:11"), "1 Corinthians 12:11")

    def test_normalize_passthrough_unknown_book(self):
        # Unknown book strings should pass through so the caller surfaces
        # a clean "not in cache" error rather than crash.
        self.assertEqual(normalize_reference("Genesis 1:1"), "Genesis 1:1")

    def test_parse_rejects_garbage(self):
        with self.assertRaises(ValueError):
            parse_reference("not a reference")


class SeverityTests(unittest.TestCase):
    def test_ranking_ordered_worst_first(self):
        ranks = [severity_rank(s) for s in SEVERITIES]
        self.assertEqual(ranks, sorted(ranks))

    def test_blocker_worst(self):
        self.assertLess(severity_rank("blocker"), severity_rank("high"))
        self.assertLess(severity_rank("high"), severity_rank("medium"))
        self.assertLess(severity_rank("medium"), severity_rank("low"))


if __name__ == "__main__":
    unittest.main()
