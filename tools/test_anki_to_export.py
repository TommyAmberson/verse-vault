"""Unit tests for ``tools/anki_to_export.py`` - no fixture colpkg
needed; we drive the field-parsing + kind-translation helpers directly
against synthesised inputs. The real colpkg integration is exercised
manually via ``python3 tools/anki_to_export.py ...``."""

import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from anki_to_export import (  # noqa: E402
    ANKI_FIELD_SEP,
    EASE_TO_GRADE,
    GRADUATED_QUEUES,
    REVLOG_TYPES_TO_KEEP,
    VERSE_ORD_TO_KIND,
    build_heading_index,
    build_verse_index,
    parse_heading_fields,
    parse_kvl_fields,
    parse_verse_fields,
    resolve_note,
    tier_name,
)


def f(*parts: str) -> str:
    return ANKI_FIELD_SEP.join(parts)


class VerseFieldsTests(unittest.TestCase):
    def test_parses_ref_field(self):
        flds = f("8-01-001-003-", "Luke 1:3", "text", "ftv", "150")
        self.assertEqual(parse_verse_fields(flds), ("Luke", 1, 3))

    def test_returns_none_on_bad_ref(self):
        flds = f("sort", "no colon here", "text", "ftv", "150")
        self.assertIsNone(parse_verse_fields(flds))

    def test_returns_none_on_short_fields(self):
        self.assertIsNone(parse_verse_fields("only-one-field"))


class HeadingFieldsTests(unittest.TestCase):
    def test_parses_sort_and_front(self):
        flds = f("2-01-001-018,001-025,", "Matthew ", "Christ Born of Mary", "")
        self.assertEqual(parse_heading_fields(flds), ("Matthew", 1, 18))

    def test_returns_none_when_sort_malformed(self):
        flds = f("malformed-sort", "Matthew", "title", "")
        self.assertIsNone(parse_heading_fields(flds))

    def test_returns_none_when_front_empty(self):
        flds = f("2-01-001-018,001-025,", "", "title", "")
        self.assertIsNone(parse_heading_fields(flds))


class KVLFieldsTests(unittest.TestCase):
    def test_parses_chapter_and_tier(self):
        flds = f("8-01-001_150_", "Luke 1 (150)", "3, 4, 13", "150")
        self.assertEqual(parse_kvl_fields(flds), ("Luke", 1, 150))

    def test_returns_none_on_missing_tier(self):
        flds = f("sort", "Luke 1 (150)", "verses", "")
        self.assertIsNone(parse_kvl_fields(flds))

    def test_handles_two_word_book_names(self):
        flds = f("sort", "1 Corinthians 12 (300)", "11", "300")
        self.assertEqual(parse_kvl_fields(flds), ("1 Corinthians", 12, 300))


class TierNameTests(unittest.TestCase):
    def test_known_tiers(self):
        self.assertEqual(tier_name(150), "Club150")
        self.assertEqual(tier_name(300), "Club300")

    def test_unknown_tier_is_empty(self):
        # Empty string signals "drop the event" upstream.
        self.assertEqual(tier_name(999), "")


class IndexBuildingTests(unittest.TestCase):
    def test_verse_index_uses_array_position(self):
        deck = {
            "verses": [
                {"book": "John", "chapter": 1, "verse": 1},
                {"book": "John", "chapter": 1, "verse": 2},
                {"book": "John", "chapter": 1, "verse": 3},
            ]
        }
        idx = build_verse_index(deck)
        self.assertEqual(idx[("John", 1, 2)], 1)
        self.assertEqual(idx[("John", 1, 3)], 2)

    def test_heading_index_uses_array_position(self):
        deck = {
            "headings": [
                {"book": "John", "startChapter": 1, "startVerse": 1, "endChapter": 1, "endVerse": 5},
                {"book": "John", "startChapter": 1, "startVerse": 6, "endChapter": 1, "endVerse": 13},
            ]
        }
        idx = build_heading_index(deck)
        self.assertEqual(idx[("John", 1, 1)], 0)
        self.assertEqual(idx[("John", 1, 6)], 1)


class ResolveNoteTests(unittest.TestCase):
    def setUp(self):
        deck = {
            "verses": [
                {"book": "John", "chapter": 1, "verse": 1},
                {"book": "John", "chapter": 1, "verse": 2},
            ],
            "headings": [
                {"book": "John", "startChapter": 1, "startVerse": 1, "endChapter": 1, "endVerse": 5},
            ],
        }
        self.verse_indexes = {"nkjv-john": build_verse_index(deck)}
        self.heading_indexes = {"nkjv-john": build_heading_index(deck)}

    def test_verse_reference_resolves_to_citation(self):
        flds = f("sort", "John 1:1", "text", "ftv", "150")
        out = resolve_note("Verse", 0, flds, self.verse_indexes, self.heading_indexes)
        self.assertEqual(out, ("nkjv-john", {"kind": "Citation", "verseId": 0}))

    def test_verse_quote_resolves_to_recitation(self):
        flds = f("sort", "John 1:2", "text", "ftv", "150")
        out = resolve_note("Verse", 1, flds, self.verse_indexes, self.heading_indexes)
        self.assertEqual(out, ("nkjv-john", {"kind": "Recitation", "verseId": 1}))

    def test_verse_ftv_default_no_citation(self):
        flds = f("sort", "John 1:1", "text", "ftv", "150")
        out = resolve_note("Verse", 2, flds, self.verse_indexes, self.heading_indexes)
        self.assertEqual(
            out, ("nkjv-john", {"kind": "Ftv", "verseId": 0, "withCitation": False})
        )

    def test_heading_both_ords_collapse_to_same_cardref(self):
        # Verse-vault treats both Anki Heading template ords as the
        # same HeadingPassage card; clientEventId dedup handles dupes.
        flds = f("2-01-001-001,001-005,", "John ", "title", "")
        a = resolve_note("Heading", 0, flds, self.verse_indexes, self.heading_indexes)
        b = resolve_note("Heading", 1, flds, self.verse_indexes, self.heading_indexes)
        self.assertEqual(a, ("nkjv-john", {"kind": "HeadingPassage", "headingIdx": 0}))
        self.assertEqual(a, b)

    def test_kvl_emits_chapter_club_list(self):
        flds = f("sort", "John 1 (150)", "verses", "150")
        out = resolve_note(
            "Key Verse List", 0, flds, self.verse_indexes, self.heading_indexes
        )
        self.assertEqual(
            out,
            (
                "nkjv-john",
                {"kind": "ChapterClubList", "book": "John", "chapter": 1, "tier": "Club150"},
            ),
        )

    def test_unresolved_verse_returns_none(self):
        # No verse with this reference in the deck.
        flds = f("sort", "John 99:99", "text", "ftv", "150")
        out = resolve_note("Verse", 0, flds, self.verse_indexes, self.heading_indexes)
        self.assertIsNone(out)

    def test_unknown_notetype_returns_none(self):
        out = resolve_note(
            "Books", 0, "any\x1ffields", self.verse_indexes, self.heading_indexes
        )
        self.assertIsNone(out)


class ConstantTests(unittest.TestCase):
    def test_verse_ord_table(self):
        self.assertEqual(VERSE_ORD_TO_KIND, {0: "Citation", 1: "Recitation", 2: "Ftv"})

    def test_ease_to_grade_is_identity(self):
        self.assertEqual(EASE_TO_GRADE, {1: 1, 2: 2, 3: 3, 4: 4})

    def test_revlog_types_kept(self):
        # learn / review / relearn — cram and manual reset dropped.
        self.assertEqual(set(REVLOG_TYPES_TO_KEEP), {0, 1, 2})

    def test_graduated_queues(self):
        # Anki review (2) + day-learn/relearn (3) = "in long-term rotation".
        self.assertEqual(set(GRADUATED_QUEUES), {2, 3})


if __name__ == "__main__":
    unittest.main()
