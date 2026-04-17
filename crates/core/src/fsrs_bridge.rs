use fsrs::{DEFAULT_PARAMETERS, FSRS, FSRS6_DEFAULT_DECAY, MemoryState, NextStates};

use crate::edge::EdgeState;
use crate::types::Grade;

const SECS_PER_DAY: f64 = 86400.0;

pub struct FsrsBridge {
    fsrs: FSRS,
    decay: f32,
    pub desired_retention: f32,
}

impl FsrsBridge {
    pub fn new(desired_retention: f32) -> Self {
        Self::with_parameters(&DEFAULT_PARAMETERS, desired_retention)
    }

    pub fn with_parameters(params: &[f32], desired_retention: f32) -> Self {
        let decay = if params.len() >= 21 {
            params[20]
        } else {
            FSRS6_DEFAULT_DECAY
        };
        Self {
            fsrs: FSRS::new(Some(params)).expect("valid FSRS parameters"),
            decay,
            desired_retention,
        }
    }

    pub fn retrievability(&self, state: &EdgeState, now_secs: i64) -> f32 {
        let days_elapsed = secs_to_days(now_secs - state.last_review_secs);
        if days_elapsed <= 0.0 || state.stability <= 0.0 {
            return 1.0;
        }
        let ms = MemoryState {
            stability: state.stability,
            difficulty: state.difficulty,
        };
        fsrs::current_retrievability(ms, days_elapsed as f32, self.decay)
    }

    pub fn next_states(&self, state: &EdgeState, now_secs: i64) -> NextStates {
        let days_elapsed = secs_to_days(now_secs - state.last_review_secs).max(0.0) as u32;
        let ms = MemoryState {
            stability: state.stability,
            difficulty: state.difficulty,
        };
        self.fsrs
            .next_states(Some(ms), self.desired_retention, days_elapsed)
            .expect("valid FSRS state")
    }

    pub fn initial_state(&self, _grade: Grade) -> NextStates {
        self.fsrs
            .next_states(None, self.desired_retention, 0)
            .expect("valid initial state")
    }

    /// Apply a weighted update to an edge state.
    ///
    /// Each `(grade, weight)` pair contributes proportionally to the update.
    /// weight=1.0 is a full FSRS update. weight=0.2 moves 20% toward the
    /// FSRS target. Updates accumulate additively.
    pub fn apply_weighted_update(
        &self,
        current: &EdgeState,
        updates: &[(Grade, f32)],
        now_secs: i64,
    ) -> EdgeState {
        if updates.is_empty() {
            return *current;
        }

        let next = self.next_states(current, now_secs);

        let mut s_delta = 0.0f32;
        let mut d_delta = 0.0f32;

        for &(grade, weight) in updates {
            let target = grade_to_state(&next, grade);
            s_delta += weight * (target.stability - current.stability);
            d_delta += weight * (target.difficulty - current.difficulty);
        }

        EdgeState {
            stability: (current.stability + s_delta).max(0.01),
            difficulty: (current.difficulty + d_delta).clamp(1.0, 10.0),
            last_review_secs: now_secs,
        }
    }
}

fn grade_to_state(next: &NextStates, grade: Grade) -> &MemoryState {
    match grade {
        Grade::Again => &next.again.memory,
        Grade::Hard => &next.hard.memory,
        Grade::Good => &next.good.memory,
        Grade::Easy => &next.easy.memory,
    }
}

fn secs_to_days(secs: i64) -> f64 {
    secs as f64 / SECS_PER_DAY
}

#[cfg(test)]
mod tests {
    use super::*;

    fn bridge() -> FsrsBridge {
        FsrsBridge::new(0.9)
    }

    fn reviewed_state(secs_ago: i64) -> EdgeState {
        EdgeState {
            stability: 10.0,
            difficulty: 5.0,
            last_review_secs: -secs_ago,
        }
    }

    #[test]
    fn retrievability_at_zero_elapsed_is_one() {
        let b = bridge();
        let state = EdgeState {
            stability: 10.0,
            difficulty: 5.0,
            last_review_secs: 0,
        };
        let r = b.retrievability(&state, 0);
        assert!((r - 1.0).abs() < 0.001, "R at t=0 should be ~1.0, got {r}");
    }

    #[test]
    fn retrievability_decreases_over_time() {
        let b = bridge();
        let state = EdgeState {
            stability: 10.0,
            difficulty: 5.0,
            last_review_secs: 0,
        };
        let r_1day = b.retrievability(&state, 86400);
        let r_10day = b.retrievability(&state, 86400 * 10);
        let r_30day = b.retrievability(&state, 86400 * 30);

        assert!(r_1day > r_10day, "R should decrease: {r_1day} > {r_10day}");
        assert!(
            r_10day > r_30day,
            "R should decrease: {r_10day} > {r_30day}"
        );
        assert!(r_1day < 1.0);
        assert!(r_30day > 0.0);
    }

    #[test]
    fn retrievability_matches_fsrs_directly() {
        let b = bridge();
        let state = EdgeState {
            stability: 10.0,
            difficulty: 5.0,
            last_review_secs: 0,
        };
        let our_r = b.retrievability(&state, 86400 * 5);
        let ms = MemoryState {
            stability: 10.0,
            difficulty: 5.0,
        };
        let fsrs_r = fsrs::current_retrievability(ms, 5.0, FSRS6_DEFAULT_DECAY);
        assert!(
            (our_r - fsrs_r).abs() < 0.001,
            "should match fsrs-rs: ours={our_r}, fsrs={fsrs_r}"
        );
    }

    #[test]
    fn weighted_update_full_weight() {
        let b = bridge();
        let state = reviewed_state(86400 * 5);
        let updated = b.apply_weighted_update(&state, &[(Grade::Good, 1.0)], 0);
        assert!(
            updated.stability > state.stability,
            "Good review should increase S"
        );
        assert_eq!(updated.last_review_secs, 0);
    }

    #[test]
    fn weighted_update_partial_weight() {
        let b = bridge();
        let state = reviewed_state(86400 * 5);
        let full = b.apply_weighted_update(&state, &[(Grade::Good, 1.0)], 0);
        let partial = b.apply_weighted_update(&state, &[(Grade::Good, 0.2)], 0);

        let full_delta = full.stability - state.stability;
        let partial_delta = partial.stability - state.stability;
        let ratio = partial_delta / full_delta;
        assert!(
            (ratio - 0.2).abs() < 0.01,
            "partial should be ~20% of full: ratio={ratio}"
        );
    }

    #[test]
    fn weighted_update_again_decreases_stability() {
        let b = bridge();
        let state = reviewed_state(86400 * 5);
        let updated = b.apply_weighted_update(&state, &[(Grade::Again, 1.0)], 0);
        assert!(
            updated.stability < state.stability,
            "Again should decrease S: {} vs {}",
            updated.stability,
            state.stability
        );
    }

    #[test]
    fn weighted_update_blends_grades() {
        let b = bridge();
        let state = reviewed_state(86400 * 5);
        let good_only = b.apply_weighted_update(&state, &[(Grade::Good, 0.7)], 0);
        let blended =
            b.apply_weighted_update(&state, &[(Grade::Good, 0.7), (Grade::Again, 0.3)], 0);
        assert!(
            blended.stability < good_only.stability,
            "blending Again should lower S vs pure Good"
        );
    }

    #[test]
    fn difficulty_clamped() {
        let b = bridge();
        let low_d = EdgeState {
            stability: 10.0,
            difficulty: 1.0,
            last_review_secs: -86400,
        };
        let updated = b.apply_weighted_update(&low_d, &[(Grade::Easy, 1.0)], 0);
        assert!(
            updated.difficulty >= 1.0,
            "D should not go below 1.0: {}",
            updated.difficulty
        );

        let high_d = EdgeState {
            stability: 10.0,
            difficulty: 10.0,
            last_review_secs: -86400,
        };
        let updated = b.apply_weighted_update(&high_d, &[(Grade::Again, 1.0)], 0);
        assert!(
            updated.difficulty <= 10.0,
            "D should not exceed 10.0: {}",
            updated.difficulty
        );
    }
}
