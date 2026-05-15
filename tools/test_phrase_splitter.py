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
    html_tags_balanced,
    normalize_reference,
    parse_reference,
    rejoin_matches,
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
from phrase_splitter.prompts import format_split_prompt

from evaluate_phrases import check_verse
from split_phrases import _render_current_split, _render_signals


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

    def test_cognitive_overload_ramp(self):
        # 6 content words: at threshold, no signal
        feat = extract_phrase_features(
            ["walked", "saw", "told", "heard", "knew", "ran"], position="middle"
        )
        self.assertEqual(feat["content_word_count"], 6)
        self.assertEqual(feat["cognitive_overload"], 0.0)

    def test_cognitive_overload_high(self):
        # 12 content words: full signal
        feat = extract_phrase_features(
            ["walked", "saw", "told", "heard", "knew", "ran",
             "spoke", "judged", "called", "found", "wrote", "asked"],
            position="middle",
        )
        self.assertEqual(feat["content_word_count"], 12)
        self.assertAlmostEqual(feat["cognitive_overload"], 1.0, places=3)

    def test_cognitive_overload_function_heavy_phrase_low(self):
        # All function words: signal stays 0 even at high word_count
        feat = extract_phrase_features(
            ["of", "the", "and", "in", "to", "for", "by", "with",
             "from", "of", "the", "in"],
            position="middle",
        )
        self.assertLess(feat["cognitive_overload"], 0.2)

    def test_stub_phrase_ramp(self):
        # 1-word phrase: heavily stubby
        feat = extract_phrase_features(["Behold!"], position="middle")
        self.assertAlmostEqual(feat["stub_phrase"], 0.75, places=3)

    def test_stub_phrase_threshold(self):
        # 4-word phrase: at threshold, no signal
        feat = extract_phrase_features(
            ["the", "kingdom", "of", "God"], position="middle"
        )
        self.assertEqual(feat["stub_phrase"], 0.0)

    def test_stub_phrase_only_position_zero(self):
        # Single-phrase verse: stub_phrase stays 0 regardless of length.
        # An "only" phrase is the whole verse; not a chunking problem.
        feat = extract_phrase_features(["Jesus", "wept."], position="only")
        self.assertEqual(feat["stub_phrase"], 0.0)


class BoundaryFeatureTests(unittest.TestCase):
    def test_bare_relative_no_comma(self):
        # "nothing was made" / "that was made." — restrictive, no comma.
        feat = extract_boundary_features(
            ["nothing", "was", "made"], ["that", "was", "made."]
        )
        self.assertGreater(feat["boundary_severance"], 0.5)
        self.assertEqual(feat["severance_kind"], "bare_relative")

    def test_non_restrictive_relative_has_comma_no_signal(self):
        # "Nicodemus," / "who came to Jesus" — comma → non-restrictive.
        feat = extract_boundary_features(
            ["...", "Nicodemus,"], ["who", "came", "to", "Jesus"]
        )
        self.assertEqual(feat["boundary_severance"], 0.0)
        self.assertIsNone(feat["severance_kind"])

    def test_not_a_relative_no_signal(self):
        feat = extract_boundary_features(["Paul,"], ["called", "to", "be"])
        self.assertEqual(feat["boundary_severance"], 0.0)
        self.assertIsNone(feat["severance_kind"])

    def test_verb_content_clause(self):
        # "Do you not know" / "that we shall judge angels?"
        feat = extract_boundary_features(
            ["Do", "you", "not", "know"], ["that", "we", "shall", "judge"]
        )
        self.assertGreater(feat["boundary_severance"], 0.5)
        self.assertEqual(feat["severance_kind"], "verb_content")

    def test_verb_quote_break_backs_off(self):
        # `say, "How…"` — reported speech, not a content clause.
        feat = extract_boundary_features(["he", "said,"], ['"How', 'long?"'])
        self.assertEqual(feat["boundary_severance"], 0.0)
        self.assertIsNone(feat["severance_kind"])

    def test_verb_colon_backs_off(self):
        feat = extract_boundary_features(["I", "say:"], ["that", "no"])
        self.assertEqual(feat["boundary_severance"], 0.0)
        self.assertIsNone(feat["severance_kind"])

    def test_stranded_stub_short_prev(self):
        # 1 Cor 12:11 "But one" (2w, mid-clause) / "and the same Spirit…"
        feat = extract_boundary_features(["But", "one"], ["and", "the", "same"])
        self.assertGreater(feat["boundary_severance"], 0.5)
        self.assertEqual(feat["severance_kind"], "stranded_stub")

    def test_stranded_stub_skips_complete_prev_clause(self):
        # Parallel siblings: "...was with God," / "and the Word was God."
        feat = extract_boundary_features(
            ["and", "the", "Word", "was", "with", "God,"],
            ["and", "the", "Word", "was", "God."],
        )
        self.assertEqual(feat["boundary_severance"], 0.0)
        self.assertIsNone(feat["severance_kind"])

    def test_stranded_stub_skips_long_prev(self):
        # Long prev ending mid-clause is not stranded even if next opens with `that`.
        # Falls into bare_relative because `that` follows a noun (Jews) without pause.
        # Either bare_relative or verb_content is acceptable; we just assert NOT stranded_stub.
        feat = extract_boundary_features(
            ["The", "man", "departed", "and", "told", "the", "Jews"],
            ["that", "it", "was", "Jesus"],
        )
        self.assertNotEqual(feat["severance_kind"], "stranded_stub")

    def test_short_next_intensifies_severance(self):
        # "nothing was made / that was made." (3w next) should score
        # higher than "told the Jews / that it was Jesus..." (10w next).
        short_next = extract_boundary_features(
            ["nothing", "was", "made"], ["that", "was", "made."]
        )
        long_next = extract_boundary_features(
            ["nothing", "was", "made"],
            ["that", "was", "made", "in", "the", "beginning", "of", "all", "things", "made."],
        )
        self.assertGreater(short_next["boundary_severance"], long_next["boundary_severance"])


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


class FormatSplitPromptTests(unittest.TestCase):
    VERSE = "For the kingdom of God is not in word but in power."

    def test_bare_prompt(self):
        out = format_split_prompt(self.VERSE)
        self.assertIn("memorisation phrases", out)
        self.assertIn(self.VERSE, out)
        self.assertNotIn("Current split", out)
        self.assertNotIn("Signals (auto-computed)", out)

    def test_with_current_split(self):
        out = format_split_prompt(
            self.VERSE,
            current_split='  - "For the kingdom of God"\n  - "is not in word but in power."',
        )
        self.assertIn("Current split", out)
        self.assertIn("best split, not a different split", out)
        self.assertNotIn("Signals (auto-computed)", out)

    def test_with_signals_only(self):
        out = format_split_prompt(self.VERSE, signals="Verse: 12 tokens, 2 phrases")
        self.assertIn("Signals (auto-computed)", out)
        self.assertIn("12 tokens", out)
        self.assertNotIn("Current split", out)

    def test_with_both(self):
        out = format_split_prompt(
            self.VERSE,
            current_split="  - whole verse",
            signals="Verse: 12 tokens",
        )
        self.assertIn("Current split", out)
        self.assertIn("Signals (auto-computed)", out)
        # Order: current split appears before signals.
        self.assertLess(out.index("Current split"), out.index("Signals (auto-computed)"))


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


class CheckVerseTests(unittest.TestCase):
    def test_missing_pwc_is_blocker(self):
        out = check_verse({"phraseWordCounts": []}, ["a", "b", "c"])
        self.assertTrue(out["blockers"])
        self.assertEqual(out["signals"], None)

    def test_sum_drift_is_blocker(self):
        out = check_verse({"phraseWordCounts": [3, 3]}, ["a", "b", "c", "d", "e"])
        self.assertTrue(any("drift" in b for b in out["blockers"]))
        self.assertEqual(out["signals"], None)

    def test_no_canonical_tokens_is_blocker(self):
        out = check_verse({"phraseWordCounts": [3]}, [])
        self.assertTrue(out["blockers"])

    def test_unbalanced_html_is_blocker(self):
        # Phrase 1 opens <b> but doesn't close it inside the phrase.
        out = check_verse({"phraseWordCounts": [3, 3]}, ["a", "<b>b", "c", "d</b>", "e", "f"])
        self.assertTrue(any("unbalanced HTML" in b for b in out["blockers"]))

    def test_clean_split_no_blockers(self):
        out = check_verse(
            {"phraseWordCounts": [5]},
            ["For", "the", "kingdom", "of", "God"],
        )
        self.assertEqual(out["blockers"], [])
        self.assertIsInstance(out["signal_score"], float)
        self.assertIsNotNone(out["signals"])

    def test_restrictive_relative_lifts_score(self):
        # "nothing was made" / "that was made." — restrictive relative
        # boundary. No blockers expected; score should be above default.
        out = check_verse(
            {"phraseWordCounts": [3, 3]},
            ["nothing", "was", "made", "that", "was", "made."],
        )
        self.assertEqual(out["blockers"], [])
        self.assertGreater(out["signal_score"], 0.15)

    def test_ftv_out_of_range_is_blocker(self):
        out = check_verse(
            {"phraseWordCounts": [3], "ftvWordCount": 99},
            ["a", "b", "c"],
        )
        self.assertTrue(out["blockers"])


class PrintPromptRenderingTests(unittest.TestCase):
    def test_render_current_split_bullets(self):
        out = _render_current_split(
            ["For", "the", "kingdom", "of", "God"],
            [3, 2],
        )
        self.assertIn('"For the kingdom"', out)
        self.assertIn('"of God"', out)
        # Two bulleted lines.
        self.assertEqual(out.count("  - "), 2)

    def test_render_signals_includes_header_and_boundary(self):
        feats = extract_verse_features(
            ["nothing", "was", "made", "that", "was", "made."],
            [3, 3],
        )
        rendered = _render_signals(feats)
        self.assertIn("6 tokens", rendered)
        self.assertIn("2 phrases", rendered)
        self.assertIn("restrictive-relative", rendered)
        self.assertIn("Composite score:", rendered)


if __name__ == "__main__":
    unittest.main()
