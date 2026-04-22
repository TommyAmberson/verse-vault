use serde::{Deserialize, Serialize};

use crate::types::{EdgeId, NodeId};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum EdgeKind {
    PhrasePhrase,
    PhraseVerseGist,
    VerseGistVerseRef,
    VerseGistVerseGist,
    VerseRefVerseClubMember,
    ChapterGistChapterRef,
    VerseGistChapterGist,
    VerseClubMemberVerseClubMember,
    VerseGistHeading,
    HeadingHeading,
    FtvPhrase,
    FtvVerseGist,
}

impl EdgeKind {
    /// Every edge in the current graph is a retrieval proposition with its
    /// own FSRS state. Kept as a method for API stability — previously some
    /// edges (notably `ChapterGistClubEntry`) were non-learnable plumbing.
    pub fn is_learnable(self) -> bool {
        true
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
    fn every_edge_is_learnable() {
        let all = [
            EdgeKind::PhrasePhrase,
            EdgeKind::PhraseVerseGist,
            EdgeKind::VerseGistVerseRef,
            EdgeKind::VerseGistVerseGist,
            EdgeKind::VerseRefVerseClubMember,
            EdgeKind::ChapterGistChapterRef,
            EdgeKind::VerseGistChapterGist,
            EdgeKind::VerseClubMemberVerseClubMember,
            EdgeKind::VerseGistHeading,
            EdgeKind::HeadingHeading,
            EdgeKind::FtvPhrase,
            EdgeKind::FtvVerseGist,
        ];
        for kind in all {
            assert!(kind.is_learnable(), "{kind:?} should be learnable");
            assert!(!kind.is_structural(), "{kind:?} should not be structural");
        }
    }
}
