use serde::{Deserialize, Serialize};

use crate::element::{ClubTier, ElementId};
use crate::test_kind::{TestKey, TestKind};
use crate::types::{CardId, NodeId};

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
    PhraseFill { position: u16 },
    PhraseChain { position: u16 },
    VerseAtVerseRef,
    VerseInChapter,
    VerseInBook,
    VerseInHeading { heading_idx: u16 },
    VerseInClub { tier: ClubTier },
    // composite — each grades many tests
    Recitation,
    Citation,
    Ftv { with_citation: bool },
    Holistic,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Card {
    pub id: CardId,
    pub shown: Vec<NodeId>,
    pub hidden: Vec<NodeId>,
    pub state: CardState,
    #[serde(default)]
    pub kind: Option<CardKind>,
    #[serde(default)]
    pub verse_id: Option<u32>,
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

impl Card {
    /// The set of tests this card grades when reviewed.
    /// Returns empty if the card is legacy (kind is None).
    pub fn tests(&self, atoms: &VerseAtoms) -> Vec<TestKey> {
        let Some(kind) = self.kind else {
            return Vec::new();
        };
        let verse_id = self.verse_id.unwrap_or(atoms.verse_id);
        match kind {
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
            // composites filled in by tasks 3.6 / 3.7 — placeholder for now
            CardKind::Ftv { .. } | CardKind::Holistic => Vec::new(),
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
            clubs: vec![ClubTier::First, ClubTier::Second, ClubTier::Third],
            ftv: None,
            phrase_zero_text: None,
        }
    }

    fn atomic_card(id: u32, kind: CardKind, verse_id: u32) -> Card {
        Card {
            id: CardId(id),
            shown: vec![],
            hidden: vec![],
            state: CardState::Review,
            kind: Some(kind),
            verse_id: Some(verse_id),
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
            clubs: vec![ClubTier::First],
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
    fn verse_in_club_grades_club_binding() {
        let c = atomic_card(
            0,
            CardKind::VerseInClub {
                tier: ClubTier::Second,
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
                    tier: ClubTier::Second
                }
            }]
        );
    }
}
