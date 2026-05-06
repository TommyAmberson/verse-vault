use crate::test_kind::TestKey;
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

/// Pure function — given a directly-graded test, return the list of related
/// tests to nudge and their weights. Body filled in during Phase 5.
pub fn related_tests(
    _direct: TestKey,
    _idx: &VerseIndex,
    _params: &PropagationParams,
) -> Vec<PropagationEdge> {
    Vec::new()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::element::ElementId;
    use crate::test_kind::TestKind;

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
}
