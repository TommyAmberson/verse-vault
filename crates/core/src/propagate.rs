use crate::element::ElementId;
use crate::test_kind::{TestKey, TestKind};
use crate::verse_index::VerseIndex;

#[derive(Debug, Clone, Copy)]
pub struct PropagationParams {
    pub gamma_sibling: f32,
    pub gamma_endpoint: f32,
}

impl Default for PropagationParams {
    fn default() -> Self {
        Self {
            gamma_sibling: 0.5,
            gamma_endpoint: 0.07,
        }
    }
}

#[derive(Debug, Clone, Copy)]
pub struct PropagationEdge {
    pub target: TestKey,
    pub weight: f32,
}

/// Map a verse-binding ElementId to its corresponding TestKind. Returns None
/// for non-binding elements (e.g. Phrase).
fn binding_kind(element: ElementId) -> Option<TestKind> {
    match element {
        ElementId::VerseRefPosition { .. } => Some(TestKind::VerseRefPosition),
        ElementId::VerseChapterBinding { .. } => Some(TestKind::VerseChapter),
        ElementId::VerseBookBinding { .. } => Some(TestKind::VerseBook),
        ElementId::VerseHeadingBinding { .. } => Some(TestKind::VerseHeading),
        ElementId::VerseClubBinding { .. } => Some(TestKind::VerseClub),
        ElementId::Phrase { .. } => None,
    }
}

/// Pure function — given a directly-graded test, return the list of related
/// tests to nudge and their weights.
///
/// Per design decision D4 (active architecture): propagation is endpoint↔binding
/// plus same-element cuing-direction sibling.
///
/// For a Phrase direct: emits the opposite-cuing sibling (gamma_sibling) plus
/// every verse binding (gamma_endpoint). For a binding direct: emits both
/// phrase-test kinds for each phrase of the verse (gamma_endpoint).
///
/// Returns empty if the verse is unknown to `idx`.
pub fn related_tests(
    direct: TestKey,
    idx: &VerseIndex,
    params: &PropagationParams,
) -> Vec<PropagationEdge> {
    let mut out: Vec<PropagationEdge> = Vec::new();

    match direct.element {
        ElementId::Phrase { verse_id, position } => {
            // Verse must be known.
            if idx.elements_of(verse_id).is_none() {
                return Vec::new();
            }
            // Same-element cuing-direction sibling.
            let sibling_kind = match direct.kind {
                TestKind::PhraseFromChain => Some(TestKind::PhraseFromContext),
                TestKind::PhraseFromContext => Some(TestKind::PhraseFromChain),
                _ => None,
            };
            if let Some(sk) = sibling_kind {
                out.push(PropagationEdge {
                    target: TestKey {
                        kind: sk,
                        element: ElementId::Phrase { verse_id, position },
                    },
                    weight: params.gamma_sibling,
                });
            }
            // Endpoint -> binding: every verse binding.
            for binding in idx.bindings_of(verse_id) {
                if let Some(kind) = binding_kind(binding) {
                    out.push(PropagationEdge {
                        target: TestKey {
                            kind,
                            element: binding,
                        },
                        weight: params.gamma_endpoint,
                    });
                }
            }
        }
        ElementId::VerseRefPosition { verse_id }
        | ElementId::VerseChapterBinding { verse_id }
        | ElementId::VerseBookBinding { verse_id }
        | ElementId::VerseHeadingBinding { verse_id, .. }
        | ElementId::VerseClubBinding { verse_id, .. } => {
            // Verse must be known.
            if idx.elements_of(verse_id).is_none() {
                return Vec::new();
            }
            // Endpoint -> phrase: emit both cuing-direction kinds for each phrase.
            for phrase in idx.phrases_of(verse_id) {
                for &kind in &[TestKind::PhraseFromChain, TestKind::PhraseFromContext] {
                    out.push(PropagationEdge {
                        target: TestKey {
                            kind,
                            element: phrase,
                        },
                        weight: params.gamma_endpoint,
                    });
                }
            }
        }
    }

    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::element::{ClubTier, ElementId};
    use crate::test_kind::TestKind;
    use crate::verse_index::VerseElements;

    #[test]
    fn related_tests_empty_for_unknown_verse() {
        let idx = VerseIndex::new();
        let key = TestKey {
            kind: TestKind::PhraseFromChain,
            element: ElementId::Phrase {
                verse_id: 99,
                position: 0,
            },
        };
        let result = related_tests(key, &idx, &PropagationParams::default());
        assert!(result.is_empty());
    }

    #[test]
    fn phrase_grade_propagates_to_bindings_and_sibling() {
        let mut idx = VerseIndex::new();
        idx.add_verse(
            7,
            VerseElements {
                phrases: vec![0, 1],
                headings: vec![0],
                clubs: vec![ClubTier::Club150],
            },
        );
        let key = TestKey {
            kind: TestKind::PhraseFromChain,
            element: ElementId::Phrase {
                verse_id: 7,
                position: 0,
            },
        };
        let edges = related_tests(key, &idx, &PropagationParams::default());
        // Same-element sibling.
        assert!(edges.iter().any(
            |e| e.target.kind == TestKind::PhraseFromContext && e.target.element == key.element
        ));
        // Verse bindings.
        assert!(
            edges
                .iter()
                .any(|e| e.target.kind == TestKind::VerseChapter)
        );
        assert!(edges.iter().any(|e| e.target.kind == TestKind::VerseBook));
        assert!(
            edges
                .iter()
                .any(|e| e.target.kind == TestKind::VerseRefPosition)
        );
        assert!(
            edges
                .iter()
                .any(|e| e.target.kind == TestKind::VerseHeading)
        );
        assert!(edges.iter().any(|e| e.target.kind == TestKind::VerseClub));
        // No phrases of other verses.
        assert!(edges.iter().all(|e| match e.target.element {
            ElementId::Phrase { verse_id, .. } => verse_id == 7,
            _ => true,
        }));
    }

    #[test]
    fn binding_grade_propagates_to_phrases() {
        let mut idx = VerseIndex::new();
        idx.add_verse(
            7,
            VerseElements {
                phrases: vec![0, 1, 2],
                headings: vec![],
                clubs: vec![],
            },
        );
        let key = TestKey {
            kind: TestKind::VerseChapter,
            element: ElementId::VerseChapterBinding { verse_id: 7 },
        };
        let edges = related_tests(key, &idx, &PropagationParams::default());
        // 3 phrases × 2 cuing kinds = 6.
        assert_eq!(
            edges
                .iter()
                .filter(|e| matches!(e.target.element, ElementId::Phrase { verse_id: 7, .. }))
                .count(),
            6
        );
    }

    #[test]
    fn edge_target_kind_matches_element_variant() {
        let mut idx = VerseIndex::new();
        idx.add_verse(
            3,
            VerseElements {
                phrases: vec![0, 1],
                headings: vec![5],
                clubs: vec![ClubTier::Club300],
            },
        );
        let key = TestKey {
            kind: TestKind::PhraseFromChain,
            element: ElementId::Phrase {
                verse_id: 3,
                position: 0,
            },
        };
        let edges = related_tests(key, &idx, &PropagationParams::default());
        for e in &edges {
            match e.target.element {
                ElementId::Phrase { .. } => assert!(matches!(
                    e.target.kind,
                    TestKind::PhraseFromChain | TestKind::PhraseFromContext
                )),
                ElementId::VerseRefPosition { .. } => {
                    assert_eq!(e.target.kind, TestKind::VerseRefPosition)
                }
                ElementId::VerseChapterBinding { .. } => {
                    assert_eq!(e.target.kind, TestKind::VerseChapter)
                }
                ElementId::VerseBookBinding { .. } => {
                    assert_eq!(e.target.kind, TestKind::VerseBook)
                }
                ElementId::VerseHeadingBinding { .. } => {
                    assert_eq!(e.target.kind, TestKind::VerseHeading)
                }
                ElementId::VerseClubBinding { .. } => {
                    assert_eq!(e.target.kind, TestKind::VerseClub)
                }
            }
        }
    }

    #[test]
    fn all_edge_weights_are_in_open_zero_to_one() {
        let mut idx = VerseIndex::new();
        idx.add_verse(
            3,
            VerseElements {
                phrases: vec![0, 1],
                headings: vec![5],
                clubs: vec![ClubTier::Club300],
            },
        );
        let phrase_key = TestKey {
            kind: TestKind::PhraseFromChain,
            element: ElementId::Phrase {
                verse_id: 3,
                position: 0,
            },
        };
        let binding_key = TestKey {
            kind: TestKind::VerseChapter,
            element: ElementId::VerseChapterBinding { verse_id: 3 },
        };
        let params = PropagationParams::default();
        for edges in [
            related_tests(phrase_key, &idx, &params),
            related_tests(binding_key, &idx, &params),
        ] {
            assert!(!edges.is_empty());
            for e in edges {
                assert!(
                    e.weight > 0.0 && e.weight <= 1.0,
                    "weight out of range: {}",
                    e.weight
                );
            }
        }
    }

    #[test]
    fn no_cross_verse_leakage_from_phrase_grade() {
        let mut idx = VerseIndex::new();
        idx.add_verse(
            7,
            VerseElements {
                phrases: vec![0, 1],
                headings: vec![],
                clubs: vec![],
            },
        );
        idx.add_verse(
            8,
            VerseElements {
                phrases: vec![0, 1, 2],
                headings: vec![],
                clubs: vec![],
            },
        );
        let key = TestKey {
            kind: TestKind::PhraseFromChain,
            element: ElementId::Phrase {
                verse_id: 7,
                position: 0,
            },
        };
        let edges = related_tests(key, &idx, &PropagationParams::default());
        for e in edges {
            let vid = match e.target.element {
                ElementId::Phrase { verse_id, .. }
                | ElementId::VerseRefPosition { verse_id }
                | ElementId::VerseChapterBinding { verse_id }
                | ElementId::VerseBookBinding { verse_id }
                | ElementId::VerseHeadingBinding { verse_id, .. }
                | ElementId::VerseClubBinding { verse_id, .. } => verse_id,
            };
            assert_eq!(vid, 7, "cross-verse leak to verse {vid}");
        }
    }

    #[test]
    fn no_cross_verse_leakage_from_binding_grade() {
        let mut idx = VerseIndex::new();
        idx.add_verse(
            7,
            VerseElements {
                phrases: vec![0, 1],
                headings: vec![],
                clubs: vec![],
            },
        );
        idx.add_verse(
            8,
            VerseElements {
                phrases: vec![0, 1, 2],
                headings: vec![],
                clubs: vec![],
            },
        );
        let key = TestKey {
            kind: TestKind::VerseBook,
            element: ElementId::VerseBookBinding { verse_id: 7 },
        };
        let edges = related_tests(key, &idx, &PropagationParams::default());
        for e in edges {
            let vid = match e.target.element {
                ElementId::Phrase { verse_id, .. }
                | ElementId::VerseRefPosition { verse_id }
                | ElementId::VerseChapterBinding { verse_id }
                | ElementId::VerseBookBinding { verse_id }
                | ElementId::VerseHeadingBinding { verse_id, .. }
                | ElementId::VerseClubBinding { verse_id, .. } => verse_id,
            };
            assert_eq!(vid, 7, "cross-verse leak to verse {vid}");
        }
    }
}
