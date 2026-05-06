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
}
