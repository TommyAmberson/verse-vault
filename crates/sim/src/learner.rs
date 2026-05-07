//! Probabilistic learner: maintains per-test ground-truth FSRS state.
//!
//! The engine's `TestState` is its *estimate* of memory; the learner's
//! `truth` is what the memory actually is. Reviews sample pass/fail per
//! test from the learner's true retrievability, then the learner records
//! those outcomes onto its truth via vanilla FSRS (full update, weight=1,
//! is_root=true) regardless of how the engine chose to spread credit.
//!
//! Comparing engine-state vs learner-truth across many reviews tells us
//! whether the engine's HSRS-style Bayesian decomposition introduces drift
//! away from "what would happen if every test got an honest FSRS update."

use std::collections::HashMap;

use rand::SeedableRng;
use rand::rngs::SmallRng;

use verse_vault_core::fsrs_bridge::FsrsBridge;
use verse_vault_core::test_kind::TestKey;
use verse_vault_core::test_state::TestState;
use verse_vault_core::types::Grade;

/// Mature-card stability threshold (days). All-pass on a card whose tests
/// are all at least this stable maps to `Easy`; all-pass below maps to
/// `Good`. Anki defines "mature" as ≥ 21d post-learning-steps; FSRS
/// stability after a single Good on a long-overdue unseen test can already
/// exceed that, so we use a higher threshold to keep `Easy` reserved for
/// genuinely well-memorised material.
const MATURE_STABILITY_DAYS: f32 = 90.0;

pub struct ProbLearner {
    fsrs: FsrsBridge,
    truth: HashMap<TestKey, TestState>,
    rng: SmallRng,
    /// Seed used for `TestState::new_unseen` — should match the engine's
    /// build-time seed so unseen retrievabilities line up.
    initial_seed_secs: i64,
}

impl ProbLearner {
    pub fn new(seed: u64, desired_retention: f32, initial_seed_secs: i64) -> Self {
        Self {
            fsrs: FsrsBridge::new(desired_retention),
            truth: HashMap::new(),
            rng: SmallRng::seed_from_u64(seed),
            initial_seed_secs,
        }
    }

    /// Learner's true retrievability for a test at `now_secs`. Unseen tests
    /// fall back to the same `new_unseen` seeding the engine uses.
    pub fn true_retrievability(&self, key: TestKey, now_secs: i64) -> f32 {
        let state = self
            .truth
            .get(&key)
            .copied()
            .unwrap_or_else(|| TestState::new_unseen(self.initial_seed_secs));
        self.fsrs.retrievability_of(&state, now_secs)
    }

    /// Sample pass/fail per test for the given card, based on the learner's
    /// true retrievability. Each `(key, pass)` is independent.
    pub fn observe_card(&mut self, tests: &[TestKey], now_secs: i64) -> Vec<(TestKey, bool)> {
        use rand::Rng;
        tests
            .iter()
            .map(|&k| {
                let r = self.true_retrievability(k, now_secs);
                let pass = self.rng.random::<f32>() < r;
                (k, pass)
            })
            .collect()
    }

    /// Record per-test outcomes to truth: each test gets a full FSRS update
    /// at weight=1 with `Good` for pass and `Again` for fail.
    pub fn record(&mut self, outcomes: &[(TestKey, bool)], now_secs: i64) {
        for (k, pass) in outcomes {
            let grade = if *pass { Grade::Good } else { Grade::Again };
            let entry = self
                .truth
                .entry(*k)
                .or_insert_with(|| TestState::new_unseen(self.initial_seed_secs));
            *entry = self.fsrs.update(entry, grade, 1.0, true, now_secs);
        }
    }

    /// Card-level grade derived from per-test outcomes:
    /// any failure → `Again`; all-pass on a young card → `Good`; all-pass
    /// where every test has matured → `Easy`. We don't synthesise `Hard`
    /// — that's a self-rated effort signal that doesn't fall out of pass/
    /// fail directly.
    pub fn card_grade_from_outcomes(&self, outcomes: &[(TestKey, bool)]) -> Grade {
        if outcomes.iter().any(|(_, pass)| !pass) {
            return Grade::Again;
        }
        let min_stability = outcomes
            .iter()
            .filter_map(|(k, _)| self.truth.get(k).map(|s| s.stability))
            .fold(f32::INFINITY, f32::min);
        if min_stability >= MATURE_STABILITY_DAYS {
            Grade::Easy
        } else {
            Grade::Good
        }
    }

    /// Borrow learner truth for diagnostics (engine-vs-truth drift).
    pub fn truth(&self) -> &HashMap<TestKey, TestState> {
        &self.truth
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use verse_vault_core::element::ElementId;
    use verse_vault_core::test_kind::TestKind;

    fn key(verse_id: u32, position: u16) -> TestKey {
        TestKey {
            kind: TestKind::PhraseFromChain,
            element: ElementId::Phrase { verse_id, position },
        }
    }

    #[test]
    fn unseen_test_has_low_retrievability() {
        let learner = ProbLearner::new(0, 0.9, 0);
        // At "now = 1 year past initial seed" the unseen-test retrievability
        // should be well below the 0.9 target — the seeding is one year prior.
        let r = learner.true_retrievability(key(0, 0), 86400 * 365);
        assert!(
            (0.05..0.5).contains(&r),
            "unseen retrievability out of expected band: {r}",
        );
    }

    #[test]
    fn observe_then_record_lifts_truth_stability() {
        let mut learner = ProbLearner::new(0, 0.9, 0);
        let k = key(0, 0);
        let outcomes = vec![(k, true)];
        learner.record(&outcomes, 86400 * 365);
        let s = learner.truth().get(&k).copied().unwrap();
        assert!(s.stability > TestState::new_unseen(0).stability);
        assert_eq!(s.last_seen_secs, 86400 * 365);
    }

    #[test]
    fn card_grade_again_on_any_failure() {
        let mut learner = ProbLearner::new(0, 0.9, 0);
        learner.record(&[(key(0, 0), true)], 86400 * 365);
        let grade = learner.card_grade_from_outcomes(&[(key(0, 0), true), (key(0, 1), false)]);
        assert_eq!(grade, Grade::Again);
    }

    #[test]
    fn card_grade_good_on_young_all_pass() {
        let mut learner = ProbLearner::new(0, 0.9, 0);
        // One Good review brings stability up but not above 21d.
        learner.record(&[(key(0, 0), true)], 86400 * 365);
        let grade = learner.card_grade_from_outcomes(&[(key(0, 0), true)]);
        assert_eq!(grade, Grade::Good);
    }
}
