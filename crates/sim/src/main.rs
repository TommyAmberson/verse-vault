//! HSRS-engine simulation with a probabilistic learner.
//!
//! Loads `data/3-corinthians.json`, builds a `ReviewEngine`, and steps a
//! per-day review loop. A `ProbLearner` maintains parallel ground-truth
//! per-test FSRS state; on each review it samples pass/fail per contained
//! test from its true retrievability, derives a card-level grade, feeds the
//! grade to the engine, and updates its truth from the per-test outcomes.
//!
//! Outputs aggregate calibration metrics (log_loss / AUC / RMSE-binned)
//! over `(engine_predicted_r, actual_pass)` pairs, plus engine-vs-truth
//! state drift.

use std::collections::HashMap;
use std::path::PathBuf;

use verse_vault_core::builder::build;
use verse_vault_core::content::MaterialData;
use verse_vault_core::engine::{ReviewEngine, UpdateKind};
use verse_vault_core::schedule::next_card;
use verse_vault_core::test_kind::TestKey;
use verse_vault_core::types::Grade;

mod learner;
mod metrics;

use learner::ProbLearner;
use metrics::{Prediction, auc, log_loss, rmse_binned};

const DEFAULT_REVIEWS: usize = 100;
const DEFAULT_REVIEWS_PER_DAY: usize = 50;
const SECONDS_PER_DAY: i64 = 86_400;
const RNG_SEED: u64 = 0xC0FFEE;

#[derive(Debug, Clone)]
struct SimArgs {
    reviews: usize,
    reviews_per_day: usize,
    /// Optional 21-value FSRS-6 parameter vector for the learner's ground
    /// truth. The engine always uses defaults — passing this flag lets the
    /// sim measure how well the engine's default-params predictions
    /// calibrate against a user-fitted truth.
    learner_params: Option<Vec<f32>>,
}

fn parse_args() -> SimArgs {
    let mut reviews = DEFAULT_REVIEWS;
    let mut reviews_per_day = DEFAULT_REVIEWS_PER_DAY;
    let mut learner_params: Option<Vec<f32>> = None;
    let mut args = std::env::args().skip(1);
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--reviews" => {
                if let Some(n) = args.next()
                    && let Ok(parsed) = n.parse::<usize>()
                {
                    reviews = parsed;
                }
            }
            "--reviews-per-day" => {
                if let Some(n) = args.next()
                    && let Ok(parsed) = n.parse::<usize>()
                {
                    reviews_per_day = parsed.max(1);
                }
            }
            "--learner-params" => {
                if let Some(spec) = args.next() {
                    let parsed: Result<Vec<f32>, _> = spec
                        .split(|c: char| c == ',' || c.is_whitespace())
                        .filter(|s| !s.is_empty())
                        .map(|s| s.parse::<f32>())
                        .collect();
                    match parsed {
                        Ok(v) if v.len() == 21 => learner_params = Some(v),
                        Ok(v) => eprintln!(
                            "--learner-params: expected 21 values, got {} — ignoring",
                            v.len()
                        ),
                        Err(e) => eprintln!("--learner-params: parse error {e} — ignoring"),
                    }
                }
            }
            _ => {}
        }
    }
    SimArgs {
        reviews,
        reviews_per_day,
        learner_params,
    }
}

fn fixture_path() -> PathBuf {
    let mut p = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    p.push("../../data/3-corinthians.json");
    p
}

fn main() {
    let SimArgs {
        reviews,
        reviews_per_day,
        learner_params,
    } = parse_args();
    let path = fixture_path();
    let json = std::fs::read_to_string(&path).expect("corinthians fixture should exist");
    let material: MaterialData = serde_json::from_str(&json).expect("fixture parses");

    // Engine is seeded as if "now = 0" so unseen tests have last_seen one
    // year in the past. The simulation clock starts a year later so they're
    // already due. Learner uses the same seed so its truth stays aligned.
    let initial_seed_secs = 0;
    let result = build(&material, initial_seed_secs);
    let total_cards = result.cards.len();
    let total_tests = result.tests.len();
    let mut engine = ReviewEngine::new(result, 0.9);
    let mut learner = match &learner_params {
        Some(params) => ProbLearner::with_parameters(RNG_SEED, 0.9, params, initial_seed_secs),
        None => ProbLearner::new(RNG_SEED, 0.9, initial_seed_secs),
    };

    let mut predictions: Vec<Prediction> = Vec::new();
    let mut day_review_counts: HashMap<i64, usize> = HashMap::new();
    let mut grades_count = [0usize; 4];

    let mut day_start = SECONDS_PER_DAY * 365;
    // Pace reviews evenly across the day-1s window so same-day sibling
    // cooldown still applies. `.max(1)` guards against `reviews_per_day`
    // values larger than 86399 silently making the clock stand still.
    let step_secs = ((SECONDS_PER_DAY - 1) / reviews_per_day as i64).max(1);
    let mut intra_day = 0usize;

    let mut completed = 0usize;
    let mut total_root = 0usize;
    let mut total_sub = 0usize;
    let mut pass_count = 0usize;
    let mut fail_count = 0usize;
    let mut idle_days = 0usize;

    while completed < reviews {
        if intra_day >= reviews_per_day {
            day_start += SECONDS_PER_DAY;
            intra_day = 0;
        }
        let now = day_start + step_secs * intra_day as i64;
        intra_day += 1;

        let card_id = match next_card(&engine, now) {
            Some(id) => id,
            None => {
                // No cards due right now. Skip the rest of today (cooldown
                // can't unblock anything within today since now is monotone)
                // and try tomorrow.
                if intra_day == 1 {
                    // Already tried this day's first slot; nothing's due.
                    idle_days += 1;
                    if idle_days > 365 {
                        break;
                    }
                }
                intra_day = reviews_per_day;
                continue;
            }
        };
        idle_days = 0;
        let card = engine
            .card(card_id)
            .cloned()
            .expect("scheduler must point at an existing card");
        let atoms = engine.atoms_for(card.verse_id);
        let tests = card.tests(&atoms);
        if tests.is_empty() {
            continue;
        }

        // Capture engine predictions BEFORE the review.
        let pre_predictions: Vec<(TestKey, f32)> = tests
            .iter()
            .map(|&k| {
                let r = engine
                    .test_state(k)
                    .map(|s| engine.fsrs.retrievability_of(s, now))
                    .unwrap_or(1.0);
                (k, r)
            })
            .collect();

        // Learner samples per-test outcomes.
        let outcomes = learner.observe_card(&tests, now);
        for ((_, predicted_r), o) in pre_predictions.iter().zip(outcomes.iter()) {
            predictions.push(Prediction {
                predicted_r: *predicted_r,
                actual_pass: o.pass,
            });
            if o.pass {
                pass_count += 1;
            } else {
                fail_count += 1;
            }
        }

        // Aggregate to a card-level grade and feed engine + truth.
        let grade = learner.card_grade_from_outcomes(&outcomes);
        grades_count[grade_index(grade)] += 1;

        let outcome = engine.review(card_id, grade, now);
        for u in &outcome.updates {
            match u.kind {
                UpdateKind::Root => total_root += 1,
                UpdateKind::Sub => total_sub += 1,
            }
        }
        learner.record(&outcomes, now);

        completed += 1;
        *day_review_counts.entry(now / SECONDS_PER_DAY).or_default() += 1;
    }

    // Calibration metrics.
    let ll = log_loss(&predictions);
    let auroc = auc(&predictions);
    let rmse = rmse_binned(&predictions);

    // Engine-vs-truth state drift over tests both sides have updated.
    let (drift_n, drift_rms) = stability_drift(&engine, &learner);

    let avg_per_day = if !day_review_counts.is_empty() {
        completed as f32 / day_review_counts.len() as f32
    } else {
        0.0
    };

    let learner_label = match &learner_params {
        Some(p) => format!("custom (decay={:.4})", p.last().unwrap_or(&0.0)),
        None => "default".to_string(),
    };

    println!(
        "verse-vault-sim:\n  \
         catalog: cards={total_cards} tests={total_tests}\n  \
         learner_params={learner_label}\n  \
         reviews_done={completed} root_updates={total_root} sub_updates={total_sub}\n  \
         outcomes: pass={pass_count} fail={fail_count}\n  \
         grades: again={} hard={} good={} easy={}\n  \
         calibration: log_loss={:.4} auc={:.4} rmse_binned={:.4} predictions={}\n  \
         drift: n={} rms_stability_diff={:.4}\n  \
         schedule: days_active={} avg_reviews_per_day={:.1}",
        grades_count[0],
        grades_count[1],
        grades_count[2],
        grades_count[3],
        ll,
        auroc,
        rmse,
        predictions.len(),
        drift_n,
        drift_rms,
        day_review_counts.len(),
        avg_per_day,
    );
}

fn grade_index(g: Grade) -> usize {
    match g {
        Grade::Again => 0,
        Grade::Hard => 1,
        Grade::Good => 2,
        Grade::Easy => 3,
    }
}

/// RMS difference between engine.tests[k].stability and learner.truth[k].stability
/// over keys present in both maps.
fn stability_drift(engine: &ReviewEngine, learner: &ProbLearner) -> (usize, f32) {
    let truth = learner.truth();
    let mut sq_sum = 0.0f64;
    let mut n = 0usize;
    for (k, t) in truth.iter() {
        if let Some(e) = engine.test_state(*k) {
            let d = (e.stability - t.stability) as f64;
            sq_sum += d * d;
            n += 1;
        }
    }
    if n == 0 {
        (0, 0.0)
    } else {
        (n, ((sq_sum / n as f64).sqrt()) as f32)
    }
}
