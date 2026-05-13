use std::collections::HashMap;

use serde::{Deserialize, Serialize};

use crate::club_status::ClubStatus;
use crate::element::ClubTier;

/// Per-user, per-year material configuration consumed by the builder.
///
/// Year-wide toggles (`headings`, `ftv`) gate card kinds that aren't
/// intrinsically club-scoped. Anything that is — the standalone
/// `VerseInClub` card and the chapter-list card — lives per-tier in
/// `clubs`.
///
/// `Default` activates every tier (`Club150` / `Club300` / `Full`) with
/// the club-card toggle on. Callers that don't care about per-user
/// filtering (the simulation, regression tests) can pass
/// `&MaterialConfig::default()`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct MaterialConfig {
    pub headings: bool,
    pub ftv: bool,
    #[serde(default)]
    pub clubs: HashMap<ClubTier, ClubConfig>,
}

/// Per-(year, club) configuration.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct ClubConfig {
    pub status: ClubStatus,
    /// Emit the per-verse `VerseInClub` "which club is this verse in?"
    /// card for verses in this tier.
    pub club_cards: bool,
    /// Emit per-chapter `ChapterClubList` cards: prompt is the chapter,
    /// answer is the list of verses in that chapter belonging to this
    /// tier. Only meaningful for tiers where the list is non-trivial;
    /// for `Full` it can be turned off.
    #[serde(default = "default_true")]
    pub chapter_lists: bool,
}

fn default_true() -> bool {
    true
}

impl ClubConfig {
    /// Convenience: active tier with the club card on.
    pub fn active() -> Self {
        Self {
            status: ClubStatus::Active,
            club_cards: true,
            chapter_lists: true,
        }
    }

    /// Convenience: paused tier (status alone gates everything else).
    pub fn paused() -> Self {
        Self {
            status: ClubStatus::Paused,
            club_cards: false,
            chapter_lists: false,
        }
    }
}

impl Default for MaterialConfig {
    fn default() -> Self {
        let mut clubs = HashMap::new();
        clubs.insert(ClubTier::Club150, ClubConfig::active());
        clubs.insert(ClubTier::Club300, ClubConfig::active());
        clubs.insert(ClubTier::Full, ClubConfig::active());
        Self {
            headings: true,
            ftv: true,
            clubs,
        }
    }
}

impl MaterialConfig {
    /// Lookup for a tier, falling back to `Paused`-with-no-cards when the
    /// tier isn't in the map. Used by the builder's per-verse filter.
    pub fn for_tier(&self, tier: ClubTier) -> ClubConfig {
        self.clubs
            .get(&tier)
            .copied()
            .unwrap_or_else(ClubConfig::paused)
    }

    /// True iff this verse's most-specific tier is paused.
    /// `parse_tiers` guarantees every verse has at least one tier (Full
    /// when no narrower tag), so the empty branch is defensive only.
    pub fn verse_is_paused(&self, verse_clubs: &[ClubTier]) -> bool {
        match verse_clubs.first() {
            Some(t) => self.for_tier(*t).status == ClubStatus::Paused,
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
        for tier in [ClubTier::Club150, ClubTier::Club300, ClubTier::Full] {
            let cc = c.for_tier(tier);
            assert_eq!(cc.status, ClubStatus::Active);
            assert!(cc.club_cards);
        }
    }

    #[test]
    fn round_trips_through_json() {
        let c = MaterialConfig::default();
        let j = serde_json::to_string(&c).unwrap();
        let back: MaterialConfig = serde_json::from_str(&j).unwrap();
        assert_eq!(c, back);
    }

    #[test]
    fn missing_clubs_field_defaults_to_empty_map() {
        // Older JSON may omit `clubs`. Each tier then falls back to
        // ClubConfig::paused() via for_tier(), which is the safe default.
        let c: MaterialConfig = serde_json::from_str(r#"{"headings":true,"ftv":true}"#).unwrap();
        assert!(c.clubs.is_empty());
        assert_eq!(c.for_tier(ClubTier::Club150).status, ClubStatus::Paused);
    }

    #[test]
    fn verse_is_paused_checks_most_specific_tier() {
        let mut clubs = HashMap::new();
        clubs.insert(ClubTier::Club150, ClubConfig::active());
        clubs.insert(ClubTier::Club300, ClubConfig::paused());
        let c = MaterialConfig {
            clubs,
            ..MaterialConfig::default()
        };
        assert!(c.verse_is_paused(&[ClubTier::Club300]));
        assert!(!c.verse_is_paused(&[ClubTier::Club150]));
    }
}
