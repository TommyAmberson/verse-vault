use std::collections::HashMap;

use serde::{Deserialize, Serialize};

use crate::club_status::ClubStatus;
use crate::element::ClubTier;

/// Which tiers get per-verse `VerseInClub` "which club is this verse in?"
/// cards. Higher variants include all lower variants.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
pub enum ClubCardScope {
    Off,
    /// Only verses tagged `Club150` get the card.
    Up150,
    /// Verses tagged `Club150` or `Club300` get the card.
    Up300,
    /// Every verse gets the card, including `Full` (no narrower tag).
    #[default]
    All,
}

impl ClubCardScope {
    pub fn includes(&self, tier: ClubTier) -> bool {
        match self {
            ClubCardScope::Off => false,
            ClubCardScope::Up150 => tier == ClubTier::Club150,
            ClubCardScope::Up300 => matches!(tier, ClubTier::Club150 | ClubTier::Club300),
            ClubCardScope::All => true,
        }
    }
}

/// Which tiers get the per-chapter "list the tier-T verses in this
/// chapter" card. `Full` is intentionally absent — listing every verse
/// in a chapter isn't a meaningful quizzing test.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
pub enum ChapterListScope {
    Off,
    /// One card per chapter listing its `Club150` verses.
    Up150,
    /// Two cards per chapter: one for `Club150` verses, one for
    /// `Club300`-tagged-only verses. The 300 card never strengthens
    /// the 150 binding because its members are *exactly* 300-tagged.
    #[default]
    Up300,
}

impl ChapterListScope {
    pub fn includes(&self, tier: ClubTier) -> bool {
        match self {
            ChapterListScope::Off => false,
            ChapterListScope::Up150 => tier == ClubTier::Club150,
            ChapterListScope::Up300 => matches!(tier, ClubTier::Club150 | ClubTier::Club300),
        }
    }
}

/// Per-user, per-year material configuration consumed by the builder.
///
/// Year-wide toggles (`headings`, `ftv`) and year-wide scopes
/// (`club_card_scope`, `chapter_list_scope`) gate which card kinds are
/// emitted across the whole year. Per-club state — currently just
/// `ClubStatus` — lives in `clubs`.
///
/// `Default` activates every tier with both card scopes at their fullest
/// (chapter lists up to 300, per-verse club cards for every tier).
/// Callers that don't care about per-user filtering can pass
/// `&MaterialConfig::default()`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct MaterialConfig {
    pub headings: bool,
    pub ftv: bool,
    #[serde(default)]
    pub club_card_scope: ClubCardScope,
    #[serde(default)]
    pub chapter_list_scope: ChapterListScope,
    #[serde(default)]
    pub clubs: HashMap<ClubTier, ClubStatus>,
}

impl Default for MaterialConfig {
    fn default() -> Self {
        let mut clubs = HashMap::new();
        clubs.insert(ClubTier::Club150, ClubStatus::Active);
        clubs.insert(ClubTier::Club300, ClubStatus::Active);
        clubs.insert(ClubTier::Full, ClubStatus::Active);
        Self {
            headings: true,
            ftv: true,
            club_card_scope: ClubCardScope::All,
            chapter_list_scope: ChapterListScope::Up300,
            clubs,
        }
    }
}

impl MaterialConfig {
    /// Effective status for a tier — `Paused` for tiers the user hasn't
    /// opted into. Used by the builder's per-verse filter.
    pub fn status_for(&self, tier: ClubTier) -> ClubStatus {
        self.clubs.get(&tier).copied().unwrap_or(ClubStatus::Paused)
    }

    /// True iff this verse's most-specific tier is paused.
    /// `parse_tiers` guarantees every verse has at least one tier (Full
    /// when no narrower tag), so the empty branch is defensive only.
    pub fn verse_is_paused(&self, verse_clubs: &[ClubTier]) -> bool {
        match verse_clubs.first() {
            Some(t) => self.status_for(*t) == ClubStatus::Paused,
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
        assert_eq!(c.club_card_scope, ClubCardScope::All);
        assert_eq!(c.chapter_list_scope, ChapterListScope::Up300);
        for tier in [ClubTier::Club150, ClubTier::Club300, ClubTier::Full] {
            assert_eq!(c.status_for(tier), ClubStatus::Active);
        }
    }

    #[test]
    fn club_card_scope_inclusion() {
        for tier in [ClubTier::Club150, ClubTier::Club300, ClubTier::Full] {
            assert!(!ClubCardScope::Off.includes(tier));
        }
        assert!(ClubCardScope::Up150.includes(ClubTier::Club150));
        assert!(!ClubCardScope::Up150.includes(ClubTier::Club300));
        assert!(!ClubCardScope::Up150.includes(ClubTier::Full));

        assert!(ClubCardScope::Up300.includes(ClubTier::Club150));
        assert!(ClubCardScope::Up300.includes(ClubTier::Club300));
        assert!(!ClubCardScope::Up300.includes(ClubTier::Full));

        for tier in [ClubTier::Club150, ClubTier::Club300, ClubTier::Full] {
            assert!(ClubCardScope::All.includes(tier));
        }
    }

    #[test]
    fn chapter_list_scope_never_includes_full() {
        for scope in [
            ChapterListScope::Off,
            ChapterListScope::Up150,
            ChapterListScope::Up300,
        ] {
            assert!(!scope.includes(ClubTier::Full));
        }
        assert!(ChapterListScope::Up150.includes(ClubTier::Club150));
        assert!(!ChapterListScope::Up150.includes(ClubTier::Club300));
        assert!(ChapterListScope::Up300.includes(ClubTier::Club150));
        assert!(ChapterListScope::Up300.includes(ClubTier::Club300));
    }

    #[test]
    fn round_trips_through_json() {
        let c = MaterialConfig::default();
        let j = serde_json::to_string(&c).unwrap();
        let back: MaterialConfig = serde_json::from_str(&j).unwrap();
        assert_eq!(c, back);
    }

    #[test]
    fn missing_scopes_default_to_widest() {
        // Older JSON may omit scopes. Default to All / Up300 so partial
        // JSON gives the most-on behaviour and the user opts down.
        let c: MaterialConfig = serde_json::from_str(r#"{"headings":true,"ftv":true}"#).unwrap();
        assert_eq!(c.club_card_scope, ClubCardScope::All);
        assert_eq!(c.chapter_list_scope, ChapterListScope::Up300);
    }

    #[test]
    fn verse_is_paused_checks_most_specific_tier() {
        let mut clubs = HashMap::new();
        clubs.insert(ClubTier::Club150, ClubStatus::Active);
        clubs.insert(ClubTier::Club300, ClubStatus::Paused);
        let c = MaterialConfig {
            clubs,
            ..MaterialConfig::default()
        };
        assert!(c.verse_is_paused(&[ClubTier::Club300]));
        assert!(!c.verse_is_paused(&[ClubTier::Club150]));
    }
}
