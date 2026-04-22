use serde::{Deserialize, Serialize};

use crate::types::{EdgeId, NodeId};

/// Directed edge kinds in the memory graph.
///
/// Each variant represents a specific retrieval proposition: "given I am
/// thinking about X, can I produce Y?" Every edge carries FSRS state.
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
    pub state: EdgeState,
}
