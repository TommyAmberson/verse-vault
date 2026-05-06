use serde::{Deserialize, Serialize};

use crate::element::ClubTier;
use crate::types::{CardId, NodeId};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum CardState {
    New,
    Learning,
    Review,
    Relearning,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum CardKind {
    // atomic — each grades exactly one test
    PhraseFill { position: u16 },
    PhraseChain { position: u16 },
    VerseAtVerseRef,
    VerseInChapter,
    VerseInBook,
    VerseInHeading { heading_idx: u16 },
    VerseInClub { tier: ClubTier },
    // composite — each grades many tests
    Recitation,
    Citation,
    Ftv { with_citation: bool },
    Holistic,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Card {
    pub id: CardId,
    pub shown: Vec<NodeId>,
    pub hidden: Vec<NodeId>,
    pub state: CardState,
    #[serde(default)]
    pub kind: Option<CardKind>,
    #[serde(default)]
    pub verse_id: Option<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CardSchedule {
    pub card_id: CardId,
    pub due_r: f32,
    pub due_date_secs: i64,
    pub priority: f32,
}

#[derive(Debug, Clone)]
pub struct VerseAtoms {
    pub verse_id: u32,
    pub phrase_count: u16,
    pub headings: Vec<u16>,
    pub clubs: Vec<ClubTier>,
    pub ftv: Option<String>,
    pub phrase_zero_text: Option<String>,
}

impl VerseAtoms {
    pub fn phrase_positions(&self) -> Vec<u16> {
        (0..self.phrase_count).collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn card_kind_serializes() {
        let k = CardKind::PhraseFill { position: 1 };
        let j = serde_json::to_string(&k).unwrap();
        let r: CardKind = serde_json::from_str(&j).unwrap();
        assert_eq!(k, r);
    }

    #[test]
    fn verse_atoms_phrase_positions() {
        let atoms = VerseAtoms {
            verse_id: 1,
            phrase_count: 3,
            headings: vec![0],
            clubs: vec![ClubTier::First],
            ftv: Some("For God".into()),
            phrase_zero_text: Some("For God so loved".into()),
        };
        assert_eq!(atoms.phrase_positions(), vec![0u16, 1, 2]);
    }
}
