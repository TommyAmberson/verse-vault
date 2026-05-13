use serde::{Deserialize, Serialize};

/// Bible-quizzer club tier: verses are grouped into clubs by total
/// memorisation count. `Club150` is the core 150-verse set; `Club300`
/// is the broader extension; `Full` is the catch-all for verses that
/// belong to neither narrower club (i.e. memorised only when competing
/// at the full-curriculum level).
///
/// A verse tagged at one tier is implicitly in every higher tier too,
/// but the `VerseInClub` card / `VerseClubBinding` test stores only the
/// *most specific* tier — the broader memberships are trivially derived.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum ClubTier {
    Club150,
    Club300,
    Full,
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
