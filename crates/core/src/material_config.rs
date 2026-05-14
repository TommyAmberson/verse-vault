use serde::{Deserialize, Serialize};

use crate::element::ClubTier;

/// Per-(year, club) status that the user controls via the material picker.
///
/// The "year" is implicit in the user's engine instance — one engine is
/// built per (user, year). The "club" is the verse's most-specific club
/// tier from `parse_tiers`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum ClubStatus {
    Active,
    Maintenance,
    Paused,
}

/// How far up the tier ladder a "scope" reaches. `Up150` includes only
/// `Club150` verses; `Up300` includes both `Club150` and `Club300`;
/// `All` includes every verse. Used for the per-verse club card, the
/// per-(year) Active scope, and the per-(year) Maintenance scope.
///
/// Wire form is camelCase (`off` / `up150` / `up300` / `all`) so the
/// API can ship the same lowercase strings it stores in the DB straight
/// through to the Rust serde layer with no translation step.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
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
/// verse in a chapter isn't a meaningful quizzing test. Same camelCase
/// wire form as `TierScope`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
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
/// The four scopes are independent levers on the "up to which tier" axis:
///
/// - `new_scope`: tiers that introduce new verses via /memorize.
/// - `review_scope`: tiers whose verses surface in /review.
/// - `club_card_scope`: which tiers get the per-verse "which club?" card.
/// - `chapter_list_scope`: which tiers get the chapter-list card.
///
/// `new` and `review` are orthogonal — a tier covered by both is the
/// usual "Active" state; review-only is "Maintenance"; covered by
/// neither is "Paused". (New-only is the rare edge case where the user
/// is introducing verses without re-surfacing them; still valid, just
/// unusual.)
///
/// `headings` and `ftv` are independent bool toggles.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct MaterialConfig {
    pub headings: bool,
    pub ftv: bool,
    #[serde(default)]
    pub new_scope: TierScope,
    #[serde(default)]
    pub review_scope: TierScope,
    #[serde(default)]
    pub club_card_scope: TierScope,
    #[serde(default)]
    pub chapter_list_scope: ChapterListScope,
}

impl Default for MaterialConfig {
    fn default() -> Self {
        Self {
            headings: true,
            ftv: true,
            new_scope: TierScope::All,
            review_scope: TierScope::All,
            club_card_scope: TierScope::All,
            chapter_list_scope: ChapterListScope::Up300,
        }
    }
}

impl MaterialConfig {
    /// Effective per-tier status, derived from the two scopes.
    ///
    /// | new | review | status        |
    /// |-----|--------|---------------|
    /// |  ✓  |   ✓    | `Active`      |
    /// |  ✗  |   ✓    | `Maintenance` |
    /// |  ✓  |   ✗    | `Active`*     |
    /// |  ✗  |   ✗    | `Paused`      |
    ///
    /// *new-only is mapped to `Active` since it's most-similar to the
    /// "user is actively studying this tier" intent, even though they've
    /// switched off review for it.
    pub fn effective_status(&self, tier: ClubTier) -> ClubStatus {
        let n = self.new_scope.includes(tier);
        let r = self.review_scope.includes(tier);
        match (n, r) {
            (false, false) => ClubStatus::Paused,
            (false, true) => ClubStatus::Maintenance,
            (true, _) => ClubStatus::Active,
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
        assert_eq!(c.new_scope, TierScope::All);
        assert_eq!(c.review_scope, TierScope::All);
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
    fn effective_status_combines_two_scopes() {
        // new=Up150, review=Up300:
        //   Club 150 → Active   (both cover it)
        //   Club 300 → Maintenance (only review covers)
        //   Full     → Paused   (neither covers)
        let c = MaterialConfig {
            new_scope: TierScope::Up150,
            review_scope: TierScope::Up300,
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
    fn effective_status_review_only() {
        let c = MaterialConfig {
            new_scope: TierScope::Off,
            review_scope: TierScope::All,
            ..MaterialConfig::default()
        };
        for tier in [ClubTier::Club150, ClubTier::Club300, ClubTier::Full] {
            assert_eq!(c.effective_status(tier), ClubStatus::Maintenance);
        }
    }

    #[test]
    fn effective_status_all_paused_when_both_scopes_off() {
        let c = MaterialConfig {
            new_scope: TierScope::Off,
            review_scope: TierScope::Off,
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
        // Older JSON may omit scopes. Default everything to All / Up300.
        let c: MaterialConfig = serde_json::from_str(r#"{"headings":true,"ftv":true}"#).unwrap();
        assert_eq!(c.new_scope, TierScope::All);
        assert_eq!(c.review_scope, TierScope::All);
        assert_eq!(c.club_card_scope, TierScope::All);
        assert_eq!(c.chapter_list_scope, ChapterListScope::Up300);
    }
}
