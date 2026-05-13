use serde::{Deserialize, Serialize};

use crate::element::ClubTier;

/// Per-user, per-year material configuration consumed by the builder.
///
/// Six card kinds are always emitted regardless of config — `PhraseFill`,
/// `Recitation`, `VerseAtVerseRef`, `VerseInChapter`, `VerseInBook`, and
/// `Citation`. They are the core memorisation mechanic and have no
/// meaningful "off" state.
///
/// `VerseInClub` is emitted iff `club_cards` is on *and* the verse's
/// most-specific tier isn't in `paused_clubs`.
///
/// `Default` is everything-on with no paused clubs. Callers that don't
/// care about per-user filtering (the simulation, regression tests) can
/// pass `&MaterialConfig::default()`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct MaterialConfig {
    pub headings: bool,
    pub ftv: bool,
    /// Emit `VerseInClub` cards (asks "which club is this verse in?").
    /// This is the *only* card kind that grades the `VerseClubBinding`
    /// test — turning the toggle off drops the test from the engine
    /// entirely. Recitation and Citation grade the verseref / chapter /
    /// book bindings only.
    #[serde(default = "default_true")]
    pub club_cards: bool,
    /// Tiers whose verses are excluded from the build. Verses whose
    /// most-specific tier is in this set produce no cards. The picker
    /// drives this from per-(year, club) status: `Paused` → included
    /// here, `Active` and `Maintenance` → excluded.
    #[serde(default)]
    pub paused_clubs: Vec<ClubTier>,
}

fn default_true() -> bool {
    true
}

impl Default for MaterialConfig {
    fn default() -> Self {
        Self {
            headings: true,
            ftv: true,
            club_cards: true,
            paused_clubs: Vec::new(),
        }
    }
}

impl MaterialConfig {
    /// True iff this verse's most-specific tier is in `paused_clubs`.
    /// Untagged verses (no club at all) are never filtered out — they
    /// represent canonical-but-untiered content like a future "common"
    /// bucket. The picker can't reach them through the per-club status UI
    /// anyway.
    pub fn verse_is_paused(&self, verse_clubs: &[ClubTier]) -> bool {
        match verse_clubs.first() {
            Some(t) => self.paused_clubs.contains(t),
            None => false,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_is_everything_on() {
        let c = MaterialConfig::default();
        assert!(c.headings);
        assert!(c.ftv);
        assert!(c.club_cards);
        assert!(c.paused_clubs.is_empty());
    }

    #[test]
    fn round_trips_through_json() {
        let c = MaterialConfig {
            headings: false,
            ftv: true,
            club_cards: false,
            paused_clubs: vec![ClubTier::Club300],
        };
        let j = serde_json::to_string(&c).unwrap();
        let back: MaterialConfig = serde_json::from_str(&j).unwrap();
        assert_eq!(c, back);
    }

    #[test]
    fn optional_fields_default_when_absent_in_json() {
        // Older clients / DB rows may omit paused_clubs or club_cards.
        // Default to everything-on and no paused clubs so partial JSON
        // deserialises cleanly.
        let c: MaterialConfig = serde_json::from_str(r#"{"headings":true,"ftv":true}"#).unwrap();
        assert!(c.club_cards);
        assert!(c.paused_clubs.is_empty());
    }

    #[test]
    fn verse_is_paused_checks_most_specific_tier() {
        let c = MaterialConfig {
            paused_clubs: vec![ClubTier::Club300],
            ..MaterialConfig::default()
        };
        assert!(c.verse_is_paused(&[ClubTier::Club300]));
        assert!(!c.verse_is_paused(&[ClubTier::Club150]));
        // Defensive: parse_tiers shouldn't hand us an empty list, but a
        // call site that does pass empty tiers (e.g. partially-built
        // test atoms) won't be filtered out.
        assert!(!c.verse_is_paused(&[]));
    }
}
