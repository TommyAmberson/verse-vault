//! Per-verse rendering metadata retained by the engine so consumers can
//! render any card without re-fetching `MaterialData`. Holds only
//! structural information — phrase word counts, annotation indices, FTV
//! length, heading ranges, club tiers. The verse text itself comes from
//! api.bible at render time and is composed against this metadata
//! server-side.

use serde::{Deserialize, Serialize};

use crate::content::Annotation;
use crate::element::ClubTier;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HeadingRender {
    pub heading_idx: u16,
    /// Range used by the API render path to align with api.bible's
    /// sections endpoint and resolve a title.
    pub start_chapter: u16,
    pub start_verse: u16,
    pub end_chapter: u16,
    pub end_verse: u16,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VerseRender {
    pub book: String,
    pub chapter: u16,
    pub verse: u16,
    pub phrase_word_counts: Vec<u16>,
    pub annotations: Vec<Annotation>,
    pub ftv_word_count: Option<u16>,
    pub headings: Vec<HeadingRender>,
    pub clubs: Vec<ClubTier>,
    /// Verse numbers in this chapter that belong to the pseudo's tier,
    /// populated only for `ChapterClubList` pseudo-verses so the client
    /// can render the back-of-card answer without a follow-up lookup.
    /// Empty for real verses and other pseudos. Defaults to empty on
    /// deserialise so older snapshot data still loads.
    #[serde(default)]
    pub chapter_members: Vec<u16>,
}
