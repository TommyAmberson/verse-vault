use serde::{Deserialize, Serialize};

use crate::club_status::ClubStatus;
use crate::element::ClubTier;

/// How far up the tier ladder a "scope" reaches. `Up150` includes only
/// `Club150` verses; `Up300` includes both `Club150` and `Club300`;
/// `All` includes every verse. Used for the per-verse club card, the
/// per-(year) Active scope, and the per-(year) Maintenance scope.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
pub enum TierScope {
    Off,
    Up150,
    Up300,
    #[default]
    All,
}

impl TierScope {
    pub fn includes(&self, tier: ClubTier) -> bool {
        match self {
            TierScope::Off => false,
            TierScope::Up150 => tier == ClubTier::Club150,
            TierScope::Up300 => matches!(tier, ClubTier::Club150 | ClubTier::Club300),
            TierScope::All => true,
        }
    }
}

/// Like `TierScope`, but `Full` is intentionally absent — listing every
/// verse in a chapter isn't a meaningful quizzing test.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
pub enum ChapterListScope {
    Off,
    Up150,
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
/// All four scopes share the same "up to which tier" mental model:
///
/// - `active_scope`: tiers where the user is currently memorizing new
///   verses (and reviewing existing ones).
/// - `maintenance_scope`: tiers the user is reviewing but not introducing
///   new verses for. `Active` wins where both reach — i.e. the effective
///   status for a tier is `Active` if `active_scope` covers it, else
///   `Maintenance` if `maintenance_scope` does, else `Paused`.
/// - `club_card_scope`: which tiers get the per-verse "which club?" card.
/// - `chapter_list_scope`: which tiers get the chapter-list card.
///
/// `headings` and `ftv` are independent bool toggles.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct MaterialConfig {
    pub headings: bool,
    pub ftv: bool,
    #[serde(default)]
    pub active_scope: TierScope,
    /// Defaults to `Off` when absent — most users won't have a separate
    /// review-only tier set, so the natural "missing field" semantics
    /// are "nothing in maintenance".
    #[serde(default = "tier_scope_off")]
    pub maintenance_scope: TierScope,
    #[serde(default)]
    pub club_card_scope: TierScope,
    #[serde(default)]
    pub chapter_list_scope: ChapterListScope,
}

fn tier_scope_off() -> TierScope {
    TierScope::Off
}

impl Default for MaterialConfig {
    fn default() -> Self {
        Self {
            headings: true,
            ftv: true,
            active_scope: TierScope::All,
            maintenance_scope: TierScope::Off,
            club_card_scope: TierScope::All,
            chapter_list_scope: ChapterListScope::Up300,
        }
    }
}

impl MaterialConfig {
    /// Effective per-tier status, derived from the two scopes. Active
    /// dominates Maintenance where they overlap; tiers neither scope
    /// includes are `Paused`.
    pub fn effective_status(&self, tier: ClubTier) -> ClubStatus {
        if self.active_scope.includes(tier) {
            ClubStatus::Active
        } else if self.maintenance_scope.includes(tier) {
            ClubStatus::Maintenance
        } else {
            ClubStatus::Paused
        }
    }

    /// True iff this verse's most-specific tier is paused — neither
    /// scope covers it. `parse_tiers` guarantees every verse has at
    /// least one tier (Full when no narrower tag), so the empty branch
    /// is defensive only.
    pub fn verse_is_paused(&self, verse_clubs: &[ClubTier]) -> bool {
        match verse_clubs.first() {
            Some(t) => self.effective_status(*t) == ClubStatus::Paused,
            None => false,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_is_everything_active() {
        let c = MaterialConfig::default();
        assert!(c.headings);
        assert!(c.ftv);
        assert_eq!(c.active_scope, TierScope::All);
        assert_eq!(c.maintenance_scope, TierScope::Off);
        for tier in [ClubTier::Club150, ClubTier::Club300, ClubTier::Full] {
            assert_eq!(c.effective_status(tier), ClubStatus::Active);
        }
    }

    #[test]
    fn tier_scope_inclusion_is_cumulative() {
        for tier in [ClubTier::Club150, ClubTier::Club300, ClubTier::Full] {
            assert!(!TierScope::Off.includes(tier));
        }
        assert!(TierScope::Up150.includes(ClubTier::Club150));
        assert!(!TierScope::Up150.includes(ClubTier::Club300));
        assert!(!TierScope::Up150.includes(ClubTier::Full));

        assert!(TierScope::Up300.includes(ClubTier::Club150));
        assert!(TierScope::Up300.includes(ClubTier::Club300));
        assert!(!TierScope::Up300.includes(ClubTier::Full));

        for tier in [ClubTier::Club150, ClubTier::Club300, ClubTier::Full] {
            assert!(TierScope::All.includes(tier));
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
    fn effective_status_active_dominates_maintenance() {
        // Active up to 150, Maintenance up to 300:
        //   Club 150 → Active (both cover it, Active wins)
        //   Club 300 → Maintenance (only Maint covers)
        //   Full     → Paused (neither covers)
        let c = MaterialConfig {
            active_scope: TierScope::Up150,
            maintenance_scope: TierScope::Up300,
            ..MaterialConfig::default()
        };
        assert_eq!(c.effective_status(ClubTier::Club150), ClubStatus::Active);
        assert_eq!(
            c.effective_status(ClubTier::Club300),
            ClubStatus::Maintenance
        );
        assert_eq!(c.effective_status(ClubTier::Full), ClubStatus::Paused);
    }

    #[test]
    fn effective_status_maintenance_alone() {
        // Active off, Maintenance up to Full → everything in Maintenance.
        let c = MaterialConfig {
            active_scope: TierScope::Off,
            maintenance_scope: TierScope::All,
            ..MaterialConfig::default()
        };
        for tier in [ClubTier::Club150, ClubTier::Club300, ClubTier::Full] {
            assert_eq!(c.effective_status(tier), ClubStatus::Maintenance);
        }
    }

    #[test]
    fn effective_status_all_paused_when_both_scopes_off() {
        let c = MaterialConfig {
            active_scope: TierScope::Off,
            maintenance_scope: TierScope::Off,
            ..MaterialConfig::default()
        };
        for tier in [ClubTier::Club150, ClubTier::Club300, ClubTier::Full] {
            assert_eq!(c.effective_status(tier), ClubStatus::Paused);
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
    fn missing_scopes_default_to_widest() {
        // Older JSON may omit scopes. Default to All / Off / All / Up300
        // — Active covers everything, Maintenance is off (nothing in
        // review-only state by default).
        let c: MaterialConfig = serde_json::from_str(r#"{"headings":true,"ftv":true}"#).unwrap();
        assert_eq!(c.active_scope, TierScope::All);
        assert_eq!(c.maintenance_scope, TierScope::Off);
        assert_eq!(c.club_card_scope, TierScope::All);
        assert_eq!(c.chapter_list_scope, ChapterListScope::Up300);
    }
}
