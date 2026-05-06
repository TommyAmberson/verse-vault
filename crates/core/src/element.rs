use serde::{Deserialize, Serialize};

/// Bible-quizzer club tier: verses are grouped into clubs by total
/// memorisation count (the 150-verse club, the 300-verse club, etc.).
/// A verse tagged at one tier is implicitly in higher tiers too — see
/// the tier-subset rule in `builder::expand_tiers`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum ClubTier {
    Club150,
    Club300,
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

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", content = "value")]
pub enum ElementMeta {
    ChapterNumber(u16),
    BookName(String),
    HeadingLabel(String),
    VerseNumber(u16),
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

    #[test]
    fn element_meta_chapter_number() {
        let m = ElementMeta::ChapterNumber(3);
        let j = serde_json::to_string(&m).unwrap();
        assert_eq!(j, r#"{"kind":"ChapterNumber","value":3}"#);
    }
}
