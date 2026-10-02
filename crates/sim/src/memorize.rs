//! Season memorize mode (`--memorize`).
//!
//! The review-calibration mode graduates every card up front, so it never
//! sees the memorize queue. This mode walks every bundled season day by day
//! and lets learners press Memorize at their own pace, under every gate,
//! catch-up and batch-size setting. It checks the "memorize by schedule"
//! spec invariants on every verse served, so the same harness measures the
//! queue before and after a change to it (specs/003-memorize-by-schedule,
//! research D7).
//!
//! The sim holds no definition of "owed": a second copy of the rule in a
//! consumer is what constitution principle II forbids. It reads ownership
//! off `memorize_debt` instead. Memorizing an owed verse drops the count by
//! exactly one, and memorizing any other verse leaves it alone.
//!
//! `--out <path>` writes every season, setting and learner's outcome to a
//! tab-separated file, and `--baseline <path>` compares this run against
//! one, so a regression in a single combination cannot hide in a total.
//!
//! No reviews are simulated. The queue, the count and the gates read which
//! verses are memorized and the schedule, never memory state, so a review
//! loop would add runtime and noise without changing any result here.

use std::collections::{HashMap, HashSet};
use std::fmt::Write as _;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use verse_vault_core::builder::build_with_config;
use verse_vault_core::content::MaterialData;
use verse_vault_core::element::ClubTier;
use verse_vault_core::engine::ReviewEngine;
use verse_vault_core::material_config::{
    CatchUp, ClubMemorizeConfig, ClubMemorizeMap, MaterialConfig, MoveToNextConfig, MoveToNextGate,
};
use verse_vault_core::schedule::{anchor_card_for_verse, memorize_debt, next_memorize_batch};
use verse_vault_core::schedule_data::{Schedule, parse_iso_date};

const SECONDS_PER_DAY: i64 = 86_400;
const DESIRED_RETENTION: f32 = 0.9;
/// Days walked past the last week's date. Nobody memorizes in them; they
/// only extend the wait counted for verses still un-memorized.
const TAIL_DAYS: i64 = 14;
/// Memorize presses happen at noon UTC.
const MEMORIZE_AT_SECS: i64 = 12 * 3600;
/// Mid-season week indices the behind profile skips memorizing in.
const SKIPPED_WEEKS: [usize; 2] = [12, 13];

struct Season {
    name: &'static str,
    deck: &'static str,
    schedule: &'static str,
}

const SEASONS: [Season; 4] = [
    Season {
        name: "GEPC 2023-24",
        deck: "1-gepc.json",
        schedule: "schedules/1-gepc-2023-24.json",
    },
    Season {
        name: "NT Survey 2024-25",
        deck: "2-nt-survey.json",
        schedule: "schedules/2-nt-survey-2024-25.json",
    },
    Season {
        name: "Corinthians 2025-26",
        deck: "3-corinthians.json",
        schedule: "schedules/3-corinthians-2025-26.json",
    },
    Season {
        name: "John 2026-27",
        deck: "4-john.json",
        schedule: "schedules/4-john-2026-27.json",
    },
];

/// The production John gates first, then each gate condition on both pairs.
const GATE_SETTINGS: [(MoveToNextGate, MoveToNextGate); 6] = [
    (MoveToNextGate::Always, MoveToNextGate::CaughtUp),
    (MoveToNextGate::Always, MoveToNextGate::Always),
    (MoveToNextGate::CaughtUp, MoveToNextGate::CaughtUp),
    (
        MoveToNextGate::FullyMemorized,
        MoveToNextGate::FullyMemorized,
    ),
    (
        MoveToNextGate::AfterMajorCheckpoint,
        MoveToNextGate::AfterMajorCheckpoint,
    ),
    (
        MoveToNextGate::AfterMinorCheckpoint,
        MoveToNextGate::AfterMinorCheckpoint,
    ),
];

const CATCH_UPS: [CatchUp; 2] = [CatchUp::Sequential, CatchUp::CalendarCascade];

const BATCH_SIZES: [u8; 2] = [1, 5];

struct Profile {
    name: &'static str,
    /// Multiple of the on-plan pace.
    pace: usize,
    skipped_weeks: &'static [usize],
}

const PROFILES: [Profile; 3] = [
    Profile {
        name: "On plan",
        pace: 1,
        skipped_weeks: &[],
    },
    Profile {
        name: "Behind",
        pace: 1,
        skipped_weeks: &SKIPPED_WEEKS,
    },
    Profile {
        name: "Ahead",
        pace: 2,
        skipped_weeks: &[],
    },
];

/// One combination of the settings the queue reads.
#[derive(Clone, Copy)]
struct Setting {
    gates: (MoveToNextGate, MoveToNextGate),
    catch_up: CatchUp,
    batch_size: u8,
}

impl Setting {
    fn all() -> Vec<Setting> {
        let mut out = Vec::new();
        for gates in GATE_SETTINGS {
            for catch_up in CATCH_UPS {
                for batch_size in BATCH_SIZES {
                    out.push(Setting {
                        gates,
                        catch_up,
                        batch_size,
                    });
                }
            }
        }
        out
    }

    fn key(&self) -> String {
        format!(
            "{:?}/{:?}\t{:?}\t{}",
            self.gates.0, self.gates.1, self.catch_up, self.batch_size
        )
    }

    fn label(&self) -> String {
        format!(
            "{:?} / {:?} | {:?} | {}",
            self.gates.0, self.gates.1, self.catch_up, self.batch_size
        )
    }

    /// Every club memorizing, with this setting's gates and catch-up.
    fn config(&self) -> MaterialConfig {
        let club = ClubMemorizeConfig {
            enabled: true,
            catch_up: self.catch_up,
        };
        MaterialConfig {
            memorize: ClubMemorizeMap {
                club150: club,
                club300: club,
                full: club,
            },
            move_to_next: MoveToNextConfig {
                p150_to_300: self.gates.0,
                p300_to_full: self.gates.1,
            },
            ..MaterialConfig::all_clubs_enabled(DESIRED_RETENTION)
        }
    }
}

#[derive(Debug, Default, Clone, Copy)]
struct Failures {
    /// SC-001 / SC-003: an empty batch while the count is above zero, or a
    /// served verse that moves a count of zero.
    count_vs_batch: usize,
    /// SC-005: while the count is above zero, a served verse that does not
    /// drop it by exactly one.
    non_owed_while_owed: usize,
    /// SC-006: a batch larger than the batch size.
    oversized_batch: usize,
    /// SC-002: with nothing owed, a verse from a week other than the nearest
    /// one that still has un-memorized verses.
    not_nearest_week: usize,
}

impl Failures {
    fn total(&self) -> usize {
        self.count_vs_batch
            + self.non_owed_while_owed
            + self.oversized_batch
            + self.not_nearest_week
    }

    fn add(&mut self, other: &Failures) {
        self.count_vs_batch += other.count_vs_batch;
        self.non_owed_while_owed += other.non_owed_while_owed;
        self.oversized_batch += other.oversized_batch;
        self.not_nearest_week += other.not_nearest_week;
    }
}

/// Time spent in the two calls the feature changes, for the plan's
/// no-regression goal.
#[derive(Debug, Default, Clone, Copy)]
struct Timing {
    debt: Duration,
    debt_calls: u32,
    batch: Duration,
    batch_calls: u32,
}

impl Timing {
    fn debt(&mut self, engine: &ReviewEngine, schedule: &Schedule, now: i64) -> u32 {
        let start = Instant::now();
        let verses = memorize_debt(engine, Some(schedule), now).verses;
        self.debt += start.elapsed();
        self.debt_calls += 1;
        verses
    }

    fn batch(
        &mut self,
        engine: &ReviewEngine,
        schedule: &Schedule,
        now: i64,
        batch_size: u8,
    ) -> Vec<u32> {
        let start = Instant::now();
        let batch = next_memorize_batch(engine, Some(schedule), now, batch_size);
        self.batch += start.elapsed();
        self.batch_calls += 1;
        batch
            .into_iter()
            .filter_map(|id| engine.card(id).map(|c| c.verse_id))
            .collect()
    }

    fn add(&mut self, other: &Timing) {
        self.debt += other.debt;
        self.debt_calls += other.debt_calls;
        self.batch += other.batch;
        self.batch_calls += other.batch_calls;
    }
}

/// One season, setting and learner.
#[derive(Default, Clone, Copy)]
struct Outcome {
    memorized: usize,
    /// Days from becoming owed to memorized, summed over scheduled verses.
    wait_days: i64,
    scheduled: usize,
    failures: Failures,
    timing: Timing,
}

impl Outcome {
    fn add(&mut self, other: &Outcome) {
        self.memorized += other.memorized;
        self.wait_days += other.wait_days;
        self.scheduled += other.scheduled;
        self.failures.add(&other.failures);
        self.timing.add(&other.timing);
    }
}

/// A file under the repo's `data/` directory, where the decks and their
/// bundled schedules live.
pub(crate) fn data_path(rel: &str) -> PathBuf {
    let mut p = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    p.push("../../data");
    p.push(rel);
    p
}

/// The first week each verse appears in the schedule, under any club, read
/// from the schedule as data. It sets the on-plan quotas, the day a verse
/// starts waiting and the nearest week SC-002 expects; it plays no part in
/// deciding what is owed.
fn first_assigning_week(engine: &ReviewEngine, schedule: &Schedule) -> HashMap<u32, usize> {
    let mut by_ref: HashMap<(String, u16, u16), usize> = HashMap::new();
    for week_idx in 0..schedule.weeks.len() {
        for club in ClubTier::ALL {
            for vref in schedule.week_verse_refs(week_idx, club) {
                by_ref.entry(vref).or_insert(week_idx);
            }
        }
    }
    engine
        .verse_render_data
        .iter()
        .filter_map(|(&vid, r)| {
            let week = by_ref.get(&(r.book.clone(), r.chapter, r.verse))?;
            Some((vid, *week))
        })
        .collect()
}

/// Each week's on-plan quota: the verses that week is the first to assign.
/// A verse a schedule lists twice counts once, so the quotas sum to the
/// scheduled verses.
fn week_quotas(schedule: &Schedule, week_of: &HashMap<u32, usize>) -> Vec<usize> {
    let mut quotas = vec![0; schedule.weeks.len()];
    for &week in week_of.values() {
        quotas[week] += 1;
    }
    quotas
}

/// The on-plan learner's verses for `day`: the week's quota spread over the
/// seven days from its date, so the week sums to exactly its quota and the
/// learner finishes it on the last day. Days past the seventh, in a gap
/// longer than a week, get nothing.
fn daily_budget(week_start: i64, quota: usize, day: i64) -> usize {
    let offset = day - week_start;
    if !(0..7).contains(&offset) {
        return 0;
    }
    let through = |d: i64| quota * d as usize / 7;
    through(offset + 1) - through(offset)
}

pub fn run(out: Option<&Path>, baseline: Option<&Path>) {
    let settings = Setting::all();
    let results: Vec<Vec<Vec<Outcome>>> = std::thread::scope(|scope| {
        let handles: Vec<_> = SEASONS
            .iter()
            .map(|season| {
                let settings = &settings;
                scope.spawn(move || simulate_season(season, settings))
            })
            .collect();
        handles
            .into_iter()
            .map(|h| h.join().expect("season thread panicked"))
            .collect()
    });

    println!(
        "verse-vault-sim --memorize: {} seasons × {} settings × {} learners",
        SEASONS.len(),
        settings.len(),
        PROFILES.len()
    );
    println!();
    println!(
        "Per season and learner, over every setting. Verses memorized is the mean per setting."
    );
    println!();
    println!("| Season | Learner | Verses memorized | Mean wait (days) | Invariant failures |");
    println!("| ------ | ------- | ---------------- | ---------------- | ------------------ |");
    let mut by_setting = vec![Outcome::default(); settings.len()];
    let mut overall = Outcome::default();
    for (season, per_setting) in SEASONS.iter().zip(&results) {
        let mut per_profile = [Outcome::default(); PROFILES.len()];
        for (setting_idx, outcomes) in per_setting.iter().enumerate() {
            for (profile_idx, o) in outcomes.iter().enumerate() {
                per_profile[profile_idx].add(o);
                by_setting[setting_idx].add(o);
                overall.add(o);
            }
        }
        for (profile, o) in PROFILES.iter().zip(&per_profile) {
            println!(
                "| {} | {} | {:.1} | {:.2} | {} |",
                season.name,
                profile.name,
                o.memorized as f64 / settings.len() as f64,
                o.wait_days as f64 / o.scheduled.max(1) as f64,
                o.failures.total(),
            );
        }
    }

    println!();
    println!(
        "Per setting, over every season and learner. Verses memorized is the mean per season and learner."
    );
    println!();
    println!(
        "| Gates (150→300 / 300→Full) | Catch-up | Batch | Verses memorized | Mean wait (days) | Count vs batch | Not owed | Oversized | Not nearest week |"
    );
    println!(
        "| -------------------------- | -------- | ----- | ---------------- | ---------------- | -------------- | -------- | --------- | ---------------- |"
    );
    let cells_per_setting = (SEASONS.len() * PROFILES.len()) as f64;
    for (setting, o) in settings.iter().zip(&by_setting) {
        let f = &o.failures;
        println!(
            "| {} | {:.1} | {:.2} | {} | {} | {} | {} |",
            setting.label(),
            o.memorized as f64 / cells_per_setting,
            o.wait_days as f64 / o.scheduled.max(1) as f64,
            f.count_vs_batch,
            f.non_owed_while_owed,
            f.oversized_batch,
            f.not_nearest_week,
        );
    }

    let cells = outcome_table(&settings, &results);
    if let Some(path) = out {
        std::fs::write(path, &cells).expect("--out path should be writable");
        println!();
        println!("Wrote every outcome to {}", path.display());
    }
    if let Some(path) = baseline {
        let earlier = std::fs::read_to_string(path).expect("--baseline file should exist");
        compare(&earlier, &cells);
    }

    let t = &overall.timing;
    let mean_us = |total: Duration, calls: u32| total.as_secs_f64() * 1e6 / f64::from(calls.max(1));
    println!();
    println!("| Call | Mean time |");
    println!("| ---- | --------- |");
    println!(
        "| `memorize_debt` | {:.0} µs over {} calls |",
        mean_us(t.debt, t.debt_calls),
        t.debt_calls
    );
    println!(
        "| `next_memorize_batch` | {:.0} µs over {} calls |",
        mean_us(t.batch, t.batch_calls),
        t.batch_calls
    );
}

/// Every setting and learner for one season, indexed `[setting][profile]`.
fn simulate_season(season: &Season, settings: &[Setting]) -> Vec<Vec<Outcome>> {
    let deck_json = std::fs::read_to_string(data_path(season.deck)).expect("deck should exist");
    let material: MaterialData = serde_json::from_str(&deck_json).expect("deck parses");
    let schedule_json =
        std::fs::read_to_string(data_path(season.schedule)).expect("schedule should exist");
    let schedule: Schedule = serde_json::from_str(&schedule_json).expect("schedule parses");
    settings
        .iter()
        .map(|setting| {
            PROFILES
                .iter()
                .map(|profile| simulate(&material, &schedule, setting, profile))
                .collect()
        })
        .collect()
}

fn simulate(
    material: &MaterialData,
    schedule: &Schedule,
    setting: &Setting,
    profile: &Profile,
) -> Outcome {
    let week_starts: Vec<i64> = schedule
        .weeks
        .iter()
        .map(|w| parse_iso_date(&w.date).expect("bundled week dates parse"))
        .collect();
    let first_day = week_starts[0];
    let last_day = *week_starts.last().expect("weeks") + TAIL_DAYS;

    let mut engine = ReviewEngine::new(
        build_with_config(material, &setting.config(), first_day * SECONDS_PER_DAY),
        DESIRED_RETENTION,
    );
    let week_of = first_assigning_week(&engine, schedule);
    let quotas = week_quotas(schedule, &week_of);
    // Every verse with an anchor card, which leaves out the pseudo-verses
    // that carry heading and chapter cards.
    let mut unmemorized: HashSet<u32> = engine
        .verse_render_data
        .keys()
        .copied()
        .filter(|&vid| anchor_card_for_verse(&engine, vid).is_some())
        .collect();
    let mut memorized_on: HashMap<u32, i64> = HashMap::new();
    let mut failures = Failures::default();
    let mut timing = Timing::default();

    for day in first_day..=last_day {
        let now = day * SECONDS_PER_DAY + MEMORIZE_AT_SECS;
        let budget = match schedule.current_week_index(now) {
            Some(w) if !profile.skipped_weeks.contains(&w) => {
                daily_budget(week_starts[w], quotas[w], day) * profile.pace
            }
            _ => 0,
        };
        let mut memorized_today = 0;
        while memorized_today < budget {
            let mut debt = timing.debt(&engine, schedule, now);
            let served = timing.batch(&engine, schedule, now, setting.batch_size);
            if served.len() > usize::from(setting.batch_size) {
                failures.oversized_batch += 1;
            }
            if served.is_empty() {
                if debt > 0 {
                    failures.count_vs_batch += 1;
                }
                break;
            }
            let before = memorized_today;
            for vid in served {
                // The learner stops at its budget and leaves the rest of the
                // batch for the next press, so an overfilled batch counts as
                // a failure but buys no extra progress.
                if memorized_today == budget {
                    break;
                }
                if debt == 0 && !in_nearest_week(vid, &week_of, &unmemorized) {
                    failures.not_nearest_week += 1;
                }
                engine.graduate_verse(vid);
                if unmemorized.remove(&vid) {
                    memorized_on.insert(vid, day);
                    memorized_today += 1;
                }
                let after = timing.debt(&engine, schedule, now);
                if debt > 0 && after + 1 != debt {
                    failures.non_owed_while_owed += 1;
                }
                if debt == 0 && after != 0 {
                    failures.count_vs_batch += 1;
                }
                debt = after;
            }
            // A queue that only serves memorized verses would spin forever.
            if memorized_today == before {
                break;
            }
        }
    }

    // A verse waits from its week's date until it is memorized, or until the
    // last day walked if it never is; memorizing it ahead is no wait.
    let wait_days = week_of
        .iter()
        .map(|(vid, &week)| {
            let done = memorized_on.get(vid).copied().unwrap_or(last_day);
            (done - week_starts[week]).max(0)
        })
        .sum();
    Outcome {
        memorized: memorized_on.len(),
        wait_days,
        scheduled: week_of.len(),
        failures,
        timing,
    }
}

/// SC-002: with nothing owed, a verse served comes from the nearest week
/// that still has un-memorized verses. Trivially true once every scheduled
/// verse is memorized.
fn in_nearest_week(vid: u32, week_of: &HashMap<u32, usize>, unmemorized: &HashSet<u32>) -> bool {
    let Some(nearest) = unmemorized.iter().filter_map(|v| week_of.get(v)).min() else {
        return true;
    };
    week_of.get(&vid) == Some(nearest)
}

/// Header of the `--out` file; one row per season, setting and learner.
const OUTCOME_HEADER: &str =
    "season\tgates\tcatch_up\tbatch\tlearner\tmemorized\twait_days\tscheduled";

fn outcome_table(settings: &[Setting], results: &[Vec<Vec<Outcome>>]) -> String {
    let mut table = String::from(OUTCOME_HEADER);
    table.push('\n');
    for (season, per_setting) in SEASONS.iter().zip(results) {
        for (setting, outcomes) in settings.iter().zip(per_setting) {
            for (profile, o) in PROFILES.iter().zip(outcomes) {
                writeln!(
                    table,
                    "{}\t{}\t{}\t{}\t{}\t{}",
                    season.name,
                    setting.key(),
                    profile.name,
                    o.memorized,
                    o.wait_days,
                    o.scheduled
                )
                .expect("writing to a String cannot fail");
            }
        }
    }
    table
}

/// Parses an `--out` table into `key → (memorized, mean wait)`, keyed by
/// the season, setting and learner columns.
fn parse_outcomes(table: &str) -> HashMap<String, (usize, f64)> {
    table
        .lines()
        .skip(1)
        .filter_map(|line| {
            // The last three columns are the numbers; the rest is the key.
            let mut cols = line.rsplitn(4, '\t');
            let scheduled: f64 = cols.next()?.parse().ok()?;
            let wait_days: f64 = cols.next()?.parse().ok()?;
            let memorized: usize = cols.next()?.parse().ok()?;
            let key = cols.next()?.to_string();
            Some((key, (memorized, wait_days / scheduled.max(1.0))))
        })
        .collect()
}

/// SC-004 per season, setting and learner: at least as many verses
/// memorized as the baseline, and a mean wait no longer.
fn compare(baseline: &str, current: &str) {
    let before = parse_outcomes(baseline);
    let after = parse_outcomes(current);
    let mut regressions: Vec<String> = Vec::new();
    let mut missing = 0;
    for (key, &(memorized, wait)) in &after {
        let Some(&(base_memorized, base_wait)) = before.get(key) else {
            missing += 1;
            continue;
        };
        if memorized < base_memorized || wait > base_wait + 1e-9 {
            regressions.push(format!(
                "| {} | {base_memorized} → {memorized} | {base_wait:.2} → {wait:.2} |",
                key.replace('\t', " · ")
            ));
        }
    }
    regressions.sort();
    println!();
    println!(
        "SC-004 against the baseline: {} of {} combinations regressed, {} missing from it.",
        regressions.len(),
        after.len(),
        missing
    );
    if regressions.is_empty() {
        return;
    }
    println!();
    println!("| Combination | Verses memorized | Mean wait (days) |");
    println!("| ----------- | ---------------- | ---------------- |");
    for row in regressions {
        println!("{row}");
    }
}
