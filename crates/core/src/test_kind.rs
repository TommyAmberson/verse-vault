use crate::element::ElementId;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum TestKind {
    PhraseFromContext,
    VerseRefPosition,
    VerseChapter,
    VerseBook,
    VerseHeading,
    VerseClub,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct TestKey {
    pub kind: TestKind,
    pub element: ElementId,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_key_hash_eq() {
        let a = TestKey {
            kind: TestKind::PhraseFromContext,
            element: ElementId::Phrase {
                verse_id: 1,
                start_word: 0,
                end_word: 2,
            },
        };
        let b = a;
        assert_eq!(a, b);
        let mut s = std::collections::HashSet::new();
        s.insert(a);
        assert!(s.contains(&b));
    }
}
