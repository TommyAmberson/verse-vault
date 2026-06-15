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
