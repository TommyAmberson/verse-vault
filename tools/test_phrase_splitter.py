"""Unit tests for ``tools/phrase_splitter``.

Covers the small set of pure helpers that the evaluator and re-splitter
both depend on. The CLIs themselves are exercised by the skill-creator
eval loop and by the smoke-test in ``tools/README.md`` rather than by
unittest.
"""

import json
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
    extract_boundary_features,
    extract_phrase_features,
    extract_verse_features,
    slice_phrases,
)
from phrase_splitter.prompts import format_split_prompt

from evaluate_phrases import (
    DEFAULT_MIN_SCORE,
    REFERENCE_SET_PATH,
    calibration_results,
    check_verse,
    run_calibration,
    validate_reference_set,
)
from phrase_splitter.apibible import DEFAULT_DB_PATH, DEFAULT_NKJV_ID

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
from split_phrases import _render_current_split, _render_signals, _validate
from phrase_splitter.apibible import extract_chapter_text, extract_chapter_verses
from phrase_splitter.prompts import format_judge_prompt


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


def T(text):
    return text.split()


class PhraseFeatureTests(unittest.TestCase):
    def test_weak_connector_start(self):
        feat = extract_phrase_features(T("and of the things which"), position="middle")
        self.assertEqual(feat["word_count"], 5)
        self.assertTrue(feat["starts_with_weak_connector"])

    def test_pause_punct_at_end(self):
        feat = extract_phrase_features(["our", "brother,"], position="middle")
        self.assertTrue(feat["ends_in_pause_punct"])
        self.assertFalse(feat["ends_mid_clause"])

    def test_mid_clause_ending(self):
        feat = extract_phrase_features(["the", "kingdom", "of"], position="first")
        self.assertTrue(feat["ends_mid_clause"])
        self.assertFalse(feat["ends_in_pause_punct"])

    def test_internal_pause(self):
        feat = extract_phrase_features(T("Paul, called to be"), position="first")
        self.assertTrue(feat["contains_internal_pause"])

    def test_removed_meaning_load_fields(self):
        feat = extract_phrase_features(T("Paul, called to be"), position="first")
        for gone in ("content_word_count", "function_ratio", "cognitive_overload",
                     "word_overload", "stub_phrase", "syllable_count"):
            self.assertNotIn(gone, feat)


class PausePointTests(unittest.TestCase):
    def kinds(self, text, position="middle"):
        feat = extract_phrase_features(T(text), position=position)
        return {(pp["index"], pp["kind"]) for pp in feat["pause_points"]}, feat

    def test_relative_in_long_run(self):
        # Judges 2:16, a 17-word phrase the review split before "who".
        points, feat = self.kinds(
            "Nevertheless, the Lord raised up judges who delivered them out of "
            "the hand of those who plundered them."
        )
        self.assertIn((6, "relative"), points)
        self.assertGreater(feat["long_run"], 0.9)

    def test_internal_comma(self):
        points, _ = self.kinds("piercing even to the division of soul and spirit, and of joints")
        self.assertIn((9, "punct"), points)

    def test_that_after_content_verb(self):
        points, _ = self.kinds("The man departed and told the Jews that it was Jesus")
        self.assertIn((7, "content_clause"), points)

    def test_long_run_without_pause_is_reduced(self):
        _, with_pause = self.kinds(
            "Nevertheless, the Lord raised up judges who delivered them out of "
            "the hand of those who plundered them."
        )
        _, without = self.kinds("a b c d e f g h i j k l m n o p q")
        self.assertGreater(without["long_run"], 0.0)
        self.assertLess(without["long_run"], with_pause["long_run"])

    def test_ten_words_with_comma_counts(self):
        # John 5:7's last phrase; the review split it at the comma.
        _, feat = self.kinds("but while I am coming, another steps down before me.”", "last")
        self.assertGreater(feat["long_run"], 0.0)

    def test_short_lead_in_draws_nothing(self):
        _, feat = self.kinds("For this reason", "first")
        self.assertEqual(feat["long_run"], 0.0)
        self.assertEqual(feat["pause_points"], [])

    def test_whole_short_verse_stays_quiet(self):
        feats = extract_verse_features(T("Jesus wept."), [2])
        self.assertEqual(composite_signal_score(feats), 0.0)


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

    def test_relative_cut_in_long_run_is_fine(self):
        # John 5:15 and Judges 2:16: the review cut long runs at exactly
        # these cues, so severance is gated on the run being short.
        told = extract_boundary_features(
            T("The man departed and told the Jews"), T("that it was Jesus who had made him well.")
        )
        judges = extract_boundary_features(
            T("Nevertheless, the Lord raised up judges"),
            T("who delivered them out of the hand of those who plundered them."),
        )
        self.assertEqual(told["boundary_severance"], 0.0)
        self.assertEqual(judges["boundary_severance"], 0.0)

    def test_short_next_intensifies_severance(self):
        # "nothing was made / that was made." (3w next) should score
        # higher than "told the Jews / that it was Jesus..." (10w next).
        short_next = extract_boundary_features(
            ["nothing", "was", "made"], ["that", "was", "made."]
        )
        long_next = extract_boundary_features(
            ["nothing", "was", "made"], ["that", "was", "made", "in", "the", "beginning"]
        )
        self.assertGreater(short_next["boundary_severance"], long_next["boundary_severance"])


class NoPauseCueTests(unittest.TestCase):
    def test_cut_inside_run_fires(self):
        # 2 Corinthians 11:24's rejected "From the Jews / five times …".
        feat = extract_boundary_features(T("From the Jews"), T("five times I received"))
        self.assertGreater(feat["no_pause_cue"], 0.0)

    def test_clause_edge_after_does_not_fire(self):
        feat = extract_boundary_features(T("for the hour is coming"), T("in which all who are"))
        self.assertEqual(feat["no_pause_cue"], 0.0)
        # "when" is a clause edge: research R4's known limit.
        feat = extract_boundary_features(T("into the pool"), T("when the water is stirred up;"))
        self.assertEqual(feat["no_pause_cue"], 0.0)

    def test_punctuation_before_does_not_fire(self):
        feat = extract_boundary_features(T("See, you have been made well."), T("Sin no more,"))
        self.assertEqual(feat["no_pause_cue"], 0.0)

    def test_sentence_opening_lead_in_does_not_fire(self):
        # John 5:16: "For this reason" keeps its own chunk (FR-008).
        feats = extract_verse_features(
            T("For this reason the Jews persecuted Jesus, and sought to kill Him,"), [3, 4, 5]
        )
        self.assertEqual(feats["boundaries"][0]["no_pause_cue"], 0.0)
        self.assertLess(composite_signal_score(feats), 0.2)


class LineBreakTests(unittest.TestCase):
    def test_capital_function_word_mid_phrase(self):
        feat = extract_phrase_features(
            T("That it may give seed to the sower And bread to the eater,"), position="last"
        )
        self.assertTrue(feat["lost_line_break"])
        self.assertIn((8, "line_break"),
                      {(pp["index"], pp["kind"]) for pp in feat["pause_points"]})

    def test_divine_pronouns_and_titles_do_not_count(self):
        for text in ("and has given Him authority", "for You are with me",
                     "the voice of the Lord Your God", "by the Holy Spirit", "then I said"):
            feat = extract_phrase_features(T(text), position="middle")
            self.assertFalse(feat["lost_line_break"], text)

    def test_capital_after_terminal_punct_does_not_count(self):
        feat = extract_phrase_features(T("Do what is good. And you will have praise"), "middle")
        self.assertFalse(feat["lost_line_break"])


class ListTests(unittest.TestCase):
    PLEASURE = T("Therefore I take pleasure in infirmities, in reproaches, in needs, "
                 "in persecutions, in distresses, for Christ’s sake.")

    def kinds(self, feats):
        return {lb["kind"] for lb in feats["list_breaks"]}

    def test_word_list_cut_internally(self):
        feats = extract_verse_features(self.PLEASURE, [4, 4, 6, 3])
        self.assertIn("word_list_cut", self.kinds(feats))

    def test_lead_in_merged_with_list(self):
        feats = extract_verse_features(self.PLEASURE, [14, 3])
        self.assertIn("lead_in_merged", self.kinds(feats))

    def test_agreed_list_split_is_quiet(self):
        feats = extract_verse_features(self.PLEASURE, [4, 10, 3])
        self.assertEqual(feats["list_breaks"], [])

    def test_short_lead_in_stays_with_list(self):
        feats = extract_verse_features(T("that any people, nation, or language which speaks"), [6, 3])
        self.assertEqual(feats["list_breaks"], [])

    def test_fixed_trio_draws_nothing(self):
        feats = extract_verse_features(T("who took up Shadrach, Meshach, and Abed-Nego."), [7])
        self.assertEqual(feats["list_breaks"], [])

    def test_cut_where_items_lengthen_is_fine(self):
        # Romans 9:4, agreed split C.
        feats = extract_verse_features(
            T("who are Israelites, to whom pertain the adoption, the glory, the covenants, "
              "the giving of the law, the service of God, and the promises;"),
            [3, 3, 6, 12],
        )
        self.assertNotIn("word_list_cut", self.kinds(feats))

    def test_clause_items_merged(self):
        feats = extract_verse_features(
            T("piercing even to the division of soul and spirit, and of joints and marrow,"), [14]
        )
        self.assertIn("clause_items_merged", self.kinds(feats))


class ParallelTests(unittest.TestCase):
    COR = T("Therefore I make known to you that no one speaking by the Spirit of God calls "
            "Jesus accursed, and no one can say that Jesus is Lord except by the Holy Spirit.")

    def test_one_half_split_fires(self):
        feats = extract_verse_features(self.COR, [6, 12, 9, 5])
        self.assertGreater(feats["parallel_asymmetry"], 0.0)

    def test_both_whole_is_quiet(self):
        feats = extract_verse_features(self.COR, [6, 12, 14])
        self.assertEqual(feats["parallel_asymmetry"], 0.0)

    def test_matching_cuts_are_quiet(self):
        heb = T("For if they did not escape who refused Him who spoke on earth, much more "
                "shall we not escape if we turn away from Him who speaks from heaven,")
        self.assertEqual(extract_verse_features(heb, [5, 7, 5, 9])["parallel_asymmetry"], 0.0)
        self.assertEqual(extract_verse_features(heb, [12, 14])["parallel_asymmetry"], 0.0)


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
        self.assertIn("honest best split", out)
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

    def test_bare_relative_raises_score(self):
        feats = extract_verse_features(
            ["nothing", "was", "made", "that", "was", "made."], [3, 3]
        )
        # boundary_severance contributes most of the score.
        self.assertGreater(composite_signal_score(feats), 0.3)

    def test_stranded_stub_raises_score(self):
        # "But one / and the same Spirit works,": cut inside one run.
        feats = extract_verse_features(T("But one and the same Spirit works,"), [2, 5])
        self.assertGreater(composite_signal_score(feats), 0.3)

    def test_long_run_raises_score(self):
        feats = extract_verse_features(
            T("Nevertheless, the Lord raised up judges who delivered them out of the hand "
              "of those who plundered them."), [17]
        )
        self.assertGreater(composite_signal_score(feats), 0.2)

    def test_missing_split_raises_score(self):
        # 22-token single-phrase verse: missing_split saturates at 1.0
        # → 0.3 * 1.0 = 0.3. The tokens are all function words ("a"),
        # so no other signals contribute.
        feats = extract_verse_features(
            ["a"] * 22, [22]
        )
        score = composite_signal_score(feats)
        self.assertGreater(score, 0.25)

    def test_composite_clamped_to_one(self):
        # Pathological verse: all signals max out.
        feats = extract_verse_features(
            ["nothing", "was", "made", "that"], [1, 3]
        )
        score = composite_signal_score(feats)
        self.assertLessEqual(score, 1.0)


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
            ["nothing", "was", "made", "that", "was", "made."], [3, 3]
        )
        rendered = _render_signals(feats)
        # Header line with verse-level metrics
        self.assertIn("tokens=6", rendered)
        self.assertIn("phrases=2", rendered)
        # Per-boundary line names the severance kind and value
        self.assertIn("bare_relative", rendered)
        self.assertIn("severance=", rendered)
        # Composite score is displayed
        self.assertIn("composite=", rendered)


class RenderSignalsTests(unittest.TestCase):
    def test_new_signals_are_named(self):
        feats = extract_verse_features(
            T("Nevertheless, the Lord raised up judges who delivered them out of the hand "
              "of those who plundered them."), [17]
        )
        rendered = _render_signals(feats)
        self.assertIn("long_run=", rendered)
        self.assertIn("pause_points=relative@'who'", rendered)

    def test_boundary_and_verse_signals_are_named(self):
        cor = T("Therefore I make known to you that no one speaking by the Spirit of God calls "
                "Jesus accursed, and no one can say that Jesus is Lord except by the Holy Spirit.")
        rendered = _render_signals(extract_verse_features(cor, [6, 12, 9, 5]))
        self.assertIn("parallel_asymmetry=", rendered)
        rendered = _render_signals(extract_verse_features(T("He said this, and the man went"), [5, 2]))
        self.assertIn("no_pause_cue=", rendered)
        rendered = _render_signals(extract_verse_features(ListTests.PLEASURE, [4, 4, 6, 3]))
        self.assertIn("list_breaks: word_list_cut", rendered)
        rendered = _render_signals(extract_verse_features(
            T("That it may give seed to the sower And bread to the eater,"), [12]))
        self.assertIn("lost_line_break", rendered)


class DisplayTextTests(unittest.TestCase):
    # John 5:28-29 as api.bible serves it: the dash sits between spans.
    HTML = (
        '<p class="p"><span data-number="28" data-sid="JHN 5:28" class="v">28</span>'
        '<span class="wj">Do not marvel at this; for the hour is coming in which all who are '
        'in the graves will hear His voice </span>'
        '<span data-number="29" data-sid="JHN 5:29" class="v">29</span>'
        '<span class="wj">and come forth—</span><span class="wj">those who have done good, '
        'to the resurrection of life, and those who have done evil, to the resurrection of '
        'condemnation.</span></p>'
    )

    def test_dash_kept_in_display_text(self):
        text = extract_chapter_text(self.HTML, "John", 5)[29]
        self.assertIn("come forth—those who", text)

    def test_tokens_unchanged(self):
        tokens = extract_chapter_verses(self.HTML, "John", 5)[29]
        self.assertEqual(tokens[:4], ["and", "come", "forth", "those"])
        self.assertEqual(len(tokens), 24)

    def test_no_markup_or_dash_matches_tokens(self):
        self.assertEqual(
            extract_chapter_text(self.HTML, "John", 5)[28],
            " ".join(extract_chapter_verses(self.HTML, "John", 5)[28]),
        )


class ReplyValidationTests(unittest.TestCase):
    TOKENS = extract_chapter_verses(DisplayTextTests.HTML, "John", 5)[29]
    TAIL = ["those who have done good, to the resurrection of life,",
            "and those who have done evil, to the resurrection of condemnation."]

    def test_dash_kept_dropped_or_spaced(self):
        for head in ("and come forth—", "and come forth", "and come forth —"):
            errors, counts = _validate([head] + self.TAIL, self.TOKENS)
            self.assertEqual(errors, [], head)
            self.assertEqual(counts, [3, 10, 11])

    def test_dash_inside_phrase(self):
        errors, counts = _validate(
            ["and come forth—those who have done good, to the resurrection of life,",
             self.TAIL[1]], self.TOKENS)
        self.assertEqual(errors, [])
        self.assertEqual(counts, [13, 11])

    def test_straight_quotes_accepted(self):
        tokens = ["He", "said,", "“Follow", "Me.”"]
        errors, counts = _validate(['He said,', '"Follow Me."'], tokens)
        self.assertEqual(errors, [])
        self.assertEqual(counts, [2, 2])

    def test_paraphrase_rejected(self):
        errors, _ = _validate(["and came forth"] + self.TAIL, self.TOKENS)
        self.assertTrue(errors)

    def test_word_count_mismatch_rejected(self):
        errors, _ = _validate(["and come forth"] + self.TAIL[:1], self.TOKENS)
        self.assertTrue(errors)


class ReferenceSetValidationTests(unittest.TestCase):
    def _entry(self, **kw):
        entry = {"ref": "John 5:5", "deck": "data/4-john.json", "agreed": [6, 6],
                 "confidence": "agreed"}
        entry.update(kw)
        return entry

    def test_valid_entry(self):
        self.assertEqual(validate_reference_set([self._entry()], {"John 5:5": 12}), [])

    def test_agreed_sum_mismatch_names_ref(self):
        errors = validate_reference_set([self._entry(agreed=[6, 5])], {"John 5:5": 12})
        self.assertEqual(len(errors), 1)
        self.assertIn("John 5:5", errors[0])

    def test_rejected_sum_mismatch(self):
        entry = self._entry(rejected=[{"counts": [3, 3], "reason": "x"}])
        self.assertEqual(len(validate_reference_set([entry], {"John 5:5": 12})), 1)

    def test_rejected_equal_to_agreed(self):
        entry = self._entry(rejected=[{"counts": [6, 6], "reason": "x"}])
        self.assertEqual(len(validate_reference_set([entry], {"John 5:5": 12})), 1)

    def test_duplicate_ref(self):
        errors = validate_reference_set([self._entry(), self._entry()], {"John 5:5": 12})
        self.assertEqual(len(errors), 1)

    def test_unresolved_still_validated(self):
        entry = self._entry(confidence="unresolved", agreed=[1])
        self.assertEqual(len(validate_reference_set([entry], {"John 5:5": 12})), 1)

    def test_committed_reference_set_parses(self):
        with open(REFERENCE_SET_PATH, encoding="utf-8") as f:
            entries = json.load(f)
        self.assertTrue(entries)
        self.assertEqual(len({e["ref"] for e in entries}), len(entries))


class CalibrationResultTests(unittest.TestCase):
    def test_classifies_changed_and_kept(self):
        entries = [
            {"ref": "A 1:1", "agreed": [2, 2], "confidence": "agreed"},
            {"ref": "A 1:2", "agreed": [4], "confidence": "agreed"},
            {"ref": "A 1:3", "agreed": [4], "confidence": "unresolved"},
        ]
        deck_counts = {"A 1:1": [4], "A 1:2": [4], "A 1:3": [2, 2]}
        records = {
            "A 1:1": {"signal_score": 0.5, "signals": {}},
            "A 1:2": {"signal_score": 0.5, "signals": {}},
            "A 1:3": {"signal_score": 0.0, "signals": {}},
        }
        results = {r["ref"]: r for r in calibration_results(entries, deck_counts, records, 0.2)}
        self.assertEqual(results["A 1:1"]["state"], "changed")
        self.assertTrue(results["A 1:1"]["ok"])
        self.assertEqual(results["A 1:2"]["state"], "kept")
        self.assertFalse(results["A 1:2"]["ok"])
        self.assertNotIn("A 1:3", results)



@unittest.skipUnless(
    os.path.exists(os.path.join(REPO_ROOT, DEFAULT_DB_PATH)),
    f"api.bible cache not at {DEFAULT_DB_PATH}; see tools/README.md",
)
class CalibrationTests(unittest.TestCase):
    """SC-001 and SC-006 against the committed reference set and decks."""

    @classmethod
    def setUpClass(cls):
        cwd = os.getcwd()
        os.chdir(REPO_ROOT)
        try:
            cls.run_result = run_calibration(DEFAULT_DB_PATH, DEFAULT_NKJV_ID, DEFAULT_MIN_SCORE)
        finally:
            os.chdir(cwd)

    def test_reference_set_matches_canonical_text(self):
        self.assertEqual(self.run_result["errors"], [])

    def test_every_agreed_change_is_flagged(self):
        missed = [
            r["ref"] for r in self.run_result["results"]
            if r["confidence"] == "agreed" and r["state"] == "changed" and not r["ok"]
        ]
        self.assertEqual(missed, [])


if __name__ == "__main__":
    unittest.main()
