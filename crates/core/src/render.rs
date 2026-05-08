//! Per-verse rendering data retained by the engine so consumers (the
//! frontend, primarily) can render any card without re-parsing the source
//! `MaterialData`. Populated once in `builder::build` and snapshotted onto
//! the engine; never mutated.

use serde::{Deserialize, Serialize};

use crate::element::ClubTier;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct HeadingRender {
    pub heading_idx: u16,
    pub text: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct VerseRender {
    pub book: String,
    pub chapter: u16,
    pub verse: u16,
    pub text: String,
    pub phrases: Vec<String>,
    pub ftv: Option<String>,
    pub headings: Vec<HeadingRender>,
    pub clubs: Vec<ClubTier>,
}
