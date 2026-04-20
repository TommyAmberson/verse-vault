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
    Reference {
        chapter: u16,
        verse: u16,
    },
    ClubEntry {
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
    ChapterGist {
        chapter: u16,
    },
    ChapterRef {
        chapter: u16,
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
