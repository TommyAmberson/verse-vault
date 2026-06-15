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
/// `All` includes every verse.
///
/// Retained post-Phase-1 for `club_card_scope` (which still ladders
/// across tiers — its spec rework is deferred) and for the legacy
/// `(new_scope, review_scope)` deserialization path that maps old
/// configs into the per-club shape on read.
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
    #[default]
    Up150,
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

/// How a club's pool is ordered when the user is behind the calendar.
///
/// `Sequential` ignores the calendar entirely — the pool is "next
/// un-memorized verse in canonical (deck/passage) order." Catches up
/// automatically when behind, rolls ahead naturally when caught up.
///
/// `CalendarCascade` prefers this week's calendar row first (Phase 1
/// of the memorize fill), then falls through to backlog and lookahead
/// via Phase 2. Users on a strict league schedule pick this; one-verse-
/// a-day users typically don't.
///
/// JSON form is camelCase (`sequential` / `calendarCascade`) — matches
/// the per-club shape the API uses for the new fields.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub enum CatchUp {
    #[default]
    Sequential,
    CalendarCascade,
}

/// Per-club memorize configuration: is the club introducing new verses,
/// and if so, how is its pool ordered when the user is behind?
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClubMemorizeConfig {
    pub enabled: bool,
    #[serde(default)]
    pub catch_up: CatchUp,
}

impl Default for ClubMemorizeConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            catch_up: CatchUp::Sequential,
        }
    }
}

/// Per-club review configuration: is the club's verses surfacing in
/// /review, and what target retention does the scheduler aim at for
/// those cards?
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClubReviewConfig {
    pub enabled: bool,
    /// Valid range `[0.5, 0.9]`. Stored as the user-set value; the
    /// scheduler reads it through `MaterialConfig::target_r_for` which
    /// applies the clamp on read for defence-in-depth.
    pub desired_retention: f32,
}

impl Default for ClubReviewConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            desired_retention: DEFAULT_REVIEW_RETENTION,
        }
    }
}

/// When does the lower club's pool become eligible to contribute to a
/// memorize session? Applied per adjacent pair (`p150_to_300` between
/// Club 150 and Club 300, `p300_to_full` between Club 300 and Full).
///
/// Each variant describes a condition on the higher club's progress
/// against the schedule; gate-open means the lower club enters the
/// eligible set for Phase 2's canonical-order fill. Eligibility is
/// independent of fill priority — once eligible, both clubs interleave
/// by deck position.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub enum MoveToNextGate {
    /// Lower club waits until the higher is fully memorized
    /// (strict drain).
    FullyMemorized,
    /// Lower club enters after the higher's verses through the most
    /// recent past meet are all memorized. Never open before the
    /// season's first meet.
    AfterMajorCheckpoint,
    /// Lower club enters once the higher's this-week row is done.
    AfterMinorCheckpoint,
    /// Lower club is eligible whenever the higher's user position is
    /// at or past the previous week's checkpoint. Open by default at
    /// season start (no previous checkpoint yet).
    #[default]
    CaughtUp,
    /// No gate — lower always eligible.
    Always,
}

/// Per-adjacent-pair cross-club gates.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MoveToNextConfig {
    pub p150_to_300: MoveToNextGate,
    pub p300_to_full: MoveToNextGate,
}

impl Default for MoveToNextConfig {
    fn default() -> Self {
        Self {
            p150_to_300: MoveToNextGate::default(),
            p300_to_full: MoveToNextGate::default(),
        }
    }
}

/// Three named slots indexed by `ClubTier`. JSON wire form is
/// `{"club150": …, "club300": …, "full": …}` — chosen over a HashMap
/// keyed by the tier enum for explicit field shapes and zero-cost
/// indexing.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClubMemorizeMap {
    #[serde(default)]
    pub club150: ClubMemorizeConfig,
    #[serde(default)]
    pub club300: ClubMemorizeConfig,
    #[serde(default)]
    pub full: ClubMemorizeConfig,
}

impl Default for ClubMemorizeMap {
    fn default() -> Self {
        Self {
            club150: ClubMemorizeConfig::default(),
            club300: ClubMemorizeConfig::default(),
            full: ClubMemorizeConfig::default(),
        }
    }
}

impl ClubMemorizeMap {
    pub fn get(&self, tier: ClubTier) -> ClubMemorizeConfig {
        match tier {
            ClubTier::Club150 => self.club150,
            ClubTier::Club300 => self.club300,
            ClubTier::Full => self.full,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClubReviewMap {
    #[serde(default)]
    pub club150: ClubReviewConfig,
    #[serde(default)]
    pub club300: ClubReviewConfig,
    #[serde(default)]
    pub full: ClubReviewConfig,
}

impl Default for ClubReviewMap {
    fn default() -> Self {
        Self {
            club150: ClubReviewConfig::default(),
            club300: ClubReviewConfig::default(),
            full: ClubReviewConfig::default(),
        }
    }
}

impl ClubReviewMap {
    pub fn get(&self, tier: ClubTier) -> ClubReviewConfig {
        match tier {
            ClubTier::Club150 => self.club150,
            ClubTier::Club300 => self.club300,
            ClubTier::Full => self.full,
        }
    }
}

pub const DEFAULT_REVIEW_RETENTION: f32 = 0.8;
pub const MIN_REVIEW_RETENTION: f32 = 0.5;
pub const MAX_REVIEW_RETENTION: f32 = 0.9;
pub const DEFAULT_LESSON_BATCH_SIZE: u8 = 1;

/// Per-user, per-material configuration consumed by the builder and the
/// scheduler.
///
/// The per-club shape replaces the prior flat `(new_scope, review_scope,
/// desired_retention)` triple — `memorize.{tier}.enabled` controls whether
/// a club introduces new verses via /memorize; `review.{tier}.enabled`
/// controls whether its verses surface in /review; `review.{tier}.desired_retention`
/// is the per-club FSRS target. Card-kind toggles (`heading_card`,
/// `heading_passage_card`, `ftv`, `club_card_scope`, `chapter_list_scope`)
/// are unchanged.
///
/// `Active`/`Maintenance`/`Paused` per tier is derived from the orthogonal
/// memorize+review pair:
/// `(memorize ✓, review *)` → `Active`, `(memorize ✗, review ✓)` →
/// `Maintenance`, `(memorize ✗, review ✗)` → `Paused`.
///
/// JSON wire form keeps the legacy fields' snake_case names
/// (`new_scope`, `review_scope`, `heading_card`, `club_card_scope`,
/// `chapter_list_scope`, `desired_retention`) because that's what the
/// existing API → wasm path emits. The new per-club fields (`memorize`,
/// `move_to_next`, `review`, `lesson_batch_size`) and the new nested
/// shapes use camelCase since they're new contract surface. Legacy
/// scope JSON parses via `MaterialConfigRaw`'s `from` adapter into the
/// per-club shape on read.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(from = "MaterialConfigRaw")]
pub struct MaterialConfig {
    /// Per-verse "which heading?" card. Defaults off: the passage-cued
    /// version (`heading_passage_card`) is the primary heading test; the
    /// per-verse version is high-volume, low-signal for most learners.
    pub heading_card: bool,
    /// `HeadingPassage` ("what heading is this whole passage under?")
    /// card. Defaults on.
    pub heading_passage_card: bool,
    /// FTV (finish-the-verse) prompts. Defaults on.
    pub ftv: bool,
    /// Which clubs get the per-verse `VerseInClub` ("which club is this
    /// verse in?") card. Still a `TierScope` ladder; reshape to per-club
    /// booleans deferred to Phase 2 (UI rework) per the spec's open
    /// questions.
    pub club_card_scope: TierScope,
    /// Which clubs get the chapter-list card. Same `ChapterListScope`
    /// ladder as today.
    pub chapter_list_scope: ChapterListScope,
    /// Per-club memorize config. `enabled` is the source of truth for
    /// "is this club introducing new verses?"; `catch_up` picks the
    /// pool ordering when behind.
    pub memorize: ClubMemorizeMap,
    /// Per-adjacent-pair cross-club gates.
    pub move_to_next: MoveToNextConfig,
    /// Per-club review config — `enabled` + `desired_retention`.
    pub review: ClubReviewMap,
    /// Target verses per memorize session. Default `1`. The actual
    /// session size passed to the wasm `memorize_session_v2` call still
    /// rides as an explicit parameter; this field stores the per-material
    /// preference the client uses to populate it.
    pub lesson_batch_size: u8,
}

/// Deserialization adapter accepting both the legacy flat shape
/// (`new_scope`, `review_scope`, `desired_retention`) and the per-club
/// shape. Missing fields fall back to defaults; legacy fields, when the
/// per-club fields aren't present, derive the per-club values per the
/// spec's migration table. Field names use snake_case to match the
/// existing API → wasm wire contract; the new per-club fields accept
/// camelCase aliases on top so the API can transition to the cleaner
/// form without a hard cutover.
#[derive(Debug, Default, Deserialize)]
#[serde(default)]
struct MaterialConfigRaw {
    #[serde(alias = "headings", alias = "headingCard")]
    heading_card: bool,
    #[serde(default = "default_true", alias = "headingPassageCard")]
    heading_passage_card: bool,
    #[serde(default = "default_true")]
    ftv: bool,
    #[serde(alias = "clubCardScope")]
    club_card_scope: Option<TierScope>,
    #[serde(alias = "chapterListScope")]
    chapter_list_scope: Option<ChapterListScope>,
    memorize: Option<ClubMemorizeMap>,
    #[serde(alias = "moveToNext")]
    move_to_next: Option<MoveToNextConfig>,
    review: Option<ClubReviewMap>,
    #[serde(alias = "lessonBatchSize")]
    lesson_batch_size: Option<u8>,
    // Legacy shape — only consulted when the per-club fields are absent.
    #[serde(alias = "newScope")]
    new_scope: Option<TierScope>,
    #[serde(alias = "reviewScope")]
    review_scope: Option<TierScope>,
    #[serde(alias = "desiredRetention")]
    desired_retention: Option<f32>,
}

fn default_true() -> bool {
    true
}

impl From<MaterialConfigRaw> for MaterialConfig {
    fn from(raw: MaterialConfigRaw) -> Self {
        let defaults = MaterialConfig::default();
        // Per-club fields explicit? use them. Else legacy fields present?
        // migrate per the spec's table. Else fall back to the new-user
        // default (Club 150 only). Distinguishing "empty JSON" from
        // "explicit new_scope: all" is critical — the former matches
        // Default::default() while the latter enables every club.
        let memorize = raw.memorize.unwrap_or_else(|| match raw.new_scope {
            Some(scope) => memorize_from_scope(scope),
            None => defaults.memorize,
        });
        let review = raw.review.unwrap_or_else(|| match raw.review_scope {
            Some(scope) => {
                let r = raw
                    .desired_retention
                    .unwrap_or(DEFAULT_REVIEW_RETENTION)
                    .clamp(MIN_REVIEW_RETENTION, MAX_REVIEW_RETENTION);
                review_from_scope(scope, r)
            }
            None => defaults.review,
        });
        Self {
            heading_card: raw.heading_card,
            heading_passage_card: raw.heading_passage_card,
            ftv: raw.ftv,
            club_card_scope: raw.club_card_scope.unwrap_or(defaults.club_card_scope),
            chapter_list_scope: raw
                .chapter_list_scope
                .unwrap_or(defaults.chapter_list_scope),
            memorize,
            move_to_next: raw.move_to_next.unwrap_or(defaults.move_to_next),
            review,
            lesson_batch_size: raw.lesson_batch_size.unwrap_or(defaults.lesson_batch_size),
        }
    }
}

fn memorize_from_scope(scope: TierScope) -> ClubMemorizeMap {
    ClubMemorizeMap {
        club150: ClubMemorizeConfig {
            enabled: scope.includes(ClubTier::Club150),
            catch_up: CatchUp::Sequential,
        },
        club300: ClubMemorizeConfig {
            enabled: scope.includes(ClubTier::Club300),
            catch_up: CatchUp::Sequential,
        },
        full: ClubMemorizeConfig {
            enabled: scope.includes(ClubTier::Full),
            catch_up: CatchUp::Sequential,
        },
    }
}

fn review_from_scope(scope: TierScope, desired_retention: f32) -> ClubReviewMap {
    ClubReviewMap {
        club150: ClubReviewConfig {
            enabled: scope.includes(ClubTier::Club150),
            desired_retention,
        },
        club300: ClubReviewConfig {
            enabled: scope.includes(ClubTier::Club300),
            desired_retention,
        },
        full: ClubReviewConfig {
            enabled: scope.includes(ClubTier::Full),
            desired_retention,
        },
    }
}

impl Default for MaterialConfig {
    /// New-user default per the spec: Club 150 enabled (memorize + review),
    /// others off, one verse a day, retention 0.8 across the board.
    fn default() -> Self {
        Self {
            heading_card: false,
            heading_passage_card: true,
            ftv: true,
            club_card_scope: TierScope::Off,
            chapter_list_scope: ChapterListScope::Up150,
            memorize: ClubMemorizeMap {
                club150: ClubMemorizeConfig {
                    enabled: true,
                    catch_up: CatchUp::Sequential,
                },
                club300: ClubMemorizeConfig::default(),
                full: ClubMemorizeConfig::default(),
            },
            move_to_next: MoveToNextConfig::default(),
            review: ClubReviewMap {
                club150: ClubReviewConfig {
                    enabled: true,
                    desired_retention: DEFAULT_REVIEW_RETENTION,
                },
                club300: ClubReviewConfig::default(),
                full: ClubReviewConfig::default(),
            },
            lesson_batch_size: DEFAULT_LESSON_BATCH_SIZE,
        }
    }
}

impl MaterialConfig {
    /// Construct a config equivalent to the legacy
    /// `(new_scope, review_scope)` shape with default
    /// `DEFAULT_REVIEW_RETENTION` for every enabled review club. Useful
    /// for tests that previously expressed eligibility through scopes and
    /// for the migration helper that synthesises the per-club shape from
    /// legacy DB rows.
    pub fn from_scopes(new_scope: TierScope, review_scope: TierScope) -> Self {
        Self::from_scopes_with_retention(new_scope, review_scope, DEFAULT_REVIEW_RETENTION)
    }

    /// Same as `from_scopes` but with explicit retention. Clamps the
    /// retention to `[MIN_REVIEW_RETENTION, MAX_REVIEW_RETENTION]`.
    pub fn from_scopes_with_retention(
        new_scope: TierScope,
        review_scope: TierScope,
        desired_retention: f32,
    ) -> Self {
        let clamped = desired_retention.clamp(MIN_REVIEW_RETENTION, MAX_REVIEW_RETENTION);
        Self {
            memorize: memorize_from_scope(new_scope),
            review: review_from_scope(review_scope, clamped),
            ..Self::default()
        }
    }

    /// Test helper: every club enabled (memorize + review) at the supplied
    /// retention. Replaces the old "default = all-active" pattern that
    /// tests relied on before the spec flipped the new-user default to
    /// Club 150-only.
    pub fn all_clubs_enabled(desired_retention: f32) -> Self {
        Self::from_scopes_with_retention(TierScope::All, TierScope::All, desired_retention)
    }

    /// Effective per-tier status, derived from the orthogonal memorize +
    /// review pair. Preserves the prior table:
    ///
    /// | memorize | review | status        |
    /// |----------|--------|---------------|
    /// |    ✓     |   ✓    | `Active`      |
    /// |    ✗     |   ✓    | `Maintenance` |
    /// |    ✓     |   ✗    | `Active`*     |
    /// |    ✗     |   ✗    | `Paused`      |
    ///
    /// *memorize-only is mapped to `Active` since it's most-similar to
    /// "user is actively studying this tier" even though they've turned
    /// review off for it.
    pub fn effective_status(&self, tier: ClubTier) -> ClubStatus {
        let n = self.memorize.get(tier).enabled;
        let r = self.review.get(tier).enabled;
        match (n, r) {
            (false, false) => ClubStatus::Paused,
            (false, true) => ClubStatus::Maintenance,
            (true, _) => ClubStatus::Active,
        }
    }

    /// True iff this verse's most-specific tier is paused — neither
    /// memorize nor review covers it. `parse_tiers` guarantees every
    /// verse has at least one tier (Full when no narrower tag), so the
    /// empty branch is defensive only.
    pub fn verse_is_paused(&self, verse_clubs: &[ClubTier]) -> bool {
        match verse_clubs.first() {
            Some(t) => self.effective_status(*t) == ClubStatus::Paused,
            None => false,
        }
    }

    /// Whether memorize introduces new verses for this club.
    pub fn memorize_enabled_for(&self, tier: ClubTier) -> bool {
        self.memorize.get(tier).enabled
    }

    /// Per-club catch-up behaviour.
    pub fn catch_up_for(&self, tier: ClubTier) -> CatchUp {
        self.memorize.get(tier).catch_up
    }

    /// Whether /review surfaces verses for this club.
    pub fn review_enabled_for(&self, tier: ClubTier) -> bool {
        self.review.get(tier).enabled
    }

    /// Per-club target retention, clamped to the valid range on read so
    /// out-of-range stored values never reach FSRS math.
    pub fn target_r_for(&self, tier: ClubTier) -> f32 {
        self.review
            .get(tier)
            .desired_retention
            .clamp(MIN_REVIEW_RETENTION, MAX_REVIEW_RETENTION)
    }

    /// Gate from the previous (higher-priority) enabled club to `tier`,
    /// where `tier` is treated as the candidate "next" club. `None` for
    /// `Club150` (it has no higher club above it).
    pub fn gate_to(&self, tier: ClubTier) -> Option<MoveToNextGate> {
        match tier {
            ClubTier::Club150 => None,
            ClubTier::Club300 => Some(self.move_to_next.p150_to_300),
            ClubTier::Full => Some(self.move_to_next.p300_to_full),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_is_club150_only_at_default_retention() {
        let c = MaterialConfig::default();
        // Card-kind toggles unchanged from pre-Phase-1 defaults.
        assert!(!c.heading_card);
        assert!(c.heading_passage_card);
        assert!(c.ftv);
        assert_eq!(c.club_card_scope, TierScope::Off);
        assert_eq!(c.chapter_list_scope, ChapterListScope::Up150);
        // Per-spec new-user shape: Club 150 enabled (memorize + review),
        // others off.
        assert!(c.memorize_enabled_for(ClubTier::Club150));
        assert!(!c.memorize_enabled_for(ClubTier::Club300));
        assert!(!c.memorize_enabled_for(ClubTier::Full));
        assert!(c.review_enabled_for(ClubTier::Club150));
        assert!(!c.review_enabled_for(ClubTier::Club300));
        assert!(!c.review_enabled_for(ClubTier::Full));
        // Default retention 0.8, batch 1.
        assert_eq!(c.target_r_for(ClubTier::Club150), DEFAULT_REVIEW_RETENTION);
        assert_eq!(c.lesson_batch_size, DEFAULT_LESSON_BATCH_SIZE);
        // Gates default to CaughtUp.
        assert_eq!(c.gate_to(ClubTier::Club150), None);
        assert_eq!(c.gate_to(ClubTier::Club300), Some(MoveToNextGate::CaughtUp));
        assert_eq!(c.gate_to(ClubTier::Full), Some(MoveToNextGate::CaughtUp));
        // Effective status reflects the new shape: 150 Active, others Paused.
        assert_eq!(c.effective_status(ClubTier::Club150), ClubStatus::Active);
        assert_eq!(c.effective_status(ClubTier::Club300), ClubStatus::Paused);
        assert_eq!(c.effective_status(ClubTier::Full), ClubStatus::Paused);
    }

    #[test]
    fn legacy_headings_alias_still_parses() {
        // Pre-Phase-1 JSON with the older `headings` key (in turn pre-
        // VerseInHeading split) reads as `heading_card: true`.
        let c: MaterialConfig = serde_json::from_str(r#"{"headings":true,"ftv":true}"#).unwrap();
        assert!(c.heading_card);
        assert!(c.heading_passage_card);
        assert!(c.ftv);
    }

    #[test]
    fn legacy_scopes_migrate_to_per_club() {
        // Legacy flat shape with `new_scope`/`review_scope`/
        // `desired_retention` — no per-club fields — materialises into
        // the per-club shape per the spec's migration table.
        let raw = r#"{
            "headingCard": false,
            "headingPassageCard": true,
            "ftv": true,
            "newScope": "up150",
            "reviewScope": "up300",
            "clubCardScope": "off",
            "chapterListScope": "up150",
            "desiredRetention": 0.85
        }"#;
        let c: MaterialConfig = serde_json::from_str(raw).unwrap();
        // memorize.{club}.enabled mirrors `new_scope`.
        assert!(c.memorize_enabled_for(ClubTier::Club150));
        assert!(!c.memorize_enabled_for(ClubTier::Club300));
        assert!(!c.memorize_enabled_for(ClubTier::Full));
        // review.{club}.enabled mirrors `review_scope`.
        assert!(c.review_enabled_for(ClubTier::Club150));
        assert!(c.review_enabled_for(ClubTier::Club300));
        assert!(!c.review_enabled_for(ClubTier::Full));
        // Retention applies to every enabled review club, clamped.
        assert_eq!(c.target_r_for(ClubTier::Club150), 0.85);
        assert_eq!(c.target_r_for(ClubTier::Club300), 0.85);
    }

    #[test]
    fn legacy_retention_above_max_clamps_to_0_9() {
        // 0.95 was a popular value pre-Phase-1; the new range tops out at
        // 0.9 and the migrator clamps to fit.
        let raw = r#"{
            "newScope": "all",
            "reviewScope": "all",
            "desiredRetention": 0.95
        }"#;
        let c: MaterialConfig = serde_json::from_str(raw).unwrap();
        for tier in [ClubTier::Club150, ClubTier::Club300, ClubTier::Full] {
            assert_eq!(c.target_r_for(tier), MAX_REVIEW_RETENTION);
        }
    }

    #[test]
    fn from_scopes_helper_matches_legacy_deserialize() {
        let raw = r#"{
            "newScope": "up300",
            "reviewScope": "all",
            "desiredRetention": 0.8
        }"#;
        let from_json: MaterialConfig = serde_json::from_str(raw).unwrap();
        let from_helper =
            MaterialConfig::from_scopes_with_retention(TierScope::Up300, TierScope::All, 0.8);
        // Direct equality fails on f32 in general but our retention values
        // are clean; compare field-by-field for the bits that matter.
        for tier in [ClubTier::Club150, ClubTier::Club300, ClubTier::Full] {
            assert_eq!(
                from_json.memorize_enabled_for(tier),
                from_helper.memorize_enabled_for(tier),
                "memorize differs on {tier:?}"
            );
            assert_eq!(
                from_json.review_enabled_for(tier),
                from_helper.review_enabled_for(tier),
                "review differs on {tier:?}"
            );
            assert_eq!(
                from_json.target_r_for(tier),
                from_helper.target_r_for(tier),
                "retention differs on {tier:?}"
            );
        }
    }

    #[test]
    fn per_club_explicit_shape_round_trips() {
        let raw = r#"{
            "headingCard": false,
            "headingPassageCard": true,
            "ftv": true,
            "clubCardScope": "off",
            "chapterListScope": "up150",
            "memorize": {
                "club150": { "enabled": true, "catchUp": "calendarCascade" },
                "club300": { "enabled": true, "catchUp": "sequential" },
                "full": { "enabled": false, "catchUp": "sequential" }
            },
            "moveToNext": {
                "p150To300": "fullyMemorized",
                "p300ToFull": "always"
            },
            "review": {
                "club150": { "enabled": true, "desiredRetention": 0.9 },
                "club300": { "enabled": true, "desiredRetention": 0.75 },
                "full": { "enabled": false, "desiredRetention": 0.8 }
            },
            "lessonBatchSize": 3
        }"#;
        let c: MaterialConfig = serde_json::from_str(raw).unwrap();
        assert_eq!(c.catch_up_for(ClubTier::Club150), CatchUp::CalendarCascade);
        assert_eq!(c.catch_up_for(ClubTier::Club300), CatchUp::Sequential);
        assert_eq!(
            c.gate_to(ClubTier::Club300),
            Some(MoveToNextGate::FullyMemorized)
        );
        assert_eq!(c.gate_to(ClubTier::Full), Some(MoveToNextGate::Always));
        assert_eq!(c.target_r_for(ClubTier::Club300), 0.75);
        assert_eq!(c.lesson_batch_size, 3);
        // Round-trip the serialised form back through the deserializer.
        let j = serde_json::to_string(&c).unwrap();
        let back: MaterialConfig = serde_json::from_str(&j).unwrap();
        assert_eq!(c, back);
    }

    #[test]
    fn empty_object_uses_defaults() {
        // Empty JSON object → MaterialConfig::default()-equivalent shape.
        let c: MaterialConfig = serde_json::from_str("{}").unwrap();
        assert_eq!(c, MaterialConfig::default());
    }

    #[test]
    fn missing_fields_fall_back_through_legacy_or_default() {
        // Just `ftv: false` set — everything else defaults. Note the
        // legacy migration path doesn't fire (no `new_scope`/etc.), so
        // memorize/review come from `MaterialConfig::default()`.
        let c: MaterialConfig = serde_json::from_str(r#"{"ftv":false}"#).unwrap();
        assert!(!c.ftv);
        assert!(c.memorize_enabled_for(ClubTier::Club150));
        assert!(!c.memorize_enabled_for(ClubTier::Club300));
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
        // memorize=Up150, review=Up300:
        //   Club 150 → Active (both cover it)
        //   Club 300 → Maintenance (only review covers)
        //   Full     → Paused (neither covers)
        let c = MaterialConfig::from_scopes(TierScope::Up150, TierScope::Up300);
        assert_eq!(c.effective_status(ClubTier::Club150), ClubStatus::Active);
        assert_eq!(
            c.effective_status(ClubTier::Club300),
            ClubStatus::Maintenance
        );
        assert_eq!(c.effective_status(ClubTier::Full), ClubStatus::Paused);
    }

    #[test]
    fn effective_status_review_only() {
        let c = MaterialConfig::from_scopes(TierScope::Off, TierScope::All);
        for tier in [ClubTier::Club150, ClubTier::Club300, ClubTier::Full] {
            assert_eq!(c.effective_status(tier), ClubStatus::Maintenance);
        }
    }

    #[test]
    fn effective_status_all_paused_when_both_scopes_off() {
        let c = MaterialConfig::from_scopes(TierScope::Off, TierScope::Off);
        for tier in [ClubTier::Club150, ClubTier::Club300, ClubTier::Full] {
            assert_eq!(c.effective_status(tier), ClubStatus::Paused);
        }
    }

    #[test]
    fn verse_is_paused_uses_first_tier() {
        let c = MaterialConfig::from_scopes(TierScope::Up150, TierScope::Up150);
        // Full not covered → paused.
        assert!(c.verse_is_paused(&[ClubTier::Full]));
        // Club 150 covered → not paused.
        assert!(!c.verse_is_paused(&[ClubTier::Club150]));
        // Empty list → defensive false.
        assert!(!c.verse_is_paused(&[]));
    }
}
