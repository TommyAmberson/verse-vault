use serde::{Deserialize, Serialize};

use crate::element::{ClubTier, ElementId};
use crate::test_kind::{TestKey, TestKind};
use crate::types::CardId;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum CardState {
    New,
    Learning,
    Review,
    Relearning,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum CardKind {
    // atomic — each grades exactly one test
    PhraseFill {
        position: u16,
    },
    PhraseChain {
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
    // composite — each grades many tests
    Recitation,
    Citation,
    Ftv {
        with_citation: bool,
    },
    Holistic,
    /// UX-only: progressive-reveal entry that shows the verse text to the
    /// learner. Carries no FSRS state and is never emitted by `builder::build`;
    /// it only appears in `Session::new_verse_progression`.
    Reading,
}

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

#[derive(Debug, Clone)]
pub struct VerseAtoms {
    pub verse_id: u32,
    pub phrase_count: u16,
    pub headings: Vec<u16>,
    pub clubs: Vec<ClubTier>,
    pub ftv: Option<String>,
    pub phrase_zero_text: Option<String>,
}

impl VerseAtoms {
    pub fn phrase_positions(&self) -> Vec<u16> {
        (0..self.phrase_count).collect()
    }
}

pub fn ftv_tests(verse_id: u32, atoms: &VerseAtoms, with_citation: bool) -> Vec<TestKey> {
    let start: u16 = match (&atoms.ftv, &atoms.phrase_zero_text) {
        (Some(ftv), Some(p0)) if ftv == p0 => 1,
        _ => 0,
    };
    let mut out: Vec<TestKey> = (start..atoms.phrase_count)
        .map(|p| TestKey {
            kind: TestKind::PhraseFromChain,
            element: ElementId::Phrase {
                verse_id,
                position: p,
            },
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
    /// The set of tests this card grades when reviewed.
    pub fn tests(&self, atoms: &VerseAtoms) -> Vec<TestKey> {
        let verse_id = self.verse_id;
        match self.kind {
            CardKind::PhraseFill { position } => vec![TestKey {
                kind: TestKind::PhraseFromContext,
                element: ElementId::Phrase { verse_id, position },
            }],
            CardKind::PhraseChain { position } => vec![TestKey {
                kind: TestKind::PhraseFromChain,
                element: ElementId::Phrase { verse_id, position },
            }],
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
            CardKind::Recitation => atoms
                .phrase_positions()
                .into_iter()
                .map(|p| TestKey {
                    kind: TestKind::PhraseFromChain,
                    element: ElementId::Phrase {
                        verse_id,
                        position: p,
                    },
                })
                .collect(),
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
            CardKind::Reading => Vec::new(),
            CardKind::Holistic => {
                let mut out: Vec<TestKey> = atoms
                    .phrase_positions()
                    .into_iter()
                    .map(|p| TestKey {
                        kind: TestKind::PhraseFromChain,
                        element: ElementId::Phrase {
                            verse_id,
                            position: p,
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
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_atoms(verse_id: u32, phrase_count: u16) -> VerseAtoms {
        VerseAtoms {
            verse_id,
            phrase_count,
            headings: vec![0, 1, 2],
            clubs: vec![ClubTier::Club150, ClubTier::Club300],
            ftv: None,
            phrase_zero_text: None,
        }
    }

    fn atomic_card(id: u32, kind: CardKind, verse_id: u32) -> Card {
        Card {
            id: CardId(id),
            kind,
            verse_id,
            state: CardState::Review,
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
    fn verse_atoms_phrase_positions() {
        let atoms = VerseAtoms {
            verse_id: 1,
            phrase_count: 3,
            headings: vec![0],
            clubs: vec![ClubTier::Club150],
            ftv: Some("For God".into()),
            phrase_zero_text: Some("For God so loved".into()),
        };
        assert_eq!(atoms.phrase_positions(), vec![0u16, 1, 2]);
    }

    #[test]
    fn phrase_fill_grades_one_test() {
        let c = atomic_card(0, CardKind::PhraseFill { position: 1 }, 7);
        let atoms = sample_atoms(7, 4);
        let tests = c.tests(&atoms);
        assert_eq!(
            tests,
            vec![TestKey {
                kind: TestKind::PhraseFromContext,
                element: ElementId::Phrase {
                    verse_id: 7,
                    position: 1
                }
            }]
        );
    }

    #[test]
    fn phrase_chain_grades_one_test() {
        let c = atomic_card(0, CardKind::PhraseChain { position: 2 }, 7);
        let tests = c.tests(&sample_atoms(7, 4));
        assert_eq!(
            tests,
            vec![TestKey {
                kind: TestKind::PhraseFromChain,
                element: ElementId::Phrase {
                    verse_id: 7,
                    position: 2
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
    fn holistic_grades_n_plus_three() {
        let c = atomic_card(0, CardKind::Holistic, 7);
        let tests = c.tests(&sample_atoms(7, 4));
        assert_eq!(tests.len(), 7); // 4 phrase + 3 citation
    }

    #[test]
    fn ftv_strict_prefix_grades_all_phrases() {
        let atoms = VerseAtoms {
            verse_id: 7,
            phrase_count: 4,
            headings: vec![],
            clubs: vec![],
            ftv: Some("For God".into()),
            phrase_zero_text: Some("For God so loved the world".into()),
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
        assert!(tests.iter().all(|t| t.kind == TestKind::PhraseFromChain));
    }

    #[test]
    fn ftv_equal_to_phrase_zero_grades_n_minus_one() {
        let atoms = VerseAtoms {
            verse_id: 7,
            phrase_count: 4,
            headings: vec![],
            clubs: vec![],
            ftv: Some("For God so loved the world".into()),
            phrase_zero_text: Some("For God so loved the world".into()),
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
            headings: vec![],
            clubs: vec![],
            ftv: Some("For God".into()),
            phrase_zero_text: Some("For God so loved the world".into()),
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
    fn recitation_grades_n_phrases() {
        let c = atomic_card(0, CardKind::Recitation, 7);
        let atoms = sample_atoms(7, 4);
        let tests = c.tests(&atoms);
        assert_eq!(tests.len(), 4);
        assert!(tests.iter().all(|t| t.kind == TestKind::PhraseFromChain));
        assert!(
            tests
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
