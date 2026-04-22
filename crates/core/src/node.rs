use serde::{Deserialize, Serialize};

use crate::types::NodeId;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum ClubTier {
    Club150,
    Club300,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub enum NodeKind {
    Phrase {
        text: String,
        verse_id: u32,
        position: u16,
    },
    VerseGist {
        chapter: u16,
        verse: u16,
    },
    VerseRef {
        chapter: u16,
        verse: u16,
    },
    VerseClubMember {
        tier: ClubTier,
        chapter: u16,
        verse: u16,
    },
    Heading {
        text: String,
        start_chapter: u16,
        start_verse: u16,
        end_chapter: u16,
        end_verse: u16,
    },
    /// Per-heading-per-tier club participation.
    /// Keyed by the heading's starting coordinates so the atom is
    /// stable across graph rebuilds (the Heading atom itself is
    /// identified by its start_chapter/start_verse pair).
    HeadingClubMember {
        tier: ClubTier,
        start_chapter: u16,
        start_verse: u16,
    },
    ChapterGist {
        chapter: u16,
    },
    ChapterRef {
        chapter: u16,
    },
    /// Per-chapter-per-tier club participation.
    ChapterClubMember {
        tier: ClubTier,
        chapter: u16,
    },
    /// Book-level hub. `book` is the material's canonical book name
    /// (e.g. "1 Corinthians").
    BookGist {
        book: String,
    },
    /// Book-level identifier atom.
    BookRef {
        book: String,
    },
    /// Per-tier hub atom (one per tier present in a material).
    ClubGist {
        tier: ClubTier,
    },
    Ftv {
        text: String,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Node {
    pub id: NodeId,
    pub kind: NodeKind,
}
