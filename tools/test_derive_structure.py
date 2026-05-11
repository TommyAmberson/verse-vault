#!/usr/bin/env python3
"""Unit tests for tools/derive_structure.py.

Run: python3 -m unittest tools/test_derive_structure.py
"""

import unittest

from derive_structure import (
    annotation_kind,
    derive_heading,
    derive_material,
    derive_verse,
    strip_markup,
)


class StripMarkupTests(unittest.TestCase):
    def test_no_markup(self):
        self.assertEqual(strip_markup("Paul,"), "Paul,")

    def test_bold(self):
        self.assertEqual(strip_markup("<b>Sosthenes</b>"), "Sosthenes")

    def test_bold_italic(self):
        self.assertEqual(strip_markup("<b><i>cross</i></b>"), "cross")

    def test_small_caps_span(self):
        # "Lord" with mid-word small-caps span for the YHWH typography.
        self.assertEqual(
            strip_markup('L<span style="font-variant: small-caps;">ord</span>.'),
            "Lord.",
        )


class AnnotationKindTests(unittest.TestCase):
    def test_plain(self):
        self.assertIsNone(annotation_kind("Paul,"))

    def test_bold(self):
        self.assertEqual(annotation_kind("<b>Sosthenes</b>"), "bold")

    def test_italic(self):
        self.assertEqual(annotation_kind("<i>cross</i>"), "italic")

    def test_bold_italic(self):
        self.assertEqual(annotation_kind("<b><i>cross</i></b>"), "boldItalic")

    def test_italic_bold(self):
        self.assertEqual(annotation_kind("<i><b>cross</b></i>"), "boldItalic")

    def test_small_caps_alone_is_not_an_annotation(self):
        # Small-caps comes from NKJV's editorial typography, not user
        # annotation. The api.bible cache supplies it at render time.
        self.assertIsNone(
            annotation_kind('L<span style="font-variant: small-caps;">ord</span>.')
        )


class DeriveVerseTests(unittest.TestCase):
    def test_spec_example(self):
        verse = {
            "book": "1 Corinthians",
            "chapter": 1,
            "verse": 1,
            "text": (
                "Paul, called to be an apostle of Jesus Christ through the will "
                "of God, and <b>Sosthenes</b> our brother,"
            ),
            "ftv": "Paul, called",
            "clubs": [300],
            "phrases": [
                "Paul, called to be an apostle of Jesus Christ through the will of God,",
                "and <b>Sosthenes</b> our brother,",
            ],
        }
        out = derive_verse(verse)
        # Phrase 0 = "Paul, called to be an apostle of Jesus Christ through
        # the will of God," → 14 words. Phrase 1 = "and Sosthenes our
        # brother," → 4 words. Sosthenes is verse word index 15.
        self.assertEqual(out["phraseWordCounts"], [14, 4])
        self.assertEqual(out["annotations"], [{"wordIndex": 15, "kind": "bold"}])
        self.assertEqual(out["ftvWordCount"], 2)
        self.assertEqual(out["clubs"], [300])
        self.assertEqual(out["book"], "1 Corinthians")
        self.assertEqual(out["chapter"], 1)
        self.assertEqual(out["verse"], 1)

    def test_bold_italic_annotation(self):
        verse = {
            "book": "X",
            "chapter": 1,
            "verse": 1,
            "text": "the <b><i>cross</i></b> of Christ",
            "ftv": "",
            "clubs": [],
            "phrases": ["the <b><i>cross</i></b> of Christ"],
        }
        out = derive_verse(verse)
        self.assertEqual(out["phraseWordCounts"], [4])
        self.assertEqual(out["annotations"], [{"wordIndex": 1, "kind": "boldItalic"}])

    def test_ftv_only_when_prefix_matches(self):
        verse = {
            "book": "X", "chapter": 1, "verse": 1,
            "text": "For God so loved",
            "ftv": "For God",
            "clubs": [],
            "phrases": ["For God so loved"],
        }
        out = derive_verse(verse)
        self.assertEqual(out["ftvWordCount"], 2)

    def test_ftv_dropped_when_prefix_invariant_violated(self):
        verse = {
            "book": "X", "chapter": 1, "verse": 1,
            "text": "For God so loved",
            "ftv": "Different words",
            "clubs": [],
            "phrases": ["For God so loved"],
        }
        out = derive_verse(verse)
        self.assertIsNone(out["ftvWordCount"])

    def test_empty_verse(self):
        verse = {
            "book": "X", "chapter": 1, "verse": 1,
            "text": "", "ftv": "", "clubs": [], "phrases": [],
        }
        out = derive_verse(verse)
        self.assertEqual(out["phraseWordCounts"], [])
        self.assertEqual(out["annotations"], [])
        self.assertIsNone(out["ftvWordCount"])

    def test_small_caps_is_one_word(self):
        # "in the Lord" with NKJV LORD typography; "Lord." is one
        # whitespace token, no annotation.
        verse = {
            "book": "X", "chapter": 1, "verse": 1,
            "text": 'in the L<span style="font-variant: small-caps;">ord</span>.',
            "ftv": "",
            "clubs": [],
            "phrases": ['in the L<span style="font-variant: small-caps;">ord</span>.'],
        }
        out = derive_verse(verse)
        self.assertEqual(out["phraseWordCounts"], [3])
        self.assertEqual(out["annotations"], [])

    def test_multiple_annotations_in_one_phrase(self):
        verse = {
            "book": "X", "chapter": 1, "verse": 1,
            "text": "the <b>first</b> and the <i>second</i>",
            "ftv": "",
            "clubs": [],
            "phrases": ["the <b>first</b> and the <i>second</i>"],
        }
        out = derive_verse(verse)
        self.assertEqual(out["phraseWordCounts"], [5])
        self.assertEqual(
            out["annotations"],
            [
                {"wordIndex": 1, "kind": "bold"},
                {"wordIndex": 4, "kind": "italic"},
            ],
        )

    def test_word_index_continues_across_phrases(self):
        verse = {
            "book": "X", "chapter": 1, "verse": 1,
            "text": "alpha beta gamma <b>delta</b>",
            "ftv": "",
            "clubs": [],
            "phrases": ["alpha beta", "gamma <b>delta</b>"],
        }
        out = derive_verse(verse)
        self.assertEqual(out["phraseWordCounts"], [2, 2])
        # delta is the 4th word (index 3), in phrase 1 at sub-index 1.
        self.assertEqual(out["annotations"], [{"wordIndex": 3, "kind": "bold"}])


class DeriveHeadingTests(unittest.TestCase):
    def test_drops_text(self):
        h = {
            "text": "Greeting",
            "book": "1 Corinthians",
            "start_chapter": 1, "start_verse": 1,
            "end_chapter": 1, "end_verse": 4,
        }
        out = derive_heading(h)
        self.assertNotIn("text", out)
        self.assertEqual(out, {
            "book": "1 Corinthians",
            "startChapter": 1, "startVerse": 1,
            "endChapter": 1, "endVerse": 4,
        })


class DeriveMaterialTests(unittest.TestCase):
    def test_full_material_round_trip(self):
        data = {
            "year": 3,
            "books": ["1 Corinthians"],
            "chapters": [{"book": "1 Corinthians", "number": 1, "start_verse": 1, "end_verse": 1}],
            "verses": [{
                "book": "1 Corinthians", "chapter": 1, "verse": 1,
                "text": "alpha <b>beta</b>",
                "ftv": "alpha",
                "clubs": [150],
                "phrases": ["alpha <b>beta</b>"],
            }],
            "headings": [{
                "text": "Greeting", "book": "1 Corinthians",
                "start_chapter": 1, "start_verse": 1,
                "end_chapter": 1, "end_verse": 1,
            }],
        }
        out, warnings = derive_material(data)
        self.assertEqual(warnings, [])
        self.assertEqual(out["year"], 3)
        self.assertEqual(out["books"], ["1 Corinthians"])
        self.assertEqual(len(out["verses"]), 1)
        self.assertEqual(out["verses"][0]["phraseWordCounts"], [2])
        self.assertEqual(out["verses"][0]["annotations"], [{"wordIndex": 1, "kind": "bold"}])
        self.assertEqual(out["verses"][0]["ftvWordCount"], 1)
        self.assertEqual(len(out["headings"]), 1)
        self.assertNotIn("text", out["headings"][0])


if __name__ == "__main__":
    unittest.main()
