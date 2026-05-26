use serde::{Deserialize, Serialize};

use crate::element::{ClubTier, ElementId};
use crate::test_kind::{TestKey, TestKind};
use crate::types::CardId;

/// Per-user lifecycle state of a card.
///
/// `New` means the card exists in the user's deck but has not been
/// introduced yet via the memorize session — `/review` should skip it.
/// `Active` means it has been introduced and FSRS scheduling governs when
/// it surfaces.
///
/// The relearning of failed reviews is handled by a session-level priority
/// lane (slice 2), not by a discrete `Relearning` state — FSRS already
/// produces the short post-lapse intervals.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum CardState {
    New,
    Active,
}

/// What this card asks the learner. Atomic kinds contain exactly one test;
/// composite kinds (`Recitation`, `Citation`, `Ftv`) contain several. The
/// exact set is computed by `Card::tests`. A review submits a single grade
/// per card; composite cards distribute it via the engine's Bayesian-share
/// decomposition.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum CardKind {
    // atomic — each contains exactly one test
    PhraseFill {
        position: u16,
    },
    VerseAtVerseRef,
    VerseInChapter,
    VerseInBook,
    VerseInHeading {
        heading_idx: u16,
    },
    VerseInClub {
        tier: ClubTier,
    },
    // composite — each contains many tests
    /// Whole-verse recitation. Contains every phrase plus the citation
    /// triple (verseref position, chapter binding, book binding) — the
    /// "say it all" card.
    Recitation,
    Citation,
    Ftv {
        with_citation: bool,
    },
    /// "List the tier-T verses in this chapter." Composite card that
    /// grades the per-verse `VerseClubBinding` for every real verse in
    /// the chapter tagged with `tier`. The card itself is anchored to a
    /// pseudo verse_id (allocated by the builder after the real verses)
    /// whose `VerseAtoms` carries the member verse_ids.
    ChapterClubList {
        tier: ClubTier,
    },
    /// "What heading is this passage under?" Composite card that shows
    /// every real verse in the heading's range and grades the
    /// `VerseHeadingBinding` for each. Anchored to a pseudo verse_id
    /// whose `VerseAtoms.heading_members` carries the member verse_ids.
    /// Pairs with the atomic `VerseInHeading` ("which heading is *this*
    /// verse in?") and serves as the passage-cued reverse: same binding
    /// is graded, but the cue is the whole passage rather than one
    /// verse — so the two cards share `TestState` on each member's
    /// binding.
    HeadingPassage {
        heading_idx: u16,
    },
    /// UX-only: progressive-reveal entry that shows the verse text to the
    /// learner. Carries no FSRS state and is never emitted by `builder::build`;
    /// it only appears in `Session::new_verse_progression`.
    Reading,
}

/// One reviewable item, scoped to a single verse. The `(kind, verse_id)`
/// pair plus the verse's `VerseAtoms` fully determines which tests this
/// card grades (`Card::tests`).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Card {
    pub id: CardId,
    pub kind: CardKind,
    pub verse_id: u32,
    pub state: CardState,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CardSchedule {
    pub card_id: CardId,
    pub due_r: f32,
    pub due_date_secs: i64,
    pub priority: f32,
}

#[derive(Debug, Clone, Default)]
pub struct VerseAtoms {
    pub verse_id: u32,
    pub phrase_count: u16,
    /// Cumulative-sum half-open word ranges `[start, end)` per phrase
    /// position. Drives the content-stable `ElementId::Phrase` keys:
    /// when splits change, phrases that survive carry FSRS state via
    /// matching ranges; phrases whose boundaries shift get fresh
    /// state. Length always matches `phrase_count`.
    pub phrase_ranges: Vec<(u16, u16)>,
    pub headings: Vec<u16>,
    pub clubs: Vec<ClubTier>,
    /// Word count of the FTV prompt, or None when this verse has no FTV.
    pub ftv_word_count: Option<u16>,
    /// Word count of phrase 0, used to detect the equals-whole-phrase case
    /// where we'd otherwise schedule a redundant phrase-0 test (the FTV
    /// prompt already shows phrase 0 in full).
    pub phrase_zero_word_count: u16,
    /// For pseudo verses anchoring `ChapterClubList` cards: the
    /// (verse_id, most-specific tier) of every real verse in the same
    /// chapter whose tier matches the card's exactly. A Club300
    /// chapter card therefore lists only the chapter's Club300-tagged
    /// verses (the 150 verses unique to Club 300, not the 150 shared
    /// Club 150 verses); those Club150-tagged verses appear on a
    /// separate Club150 chapter card. Tests for the card grade each
    /// member's own-tier `VerseClubBinding`, so the chapter card
    /// shares state with the per-verse `VerseInClub` cards rather
    /// than spawning parallel bindings. Empty for real verses.
    pub chapter_members: Vec<(u32, ClubTier)>,
    /// For pseudo verses anchoring `HeadingPassage` cards: the
    /// verse_ids of every real verse whose (book, chapter, verse)
    /// falls inside the heading's range. Tests for the card grade
    /// each member's `VerseHeadingBinding` for the card's heading,
    /// so the passage card shares state with the per-verse
    /// `VerseInHeading` cards. Empty for real verses.
    pub heading_members: Vec<u32>,
}

impl VerseAtoms {
    pub fn phrase_positions(&self) -> Vec<u16> {
        (0..self.phrase_count).collect()
    }

    /// Half-open word range `[start, end)` for the given phrase position,
    /// or `None` if the position is past `phrase_count`. The result is
    /// the content-stable identity used to key the phrase's TestState.
    pub fn phrase_range(&self, position: u16) -> Option<(u16, u16)> {
        self.phrase_ranges.get(position as usize).copied()
    }

    /// Build `phrase_ranges` from a `phrase_word_counts` slice via
    /// cumulative sum. `[2, 2, 2, 3]` → `[(0,2), (2,4), (4,6), (6,9)]`.
    pub fn ranges_from_word_counts(counts: &[u16]) -> Vec<(u16, u16)> {
        let mut ranges = Vec::with_capacity(counts.len());
        let mut cursor: u16 = 0;
        for &n in counts {
            let next = cursor.saturating_add(n);
            ranges.push((cursor, next));
            cursor = next;
        }
        ranges
    }
}

pub fn ftv_tests(verse_id: u32, atoms: &VerseAtoms, with_citation: bool) -> Vec<TestKey> {
    // When the FTV equals all of phrase 0, scheduling a phrase-0 test
    // would just re-test what the FTV prompt already showed — skip it.
    let start: u16 = match atoms.ftv_word_count {
        Some(ftv_words) if ftv_words == atoms.phrase_zero_word_count => 1,
        _ => 0,
    };
    let mut out: Vec<TestKey> = (start..atoms.phrase_count)
        .filter_map(|p| {
            let (start_word, end_word) = atoms.phrase_range(p)?;
            Some(TestKey {
                kind: TestKind::PhraseFromContext,
                element: ElementId::Phrase {
                    verse_id,
                    start_word,
                    end_word,
                },
            })
        })
        .collect();
    if with_citation {
        out.push(TestKey {
            kind: TestKind::VerseRefPosition,
            element: ElementId::VerseRefPosition { verse_id },
        });
        out.push(TestKey {
            kind: TestKind::VerseChapter,
            element: ElementId::VerseChapterBinding { verse_id },
        });
        out.push(TestKey {
            kind: TestKind::VerseBook,
            element: ElementId::VerseBookBinding { verse_id },
        });
    }
    out
}

impl Card {
    /// Tests this card contains. The caller passes the `VerseAtoms` for
    /// `self.verse_id` so the function stays pure (no engine reference).
    /// `Recitation`, `Citation`, and `Ftv` expand into multiple tests; the
    /// atomic kinds return a single-element vec; `Reading` returns empty.
    pub fn tests(&self, atoms: &VerseAtoms) -> Vec<TestKey> {
        let verse_id = self.verse_id;
        match self.kind {
            CardKind::PhraseFill { position } => {
                let (start_word, end_word) = atoms
                    .phrase_range(position)
                    .expect("PhraseFill position out of bounds for verse atoms");
                vec![TestKey {
                    kind: TestKind::PhraseFromContext,
                    element: ElementId::Phrase {
                        verse_id,
                        start_word,
                        end_word,
                    },
                }]
            }
            CardKind::VerseAtVerseRef => vec![TestKey {
                kind: TestKind::VerseRefPosition,
                element: ElementId::VerseRefPosition { verse_id },
            }],
            CardKind::VerseInChapter => vec![TestKey {
                kind: TestKind::VerseChapter,
                element: ElementId::VerseChapterBinding { verse_id },
            }],
            CardKind::VerseInBook => vec![TestKey {
                kind: TestKind::VerseBook,
                element: ElementId::VerseBookBinding { verse_id },
            }],
            CardKind::VerseInHeading { heading_idx } => vec![TestKey {
                kind: TestKind::VerseHeading,
                element: ElementId::VerseHeadingBinding {
                    verse_id,
                    heading_idx,
                },
            }],
            CardKind::VerseInClub { tier } => vec![TestKey {
                kind: TestKind::VerseClub,
                element: ElementId::VerseClubBinding { verse_id, tier },
            }],
            CardKind::Recitation => {
                let mut out: Vec<TestKey> = atoms
                    .phrase_ranges
                    .iter()
                    .map(|&(start_word, end_word)| TestKey {
                        kind: TestKind::PhraseFromContext,
                        element: ElementId::Phrase {
                            verse_id,
                            start_word,
                            end_word,
                        },
                    })
                    .collect();
                out.push(TestKey {
                    kind: TestKind::VerseRefPosition,
                    element: ElementId::VerseRefPosition { verse_id },
                });
                out.push(TestKey {
                    kind: TestKind::VerseChapter,
                    element: ElementId::VerseChapterBinding { verse_id },
                });
                out.push(TestKey {
                    kind: TestKind::VerseBook,
                    element: ElementId::VerseBookBinding { verse_id },
                });
                out
            }
            CardKind::Citation => vec![
                TestKey {
                    kind: TestKind::VerseRefPosition,
                    element: ElementId::VerseRefPosition { verse_id },
                },
                TestKey {
                    kind: TestKind::VerseChapter,
                    element: ElementId::VerseChapterBinding { verse_id },
                },
                TestKey {
                    kind: TestKind::VerseBook,
                    element: ElementId::VerseBookBinding { verse_id },
                },
            ],
            CardKind::Ftv { with_citation } => ftv_tests(verse_id, atoms, with_citation),
            CardKind::ChapterClubList { tier: _ } => atoms
                .chapter_members
                .iter()
                .map(|&(v, member_tier)| TestKey {
                    kind: TestKind::VerseClub,
                    element: ElementId::VerseClubBinding {
                        verse_id: v,
                        tier: member_tier,
                    },
                })
                .collect(),
            CardKind::HeadingPassage { heading_idx } => atoms
                .heading_members
                .iter()
                .map(|&v| TestKey {
                    kind: TestKind::VerseHeading,
                    element: ElementId::VerseHeadingBinding {
                        verse_id: v,
                        heading_idx,
                    },
                })
                .collect(),
            CardKind::Reading => Vec::new(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_atoms(verse_id: u32, phrase_count: u16) -> VerseAtoms {
        // Synthesize one-word phrases [0..count) so tests can refer to
        // any position by index without managing word counts.
        let phrase_ranges: Vec<(u16, u16)> = (0..phrase_count).map(|p| (p, p + 1)).collect();
        VerseAtoms {
            verse_id,
            phrase_count,
            phrase_ranges,
            headings: vec![0, 1, 2],
            clubs: vec![ClubTier::Club150, ClubTier::Club300],
            ftv_word_count: None,
            phrase_zero_word_count: 0,
            chapter_members: Vec::new(),
            heading_members: Vec::new(),
        }
    }

    fn atomic_card(id: u32, kind: CardKind, verse_id: u32) -> Card {
        Card {
            id: CardId(id),
            kind,
            verse_id,
            state: CardState::Active,
        }
    }

    #[test]
    fn card_kind_serializes() {
        let k = CardKind::PhraseFill { position: 1 };
        let j = serde_json::to_string(&k).unwrap();
        let r: CardKind = serde_json::from_str(&j).unwrap();
        assert_eq!(k, r);
    }

    #[test]
    fn phrase_ranges_from_word_counts_cumulative_sum() {
        // Standard split: phraseWordCounts becomes half-open word ranges.
        assert_eq!(
            VerseAtoms::ranges_from_word_counts(&[2, 2, 2, 3]),
            vec![(0, 2), (2, 4), (4, 6), (6, 9)]
        );
        // Single phrase covering the whole verse.
        assert_eq!(VerseAtoms::ranges_from_word_counts(&[5]), vec![(0, 5)]);
        // Empty input → no ranges.
        assert!(VerseAtoms::ranges_from_word_counts(&[]).is_empty());
    }

    #[test]
    fn verse_atoms_phrase_positions() {
        let atoms = VerseAtoms {
            verse_id: 1,
            phrase_count: 3,
            phrase_ranges: vec![(0, 2), (2, 4), (4, 6)],
            headings: vec![0],
            clubs: vec![ClubTier::Club150],
            ftv_word_count: Some(2),
            phrase_zero_word_count: 4,
            chapter_members: Vec::new(),
            heading_members: Vec::new(),
        };
        assert_eq!(atoms.phrase_positions(), vec![0u16, 1, 2]);
    }

    #[test]
    fn phrase_fill_grades_one_test() {
        let c = atomic_card(0, CardKind::PhraseFill { position: 1 }, 7);
        let atoms = sample_atoms(7, 4);
        let (start_word, end_word) = atoms.phrase_range(1).unwrap();
        let tests = c.tests(&atoms);
        assert_eq!(
            tests,
            vec![TestKey {
                kind: TestKind::PhraseFromContext,
                element: ElementId::Phrase {
                    verse_id: 7,
                    start_word,
                    end_word,
                }
            }]
        );
    }

    #[test]
    fn verse_at_verseref_grades_position() {
        let c = atomic_card(0, CardKind::VerseAtVerseRef, 7);
        let tests = c.tests(&sample_atoms(7, 4));
        assert_eq!(
            tests,
            vec![TestKey {
                kind: TestKind::VerseRefPosition,
                element: ElementId::VerseRefPosition { verse_id: 7 }
            }]
        );
    }

    #[test]
    fn verse_in_chapter_grades_chapter_binding() {
        let c = atomic_card(0, CardKind::VerseInChapter, 7);
        let tests = c.tests(&sample_atoms(7, 4));
        assert_eq!(
            tests,
            vec![TestKey {
                kind: TestKind::VerseChapter,
                element: ElementId::VerseChapterBinding { verse_id: 7 }
            }]
        );
    }

    #[test]
    fn verse_in_book_grades_book_binding() {
        let c = atomic_card(0, CardKind::VerseInBook, 7);
        let tests = c.tests(&sample_atoms(7, 4));
        assert_eq!(
            tests,
            vec![TestKey {
                kind: TestKind::VerseBook,
                element: ElementId::VerseBookBinding { verse_id: 7 }
            }]
        );
    }

    #[test]
    fn verse_in_heading_grades_heading_binding() {
        let c = atomic_card(0, CardKind::VerseInHeading { heading_idx: 2 }, 7);
        let tests = c.tests(&sample_atoms(7, 4));
        assert_eq!(
            tests,
            vec![TestKey {
                kind: TestKind::VerseHeading,
                element: ElementId::VerseHeadingBinding {
                    verse_id: 7,
                    heading_idx: 2
                }
            }]
        );
    }

    #[test]
    fn recitation_grades_phrases_plus_citation_triple() {
        let c = atomic_card(0, CardKind::Recitation, 7);
        let tests = c.tests(&sample_atoms(7, 4));
        // 4 phrases + 3 citation tests (verseref, chapter, book).
        assert_eq!(tests.len(), 7);
        let phrase_count = tests
            .iter()
            .filter(|t| t.kind == TestKind::PhraseFromContext)
            .count();
        assert_eq!(phrase_count, 4);
        assert!(tests.iter().any(|t| t.kind == TestKind::VerseRefPosition));
        assert!(tests.iter().any(|t| t.kind == TestKind::VerseChapter));
        assert!(tests.iter().any(|t| t.kind == TestKind::VerseBook));
    }

    #[test]
    fn ftv_strict_prefix_grades_all_phrases() {
        let atoms = VerseAtoms {
            verse_id: 7,
            phrase_count: 4,
            phrase_ranges: vec![(0, 1), (1, 2), (2, 3), (3, 4)],
            headings: vec![],
            clubs: vec![],
            ftv_word_count: Some(2),
            phrase_zero_word_count: 6,
            chapter_members: Vec::new(),
            heading_members: Vec::new(),
        };
        let c = atomic_card(
            0,
            CardKind::Ftv {
                with_citation: false,
            },
            7,
        );
        let tests = c.tests(&atoms);
        assert_eq!(tests.len(), 4);
        assert!(tests.iter().all(|t| t.kind == TestKind::PhraseFromContext));
    }

    #[test]
    fn ftv_equal_to_phrase_zero_grades_n_minus_one() {
        let atoms = VerseAtoms {
            verse_id: 7,
            phrase_count: 4,
            phrase_ranges: vec![(0, 1), (1, 2), (2, 3), (3, 4)],
            headings: vec![],
            clubs: vec![],
            ftv_word_count: Some(6),
            phrase_zero_word_count: 6,
            chapter_members: Vec::new(),
            heading_members: Vec::new(),
        };
        let c = atomic_card(
            0,
            CardKind::Ftv {
                with_citation: false,
            },
            7,
        );
        let tests = c.tests(&atoms);
        assert_eq!(tests.len(), 3);
    }

    #[test]
    fn ftv_with_citation_adds_three_tests() {
        let atoms = VerseAtoms {
            verse_id: 7,
            phrase_count: 4,
            phrase_ranges: vec![(0, 1), (1, 2), (2, 3), (3, 4)],
            headings: vec![],
            clubs: vec![],
            ftv_word_count: Some(2),
            phrase_zero_word_count: 6,
            chapter_members: Vec::new(),
            heading_members: Vec::new(),
        };
        let c = atomic_card(
            0,
            CardKind::Ftv {
                with_citation: true,
            },
            7,
        );
        let tests = c.tests(&atoms);
        assert_eq!(tests.len(), 7); // 4 phrase + 3 citation
    }

    #[test]
    fn citation_grades_three_bindings() {
        let c = atomic_card(0, CardKind::Citation, 7);
        let tests = c.tests(&sample_atoms(7, 4));
        assert_eq!(tests.len(), 3);
        let kinds: std::collections::HashSet<_> = tests.iter().map(|t| t.kind).collect();
        let expected: std::collections::HashSet<_> = [
            TestKind::VerseRefPosition,
            TestKind::VerseChapter,
            TestKind::VerseBook,
        ]
        .into_iter()
        .collect();
        assert_eq!(kinds, expected);
    }

    #[test]
    fn recitation_phrase_tests_target_correct_verse() {
        let c = atomic_card(0, CardKind::Recitation, 7);
        let atoms = sample_atoms(7, 4);
        let tests = c.tests(&atoms);
        let phrase_tests: Vec<_> = tests
            .iter()
            .filter(|t| t.kind == TestKind::PhraseFromContext)
            .collect();
        assert_eq!(phrase_tests.len(), 4);
        assert!(
            phrase_tests
                .iter()
                .all(|t| matches!(t.element, ElementId::Phrase { verse_id: 7, .. }))
        );
    }

    #[test]
    fn reading_grades_no_tests() {
        let c = atomic_card(0, CardKind::Reading, 7);
        let tests = c.tests(&sample_atoms(7, 4));
        assert!(tests.is_empty());
    }

    #[test]
    fn heading_passage_grades_member_bindings() {
        // HeadingPassage anchored to a pseudo verse_id whose
        // heading_members list spans three real verses. Card grades a
        // VerseHeadingBinding per member, all tagged with the card's
        // heading_idx — that's what couples its FSRS state to each
        // member's per-verse VerseInHeading.
        let atoms = VerseAtoms {
            verse_id: 99,
            phrase_count: 0,
            phrase_ranges: vec![],
            headings: vec![2],
            clubs: vec![],
            ftv_word_count: None,
            phrase_zero_word_count: 0,
            chapter_members: Vec::new(),
            heading_members: vec![7, 8, 9],
        };
        let c = atomic_card(0, CardKind::HeadingPassage { heading_idx: 2 }, 99);
        let tests = c.tests(&atoms);
        assert_eq!(tests.len(), 3);
        for (i, expected_verse) in [7, 8, 9].into_iter().enumerate() {
            assert_eq!(
                tests[i],
                TestKey {
                    kind: TestKind::VerseHeading,
                    element: ElementId::VerseHeadingBinding {
                        verse_id: expected_verse,
                        heading_idx: 2,
                    }
                }
            );
        }
    }

    #[test]
    fn heading_passage_with_no_members_grades_no_tests() {
        let atoms = sample_atoms(99, 0);
        let c = atomic_card(0, CardKind::HeadingPassage { heading_idx: 0 }, 99);
        assert!(c.tests(&atoms).is_empty());
    }

    #[test]
    fn verse_in_club_grades_club_binding() {
        let c = atomic_card(
            0,
            CardKind::VerseInClub {
                tier: ClubTier::Club300,
            },
            7,
        );
        let tests = c.tests(&sample_atoms(7, 4));
        assert_eq!(
            tests,
            vec![TestKey {
                kind: TestKind::VerseClub,
                element: ElementId::VerseClubBinding {
                    verse_id: 7,
                    tier: ClubTier::Club300
                }
            }]
        );
    }
}
