use serde::{Deserialize, Serialize};

use crate::element::ClubTier;

/// A per-(material, season) memorisation calendar. Carries the dated rows
/// the user works through during a season — each row introduces verses for
/// one or more clubs — plus the major checkpoints (quiz meets) that anchor
/// the gates downstream. Source of truth is bundled per material in
/// `data/schedules/<deck>-<season>.json`; the user's edits land in the
/// API's `material_schedules` table as a full-copy override.
///
/// Wire form mirrors the bundled JSON exactly: camelCase fields, ISO date
/// strings, and structured `passage` objects (rather than a parsed string
/// like "1 Cor 1:1-31"). The structured passage avoids the cross-language
/// book-abbreviation table that would otherwise be needed at read time.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Schedule {
    pub version: u32,
    pub material_id: String,
    pub season: String,
    pub title: String,
    /// Three-letter abbreviation: "Mon", "Tue", "Wed", "Thu", "Fri", "Sat",
    /// "Sun". Drives schedule-editor display only — the row dates carry
    /// the authoritative weekday.
    pub meeting_day_of_week: String,
    pub weeks: Vec<ScheduleWeek>,
    #[serde(default)]
    pub meets: Vec<Meet>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScheduleWeek {
    /// ISO `YYYY-MM-DD`.
    pub date: String,
    /// `None` on Review weeks (no new verses introduced).
    pub passage: Option<Passage>,
    /// `None` on Review weeks. When present, lists the verse numbers (within
    /// `passage`) that each club introduces this week. Verses in
    /// `verses.club300` are the Club 300-tagged *additional* verses — Club
    /// 150's set is not duplicated. The implicit Full tier covers any verse
    /// in `passage` that's listed in neither.
    pub verses: Option<ClubVerseLists>,
    #[serde(default)]
    pub is_review: bool,
}

/// Structured passage range. Each row in the SK PDF spans a single chapter,
/// so a single `(book, chapter, start_verse, end_verse)` covers the
/// observed shape. Multi-chapter spans would need a future shape change.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Passage {
    /// Full book name matching the deck's `MaterialData.books` entries
    /// (e.g. "1 Corinthians", not "1 Cor"). Avoids the abbreviation lookup.
    pub book: String,
    pub chapter: u16,
    pub start_verse: u16,
    pub end_verse: u16,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClubVerseLists {
    #[serde(default)]
    pub club150: Vec<u16>,
    #[serde(default)]
    pub club300: Vec<u16>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Meet {
    pub id: String,
    pub name: String,
    /// ISO `YYYY-MM-DD`.
    pub start_date: String,
    /// ISO `YYYY-MM-DD`. `None` for single-day meets.
    #[serde(default)]
    pub end_date: Option<String>,
    #[serde(default)]
    pub location: Option<String>,
}

/// Seconds per day; used everywhere a Unix timestamp converts to a calendar
/// day for week-row comparison.
const SECS_PER_DAY: i64 = 86_400;

impl Schedule {
    /// Index of the most-recent week whose `date` is on or before today,
    /// per `now_secs`. `None` when the season hasn't started yet (today is
    /// before the first week's date) or when `weeks` is empty.
    ///
    /// Out-of-season-past (today is after the last week) returns the index
    /// of the final week — the season's last row is the canonical "current"
    /// position once memorisation has reached the end of the calendar.
    pub fn current_week_index(&self, now_secs: i64) -> Option<usize> {
        let today = days_since_epoch_from_secs(now_secs);
        let mut hit: Option<usize> = None;
        for (i, w) in self.weeks.iter().enumerate() {
            let d = parse_iso_date(&w.date)?;
            if d <= today {
                hit = Some(i);
            } else {
                break;
            }
        }
        hit
    }

    /// Most-recent meet whose `start_date` is on or before today.
    ///
    /// Used by the `AfterMajorCheckpoint` cross-club gate: the lower club
    /// becomes eligible once the higher club's verses through this meet's
    /// position are all memorised. `None` before the season's first meet —
    /// which makes `AfterMajorCheckpoint` a never-open gate at season start
    /// (the spec calls this out as the intentional behaviour).
    pub fn most_recent_past_meet(&self, now_secs: i64) -> Option<&Meet> {
        let today = days_since_epoch_from_secs(now_secs);
        self.meets
            .iter()
            .filter_map(|m| parse_iso_date(&m.start_date).map(|d| (d, m)))
            .filter(|(d, _)| *d <= today)
            .max_by_key(|(d, _)| *d)
            .map(|(_, m)| m)
    }
}

impl ClubVerseLists {
    /// The list of verse numbers this club introduces this week. `Full` is
    /// derived from the passage minus 150 ∪ 300; `for_tier` returns the
    /// borrowed slice for the two storage-backed tiers and `None` for
    /// `Full` (callers must compute Full's contribution from the row's
    /// `passage` range).
    pub fn for_tier(&self, tier: ClubTier) -> Option<&[u16]> {
        match tier {
            ClubTier::Club150 => Some(&self.club150),
            ClubTier::Club300 => Some(&self.club300),
            ClubTier::Full => None,
        }
    }
}

/// Verse reference triple `(book, chapter, verse)` used to bridge the
/// schedule's per-row verse numbers with the engine's `(verse_id, book,
/// chapter, verse)` render data. Owned strings — schedule rows are few,
/// the cost is negligible, and lifetime-free returns simplify call sites.
pub type VerseRef = (String, u16, u16);

impl Schedule {
    /// Resolve the verse numbers a given `tier` introduces in `week_idx`
    /// into `(book, chapter, verse)` refs. Returns an empty vector for
    /// Review weeks, for out-of-range indices, and for weeks with no
    /// `passage`. `Full`-tier refs are derived as `passage`'s verse range
    /// minus the explicitly-listed `club150 ∪ club300` numbers.
    ///
    /// Does **not** consult the engine — pure schedule-level resolution.
    /// Callers map the refs to `verse_id`s via a lookup built from the
    /// engine's `verse_render_data`.
    pub fn week_verse_refs(&self, week_idx: usize, tier: ClubTier) -> Vec<VerseRef> {
        let Some(week) = self.weeks.get(week_idx) else {
            return Vec::new();
        };
        let Some(passage) = &week.passage else {
            return Vec::new();
        };
        let numbers = self.verse_numbers_for_tier(week, tier);
        numbers
            .into_iter()
            .map(|n| (passage.book.clone(), passage.chapter, n))
            .collect()
    }

    /// All verse refs cumulatively introduced for `tier` across weeks
    /// `0..=through_week_idx`. `through_week_idx` is clamped to
    /// `weeks.len() - 1`. Refs preserve schedule (earliest-week-first)
    /// order.
    pub fn cumulative_verse_refs_through_week(
        &self,
        through_week_idx: usize,
        tier: ClubTier,
    ) -> Vec<VerseRef> {
        if self.weeks.is_empty() {
            return Vec::new();
        }
        let cap = through_week_idx.min(self.weeks.len() - 1);
        let mut out: Vec<VerseRef> = Vec::new();
        for idx in 0..=cap {
            out.extend(self.week_verse_refs(idx, tier));
        }
        out
    }

    /// Total count of unique verses scheduled for `tier` from week 0
    /// through the schedule's current-week index. `0` when the season
    /// hasn't started yet. Used by the memorize-tab badge math and the
    /// `AfterMinorCheckpoint` gate.
    pub fn cumulative_count_through_current_week(&self, tier: ClubTier, now_secs: i64) -> usize {
        let Some(idx) = self.current_week_index(now_secs) else {
            return 0;
        };
        self.cumulative_verse_refs_through_week(idx, tier).len()
    }

    /// Cumulative count for `tier` through the schedule's most-recent
    /// past meet's `start_date`. `0` when no meet has passed yet — which
    /// makes the `AfterMajorCheckpoint` gate impossible to satisfy at
    /// that point (intentional per the spec).
    pub fn cumulative_count_through_last_meet(&self, tier: ClubTier, now_secs: i64) -> usize {
        let Some(meet) = self.most_recent_past_meet(now_secs) else {
            return 0;
        };
        let Some(meet_day) = parse_iso_date(&meet.start_date) else {
            return 0;
        };
        let mut count = 0;
        for (i, w) in self.weeks.iter().enumerate() {
            let Some(d) = parse_iso_date(&w.date) else {
                continue;
            };
            if d > meet_day {
                break;
            }
            count += self.week_verse_refs(i, tier).len();
        }
        count
    }

    /// Cumulative count for `tier` through the most-recent week strictly
    /// **before** the schedule's current week. `0` at season start (no
    /// previous week exists). Used by the `CaughtUp` gate, which opens
    /// when the user's position ≥ this value.
    pub fn cumulative_count_through_previous_week(&self, tier: ClubTier, now_secs: i64) -> usize {
        let Some(idx) = self.current_week_index(now_secs) else {
            return 0;
        };
        if idx == 0 {
            return 0;
        }
        self.cumulative_verse_refs_through_week(idx - 1, tier).len()
    }

    /// Internal: verse numbers for `tier` in this single row. `Full` is
    /// derived from `passage` minus `club150 ∪ club300`.
    fn verse_numbers_for_tier(&self, week: &ScheduleWeek, tier: ClubTier) -> Vec<u16> {
        let Some(passage) = &week.passage else {
            return Vec::new();
        };
        let Some(verses) = &week.verses else {
            return Vec::new();
        };
        match tier {
            ClubTier::Club150 => verses.club150.clone(),
            ClubTier::Club300 => verses.club300.clone(),
            ClubTier::Full => {
                let mut excluded: std::collections::HashSet<u16> = std::collections::HashSet::new();
                excluded.extend(verses.club150.iter().copied());
                excluded.extend(verses.club300.iter().copied());
                (passage.start_verse..=passage.end_verse)
                    .filter(|n| !excluded.contains(n))
                    .collect()
            }
        }
    }
}

/// Parse a `YYYY-MM-DD` date string into days since the Unix epoch
/// (1970-01-01). Implements Howard Hinnant's `days_from_civil` —
/// well-known proleptic-Gregorian conversion with no dependency footprint.
/// Returns `None` on malformed strings; does not validate that the day-of-
/// month is in range (Feb 30 parses to a day-since-epoch and round-trips,
/// matching the algorithm's convention).
pub fn parse_iso_date(s: &str) -> Option<i64> {
    let bytes = s.as_bytes();
    if bytes.len() != 10 || bytes[4] != b'-' || bytes[7] != b'-' {
        return None;
    }
    let y: i32 = std::str::from_utf8(&bytes[0..4]).ok()?.parse().ok()?;
    let m: u32 = std::str::from_utf8(&bytes[5..7]).ok()?.parse().ok()?;
    let d: u32 = std::str::from_utf8(&bytes[8..10]).ok()?.parse().ok()?;
    if !(1..=12).contains(&m) || !(1..=31).contains(&d) {
        return None;
    }
    Some(days_from_civil(y, m, d))
}

/// Howard Hinnant's `days_from_civil(y, m, d)` — `(y, m, d)` in the
/// proleptic Gregorian calendar to days since the Unix epoch. Exact for
/// all dates in `[-5_879_610-06-23, 5_879_611-07-11]`.
fn days_from_civil(y: i32, m: u32, d: u32) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = (if y >= 0 { y } else { y - 399 }) / 400;
    let yoe = (y - era * 400) as u32;
    let m_shifted = if m > 2 { m - 3 } else { m + 9 };
    let doy = (153 * m_shifted + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era as i64 * 146_097 + doe as i64 - 719_468
}

/// Truncate a Unix-second timestamp to the day, in UTC. Matches the
/// resolution we compare schedule dates at — sub-day drift doesn't
/// advance the `current_week_index`.
fn days_since_epoch_from_secs(now_secs: i64) -> i64 {
    now_secs.div_euclid(SECS_PER_DAY)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn schedule_fixture() -> Schedule {
        Schedule {
            version: 1,
            material_id: "3-corinthians".into(),
            season: "2025-26".into(),
            title: "SK Quiz 2025-26 — 1 & 2 Cor".into(),
            meeting_day_of_week: "Mon".into(),
            weeks: vec![
                ScheduleWeek {
                    date: "2025-09-08".into(),
                    passage: Some(Passage {
                        book: "1 Corinthians".into(),
                        chapter: 1,
                        start_verse: 1,
                        end_verse: 31,
                    }),
                    verses: Some(ClubVerseLists {
                        club150: vec![5, 10, 17, 18, 21, 25, 27],
                        club300: vec![1, 2, 4, 8, 9, 19, 23],
                    }),
                    is_review: false,
                },
                ScheduleWeek {
                    date: "2025-09-15".into(),
                    passage: Some(Passage {
                        book: "1 Corinthians".into(),
                        chapter: 2,
                        start_verse: 1,
                        end_verse: 16,
                    }),
                    verses: Some(ClubVerseLists {
                        club150: vec![4, 9, 12, 14, 16],
                        club300: vec![5, 7, 10, 11, 13],
                    }),
                    is_review: false,
                },
                ScheduleWeek {
                    date: "2025-11-17".into(),
                    passage: None,
                    verses: None,
                    is_review: true,
                },
            ],
            meets: vec![
                Meet {
                    id: "first-weekend".into(),
                    name: "First Weekend Quiz Meet".into(),
                    start_date: "2025-11-21".into(),
                    end_date: Some("2025-11-23".into()),
                    location: Some("Heritage Alliance Church".into()),
                },
                Meet {
                    id: "final-weekend".into(),
                    name: "Final Weekend Quiz Meet".into(),
                    start_date: "2026-05-01".into(),
                    end_date: Some("2026-05-03".into()),
                    location: Some("Briercrest College, Caronport, SK".into()),
                },
            ],
        }
    }

    /// Unix timestamp at UTC midnight for the given ISO date. Convenience
    /// for tests so each `now_secs` reads as the date it represents.
    fn ts(date: &str) -> i64 {
        parse_iso_date(date).expect("test date") * SECS_PER_DAY
    }

    #[test]
    fn parses_iso_dates_against_known_values() {
        assert_eq!(parse_iso_date("1970-01-01"), Some(0));
        assert_eq!(parse_iso_date("1970-01-02"), Some(1));
        assert_eq!(parse_iso_date("2025-09-08"), Some(20_339));
        assert_eq!(parse_iso_date("2026-06-14"), Some(20_618));
        assert_eq!(parse_iso_date("1969-12-31"), Some(-1));
    }

    #[test]
    fn rejects_malformed_dates() {
        assert_eq!(parse_iso_date(""), None);
        assert_eq!(parse_iso_date("2025/09/08"), None);
        assert_eq!(parse_iso_date("25-09-08"), None);
        assert_eq!(parse_iso_date("2025-13-08"), None);
        assert_eq!(parse_iso_date("2025-09-32"), None);
    }

    #[test]
    fn current_week_index_before_season_is_none() {
        let s = schedule_fixture();
        assert_eq!(s.current_week_index(ts("2025-09-07")), None);
        assert_eq!(s.current_week_index(ts("2024-01-01")), None);
    }

    #[test]
    fn current_week_index_on_first_day_returns_zero() {
        let s = schedule_fixture();
        assert_eq!(s.current_week_index(ts("2025-09-08")), Some(0));
    }

    #[test]
    fn current_week_index_advances_with_each_row() {
        let s = schedule_fixture();
        // Sunday before week 2 still maps to week 0.
        assert_eq!(s.current_week_index(ts("2025-09-14")), Some(0));
        assert_eq!(s.current_week_index(ts("2025-09-15")), Some(1));
        // After all rows, the final row's index stays current.
        assert_eq!(s.current_week_index(ts("2030-01-01")), Some(2));
    }

    #[test]
    fn current_week_index_handles_review_week() {
        // Review weeks have no `passage`/`verses` but still count for
        // positioning — the current-week index advances normally.
        let s = schedule_fixture();
        assert_eq!(s.current_week_index(ts("2025-11-17")), Some(2));
    }

    #[test]
    fn empty_weeks_returns_none() {
        let mut s = schedule_fixture();
        s.weeks.clear();
        assert_eq!(s.current_week_index(ts("2025-09-08")), None);
    }

    #[test]
    fn most_recent_past_meet_handles_season_edges() {
        let s = schedule_fixture();
        // Before any meet.
        assert!(s.most_recent_past_meet(ts("2025-09-08")).is_none());
        // Day before the first meet's start.
        assert!(s.most_recent_past_meet(ts("2025-11-20")).is_none());
        // Day of the first meet's start.
        assert_eq!(
            s.most_recent_past_meet(ts("2025-11-21"))
                .map(|m| m.id.as_str()),
            Some("first-weekend")
        );
        // Between the two meets — still anchors on the first.
        assert_eq!(
            s.most_recent_past_meet(ts("2026-02-15"))
                .map(|m| m.id.as_str()),
            Some("first-weekend")
        );
        // After the final meet — anchors on the final.
        assert_eq!(
            s.most_recent_past_meet(ts("2026-12-25"))
                .map(|m| m.id.as_str()),
            Some("final-weekend")
        );
    }

    #[test]
    fn for_tier_full_returns_none() {
        // Full's contribution isn't stored — callers derive it from the
        // row's `passage` range minus the 150 ∪ 300 sets.
        let lists = ClubVerseLists {
            club150: vec![1, 2],
            club300: vec![3, 4],
        };
        assert_eq!(lists.for_tier(ClubTier::Club150), Some(&[1u16, 2][..]));
        assert_eq!(lists.for_tier(ClubTier::Club300), Some(&[3u16, 4][..]));
        assert!(lists.for_tier(ClubTier::Full).is_none());
    }

    #[test]
    fn round_trips_through_json() {
        let s = schedule_fixture();
        let j = serde_json::to_string(&s).expect("serialise");
        let back: Schedule = serde_json::from_str(&j).expect("deserialise");
        assert_eq!(back.weeks.len(), s.weeks.len());
        assert_eq!(back.meets.len(), s.meets.len());
        assert_eq!(
            back.weeks[0].verses.as_ref().unwrap().club150,
            vec![5, 10, 17, 18, 21, 25, 27]
        );
        assert!(back.weeks[2].is_review);
        assert!(back.weeks[2].passage.is_none());
    }

    #[test]
    fn week_verse_refs_resolves_per_tier() {
        let s = schedule_fixture();
        let club150 = s.week_verse_refs(0, ClubTier::Club150);
        assert_eq!(club150.len(), 7);
        assert_eq!(club150[0], ("1 Corinthians".to_string(), 1, 5));
        let club300 = s.week_verse_refs(0, ClubTier::Club300);
        assert_eq!(club300.len(), 7);
        assert_eq!(club300[0], ("1 Corinthians".to_string(), 1, 1));
    }

    #[test]
    fn week_verse_refs_full_tier_derives_from_passage_minus_others() {
        let s = schedule_fixture();
        let full = s.week_verse_refs(0, ClubTier::Full);
        // Passage 1 Cor 1:1-31 = 31 verses. Club150 has 7, Club300 has 7
        // (all distinct), so Full has 31 - 14 = 17.
        assert_eq!(full.len(), 17);
        // Verse 3 is in neither 150 nor 300, so it's Full.
        assert!(full.contains(&("1 Corinthians".to_string(), 1, 3)));
        // Verse 5 is in 150; must NOT be in Full.
        assert!(!full.contains(&("1 Corinthians".to_string(), 1, 5)));
        // Verse 31 is in neither; must be in Full.
        assert!(full.contains(&("1 Corinthians".to_string(), 1, 31)));
    }

    #[test]
    fn week_verse_refs_returns_empty_for_review_or_oob() {
        let s = schedule_fixture();
        // Review week (idx 2) has no passage/verses.
        assert!(s.week_verse_refs(2, ClubTier::Club150).is_empty());
        // Out-of-range index.
        assert!(s.week_verse_refs(99, ClubTier::Club150).is_empty());
    }

    #[test]
    fn cumulative_through_week_aggregates_across_weeks() {
        let s = schedule_fixture();
        let c0 = s.cumulative_verse_refs_through_week(0, ClubTier::Club150);
        assert_eq!(c0.len(), 7);
        let c1 = s.cumulative_verse_refs_through_week(1, ClubTier::Club150);
        // Week 1 adds 5 more Club150 verses.
        assert_eq!(c1.len(), 12);
    }

    #[test]
    fn cumulative_count_helpers_handle_edges() {
        let s = schedule_fixture();
        // Pre-season → 0.
        assert_eq!(
            s.cumulative_count_through_current_week(ClubTier::Club150, ts("2025-09-01")),
            0
        );
        // On week 0's day → just that week.
        assert_eq!(
            s.cumulative_count_through_current_week(ClubTier::Club150, ts("2025-09-08")),
            7
        );
        // Previous week from week 0 → 0 (no prior week).
        assert_eq!(
            s.cumulative_count_through_previous_week(ClubTier::Club150, ts("2025-09-08")),
            0
        );
        // Through the first meet (Nov 21): all Club150 from weeks before
        // the meet — covers weeks 0 and 1 (and review week 2 contributes 0).
        assert_eq!(
            s.cumulative_count_through_last_meet(ClubTier::Club150, ts("2025-12-01")),
            12
        );
        // Before any meet → 0.
        assert_eq!(
            s.cumulative_count_through_last_meet(ClubTier::Club150, ts("2025-09-08")),
            0
        );
    }

    #[test]
    fn parses_external_json_shape() {
        // Sanity check on the bundled-JSON shape (camelCase wire form, the
        // `endDate`/`location` `Option` fields work with explicit `null`,
        // and the `isReview` default to false on present weeks).
        let raw = r#"{
            "version": 1,
            "materialId": "3-corinthians",
            "season": "2025-26",
            "title": "Test",
            "meetingDayOfWeek": "Mon",
            "weeks": [
                {
                    "date": "2025-09-08",
                    "passage": {
                        "book": "1 Corinthians",
                        "chapter": 1,
                        "startVerse": 1,
                        "endVerse": 31
                    },
                    "verses": { "club150": [5, 10], "club300": [1] }
                }
            ],
            "meets": [
                {
                    "id": "m1",
                    "name": "Meet",
                    "startDate": "2025-11-21",
                    "endDate": null,
                    "location": null
                }
            ]
        }"#;
        let s: Schedule = serde_json::from_str(raw).expect("parse");
        assert_eq!(s.weeks.len(), 1);
        assert!(!s.weeks[0].is_review);
        assert_eq!(s.weeks[0].passage.as_ref().unwrap().end_verse, 31);
        assert_eq!(s.meets[0].end_date, None);
    }
}
