use serde::{Deserialize, Serialize};

use crate::types::{EdgeId, NodeId};

/// Directed edge kinds in the memory graph.
///
/// Each variant represents a specific retrieval proposition: "given I am
/// thinking about X, can I produce Y?" Every edge is learnable (has FSRS
/// state); the previous structural `ChapterGistClubEntry` variant was
/// retired in favour of a proper `ChapterClubMember` atom.
///
/// The enum duplicates the same containment pattern (gist↔ref,
/// parent→first/last child, parent-consecutive chain, child_ref→parent_ref)
/// across the book/chapter/verse/heading/club layers. A future cleanup
/// could collapse these to generic variants parameterised by a layer
/// discriminator (`ContainsStart`, `ContainsEnd`, `ParentRef`, …); kept
/// explicit for now while the schema is still iterating. See
/// `docs/graph.md` for the design rationale.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum EdgeKind {
    // --- Phrase / verse layer ---
    PhrasePhrase,
    PhraseVerseGist,
    VerseGistVerseRef,
    VerseGistVerseGist,

    // --- Chapter layer ---
    ChapterGistChapterRef,
    VerseGistChapterGist,
    ChapterGistFirstVerseGist,
    ChapterGistLastVerseGist,
    VerseRefChapterRef,
    ChapterGistChapterGist,

    // --- Book layer ---
    BookGistBookRef,
    ChapterGistBookGist,
    BookGistFirstChapterGist,
    BookGistLastChapterGist,
    ChapterRefBookRef,
    BookGistBookGist,

    // --- Heading layer ---
    VerseGistHeading,
    HeadingHeading,
    HeadingFirstVerseGist,
    HeadingLastVerseGist,

    // --- Club hierarchy (verse + chapter) ---
    VerseRefVerseClubMember,
    VerseClubMemberVerseClubMember,
    VerseClubMemberClubGist,
    VerseClubMemberChapterClubMember,
    ChapterRefChapterClubMember,
    ChapterClubMemberChapterClubMember,
    ChapterClubMemberClubGist,
    ChapterClubMemberFirstVerseClubMember,
    ChapterClubMemberLastVerseClubMember,
    ClubGistFirstVerseClubMember,
    ClubGistLastVerseClubMember,
    ClubGistFirstChapterClubMember,
    ClubGistLastChapterClubMember,

    // --- Heading-club hierarchy ---
    HeadingHeadingClubMember,
    HeadingClubMemberHeadingClubMember,
    HeadingClubMemberClubGist,
    VerseClubMemberHeadingClubMember,
    HeadingClubMemberFirstVerseClubMember,
    HeadingClubMemberLastVerseClubMember,
    ClubGistFirstHeadingClubMember,
    ClubGistLastHeadingClubMember,

    // --- FTV ---
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
            // Phrase / verse
            EdgeKind::PhrasePhrase,
            EdgeKind::PhraseVerseGist,
            EdgeKind::VerseGistVerseRef,
            EdgeKind::VerseGistVerseGist,
            // Chapter
            EdgeKind::ChapterGistChapterRef,
            EdgeKind::VerseGistChapterGist,
            EdgeKind::ChapterGistFirstVerseGist,
            EdgeKind::ChapterGistLastVerseGist,
            EdgeKind::VerseRefChapterRef,
            EdgeKind::ChapterGistChapterGist,
            // Book
            EdgeKind::BookGistBookRef,
            EdgeKind::ChapterGistBookGist,
            EdgeKind::BookGistFirstChapterGist,
            EdgeKind::BookGistLastChapterGist,
            EdgeKind::ChapterRefBookRef,
            EdgeKind::BookGistBookGist,
            // Heading
            EdgeKind::VerseGistHeading,
            EdgeKind::HeadingHeading,
            EdgeKind::HeadingFirstVerseGist,
            EdgeKind::HeadingLastVerseGist,
            // Club hierarchy
            EdgeKind::VerseRefVerseClubMember,
            EdgeKind::VerseClubMemberVerseClubMember,
            EdgeKind::VerseClubMemberClubGist,
            EdgeKind::VerseClubMemberChapterClubMember,
            EdgeKind::ChapterRefChapterClubMember,
            EdgeKind::ChapterClubMemberChapterClubMember,
            EdgeKind::ChapterClubMemberClubGist,
            EdgeKind::ChapterClubMemberFirstVerseClubMember,
            EdgeKind::ChapterClubMemberLastVerseClubMember,
            EdgeKind::ClubGistFirstVerseClubMember,
            EdgeKind::ClubGistLastVerseClubMember,
            EdgeKind::ClubGistFirstChapterClubMember,
            EdgeKind::ClubGistLastChapterClubMember,
            // Heading-club
            EdgeKind::HeadingHeadingClubMember,
            EdgeKind::HeadingClubMemberHeadingClubMember,
            EdgeKind::HeadingClubMemberClubGist,
            EdgeKind::VerseClubMemberHeadingClubMember,
            EdgeKind::HeadingClubMemberFirstVerseClubMember,
            EdgeKind::HeadingClubMemberLastVerseClubMember,
            EdgeKind::ClubGistFirstHeadingClubMember,
            EdgeKind::ClubGistLastHeadingClubMember,
            // FTV
            EdgeKind::FtvPhrase,
            EdgeKind::FtvVerseGist,
        ];
        assert_eq!(all.len(), 43, "update this list when adding EdgeKinds");
        for kind in all {
            assert!(kind.is_learnable(), "{kind:?} should be learnable");
            assert!(!kind.is_structural(), "{kind:?} should not be structural");
        }
    }
}
