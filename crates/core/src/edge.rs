use serde::{Deserialize, Serialize};

use crate::types::{EdgeId, NodeId};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum EdgeKind {
    PhrasePhrase,
    PhraseVerseGist,
    VerseGistReference,
    VerseGistVerseGist,
    ReferenceClubEntry,
    ChapterGistChapterRef,
    VerseGistChapterGist,
    ChapterGistClubEntry,
    ClubEntryClubEntry,
    VerseGistHeading,
    HeadingHeading,
    FtvPhrase,
    FtvVerseGist,
}

impl EdgeKind {
    pub fn is_learnable(self) -> bool {
        !matches!(self, EdgeKind::ChapterGistClubEntry)
    }

    pub fn is_structural(self) -> bool {
        !self.is_learnable()
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
pub struct EdgeState {
    pub stability: f32,
    pub difficulty: f32,
    pub last_review_secs: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Edge {
    pub id: EdgeId,
    pub kind: EdgeKind,
    pub source: NodeId,
    pub target: NodeId,
    pub state: Option<EdgeState>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn structural_edge() {
        assert!(!EdgeKind::ChapterGistClubEntry.is_learnable());
        assert!(EdgeKind::ChapterGistClubEntry.is_structural());
    }

    #[test]
    fn all_other_edges_are_learnable() {
        let learnable = [
            EdgeKind::PhrasePhrase,
            EdgeKind::PhraseVerseGist,
            EdgeKind::VerseGistReference,
            EdgeKind::VerseGistVerseGist,
            EdgeKind::ReferenceClubEntry,
            EdgeKind::ChapterGistChapterRef,
            EdgeKind::VerseGistChapterGist,
            EdgeKind::ClubEntryClubEntry,
            EdgeKind::VerseGistHeading,
            EdgeKind::HeadingHeading,
            EdgeKind::FtvPhrase,
            EdgeKind::FtvVerseGist,
        ];
        for kind in learnable {
            assert!(kind.is_learnable(), "{kind:?} should be learnable");
        }
    }
}
