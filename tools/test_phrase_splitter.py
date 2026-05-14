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
from phrase_splitter.features import (
    FUNCTION_WORDS,
    WEAK_CONNECTORS,
    composite_signal_score,
    count_syllables,
    extract_boundary_features,
    extract_phrase_features,
    extract_verse_features,
    slice_phrases,
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


class SyllableTests(unittest.TestCase):
    def test_monosyllables(self):
        for w in ("the", "made", "John", "Christ", "through"):
            self.assertEqual(count_syllables(w), 1, w)

    def test_disyllables(self):
        for w in ("Jesus", "apostle", "given"):
            self.assertGreaterEqual(count_syllables(w), 2, w)

    def test_handles_empty(self):
        self.assertEqual(count_syllables(""), 0)

    def test_handles_punctuation_only(self):
        self.assertEqual(count_syllables(",,,"), 0)


class SlicePhrasesTests(unittest.TestCase):
    def test_basic_slice(self):
        self.assertEqual(
            slice_phrases(["a", "b", "c", "d"], [1, 3]),
            [["a"], ["b", "c", "d"]],
        )

    def test_single_phrase(self):
        self.assertEqual(slice_phrases(["a", "b"], [2]), [["a", "b"]])

    def test_empty(self):
        self.assertEqual(slice_phrases([], []), [])


class PhraseFeatureTests(unittest.TestCase):
    def test_function_heavy_phrase(self):
        # "and of the things which" — almost entirely function words.
        feat = extract_phrase_features(
            ["and", "of", "the", "things", "which"], position="middle"
        )
        self.assertEqual(feat["word_count"], 5)
        self.assertEqual(feat["content_word_count"], 1)
        self.assertGreater(feat["function_ratio"], 0.7)
        self.assertTrue(feat["starts_with_weak_connector"])

    def test_content_heavy_phrase(self):
        feat = extract_phrase_features(
            ["Paul,", "called", "to", "be", "an", "apostle"], position="first"
        )
        self.assertEqual(feat["word_count"], 6)
        self.assertGreater(feat["content_word_count"], 2)
        self.assertFalse(feat["starts_with_weak_connector"])

    def test_pause_punct_at_end(self):
        feat = extract_phrase_features(["our", "brother,"], position="middle")
        self.assertTrue(feat["ends_in_pause_punct"])
        self.assertFalse(feat["ends_mid_clause"])

    def test_mid_clause_ending(self):
        feat = extract_phrase_features(["the", "kingdom", "of"], position="first")
        self.assertTrue(feat["ends_mid_clause"])
        self.assertFalse(feat["ends_in_pause_punct"])

    def test_internal_pause(self):
        feat = extract_phrase_features(
            ["Paul,", "called", "to", "be"], position="first"
        )
        self.assertTrue(feat["contains_internal_pause"])


class BoundaryFeatureTests(unittest.TestCase):
    def test_restrictive_relative_no_comma(self):
        # "nothing was made" / "that was made." — restrictive, no comma.
        feat = extract_boundary_features(
            ["nothing", "was", "made"], ["that", "was", "made."]
        )
        self.assertTrue(feat["restrictive_relative"])

    def test_non_restrictive_relative_has_comma(self):
        # "Nicodemus," / "who came to Jesus" — comma → non-restrictive.
        feat = extract_boundary_features(
            ["...", "Nicodemus,"], ["who", "came", "to", "Jesus"]
        )
        self.assertFalse(feat["restrictive_relative"])

    def test_not_a_relative(self):
        feat = extract_boundary_features(["Paul,"], ["called", "to", "be"])
        self.assertFalse(feat["restrictive_relative"])

    def test_verb_content_clause(self):
        # "Do you not know" / "that we shall judge angels?"
        feat = extract_boundary_features(
            ["Do", "you", "not", "know"], ["that", "we", "shall", "judge"]
        )
        self.assertTrue(feat["verb_content_clause"])

    def test_verb_quote_break_backs_off(self):
        # ``say, "How…"`` — reported speech, not a content clause.
        feat = extract_boundary_features(["he", "said,"], ['"How', 'long?"'])
        self.assertFalse(feat["verb_content_clause"])

    def test_verb_colon_backs_off(self):
        feat = extract_boundary_features(["I", "say:"], ["that", "no"])
        self.assertFalse(feat["verb_content_clause"])


class VerseFeatureTests(unittest.TestCase):
    def test_single_phrase_verse(self):
        feats = extract_verse_features(
            ["For", "the", "kingdom", "of", "God"], [5]
        )
        self.assertEqual(feats["phrase_count"], 1)
        self.assertEqual(feats["token_count"], 5)
        self.assertEqual(feats["boundaries"], [])
        self.assertEqual(len(feats["phrases"]), 1)
        self.assertEqual(feats["phrases"][0]["position"], "only")

    def test_multi_phrase_verse_shape(self):
        feats = extract_verse_features(
            ["a", "b", "c,", "d", "e", "f."], [3, 3]
        )
        self.assertEqual(feats["phrase_count"], 2)
        self.assertEqual(len(feats["boundaries"]), 1)
        self.assertEqual(feats["phrases"][0]["position"], "first")
        self.assertEqual(feats["phrases"][1]["position"], "last")
        self.assertAlmostEqual(feats["length_balance"], 1.0, places=2)

    def test_empty_verse(self):
        feats = extract_verse_features([], [])
        self.assertEqual(feats["phrase_count"], 0)
        self.assertEqual(feats["token_count"], 0)


class CompositeScoreTests(unittest.TestCase):
    def test_clean_verse_low_score(self):
        feats = extract_verse_features(
            ["For", "the", "kingdom", "of", "God"], [5]
        )
        # 5-word single-phrase verse: not missing-split, no other signals.
        self.assertLess(composite_signal_score(feats), 0.1)

    def test_restrictive_relative_raises_score(self):
        feats = extract_verse_features(
            ["nothing", "was", "made", "that", "was", "made."], [3, 3]
        )
        self.assertGreater(composite_signal_score(feats), 0.1)


if __name__ == "__main__":
    unittest.main()
