use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum ClubTier {
    First,
    Second,
    Third,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(tag = "kind")]
pub enum ElementId {
    Phrase { verse_id: u32, position: u16 },
    VerseRefPosition { verse_id: u32 },
    VerseChapterBinding { verse_id: u32 },
    VerseBookBinding { verse_id: u32 },
    VerseHeadingBinding { verse_id: u32, heading_idx: u16 },
    VerseClubBinding { verse_id: u32, tier: ClubTier },
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn element_id_serializes() {
        let e = ElementId::Phrase {
            verse_id: 1,
            position: 0,
        };
        let j = serde_json::to_string(&e).unwrap();
        let r: ElementId = serde_json::from_str(&j).unwrap();
        assert_eq!(e, r);
    }
}
