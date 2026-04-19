//! Minimal FSRS-6 inference. Reimplements the scalar formulas from `fsrs-rs`
//! without its training infrastructure (which pulls in `burn` + ML dependencies
//! incompatible with wasm32).
//!
//! Reference: <https://github.com/open-spaced-repetition/fsrs-rs>

use crate::edge::EdgeState;
use crate::types::Grade;

const SECS_PER_DAY: f64 = 86400.0;

const S_MIN: f32 = 0.001;
const S_MAX: f32 = 36500.0;
const D_MIN: f32 = 1.0;
const D_MAX: f32 = 10.0;

pub const FSRS6_DEFAULT_DECAY: f32 = 0.1542;

pub const DEFAULT_PARAMETERS: [f32; 21] = [
    0.212,
    1.2931,
    2.3065,
    8.2956,
    6.4133,
    0.8334,
    3.0194,
    0.001,
    1.8722,
    0.1666,
    0.796,
    1.4835,
    0.0614,
    0.2629,
    1.6483,
    0.6014,
    1.8729,
    0.5425,
    0.0912,
    0.0658,
    FSRS6_DEFAULT_DECAY,
];

#[derive(Debug, Clone, Copy)]
pub struct MemoryState {
    pub stability: f32,
    pub difficulty: f32,
}

#[derive(Debug, Clone, Copy)]
pub struct NextStates {
    pub again: MemoryState,
    pub hard: MemoryState,
    pub good: MemoryState,
    pub easy: MemoryState,
}

pub struct FsrsBridge {
    w: [f32; 21],
    decay: f32,
    pub desired_retention: f32,
}

impl FsrsBridge {
    pub fn new(desired_retention: f32) -> Self {
        Self::with_parameters(&DEFAULT_PARAMETERS, desired_retention)
    }

    pub fn with_parameters(params: &[f32], desired_retention: f32) -> Self {
        let mut w = DEFAULT_PARAMETERS;
        for (i, &p) in params.iter().enumerate().take(21) {
            w[i] = p;
        }
        let decay = if params.len() >= 21 {
            params[20]
        } else {
            FSRS6_DEFAULT_DECAY
        };
        Self {
            w,
            decay,
            desired_retention,
        }
    }

    pub fn retrievability(&self, state: &EdgeState, now_secs: i64) -> f32 {
        let days_elapsed = secs_to_days(now_secs - state.last_review_secs);
        if days_elapsed <= 0.0 || state.stability <= 0.0 {
            return 1.0;
        }
        power_forgetting_curve(days_elapsed as f32, state.stability, self.decay)
    }

    pub fn next_states(&self, state: &EdgeState, now_secs: i64) -> NextStates {
        let days_elapsed = secs_to_days(now_secs - state.last_review_secs).max(0.0) as u32;
        self.compute_next_states(Some(*state), days_elapsed)
    }

    pub fn initial_state(&self, _grade: Grade) -> NextStates {
        self.compute_next_states(None, 0)
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
            stability: (current.stability + s_delta).max(S_MIN),
            difficulty: (current.difficulty + d_delta).clamp(D_MIN, D_MAX),
            last_review_secs: now_secs,
        }
    }

    fn compute_next_states(&self, current: Option<EdgeState>, days_elapsed: u32) -> NextStates {
        let delta_t = days_elapsed as f32;
        let mut states = [MemoryState {
            stability: 0.0,
            difficulty: 0.0,
        }; 4];

        for (i, rating) in [1u32, 2, 3, 4].iter().copied().enumerate() {
            states[i] = self.step(current, delta_t, rating);
        }

        NextStates {
            again: states[0],
            hard: states[1],
            good: states[2],
            easy: states[3],
        }
    }

    /// FSRS state transition. `current=None` means new card (use initial state).
    fn step(&self, current: Option<EdgeState>, delta_t: f32, rating: u32) -> MemoryState {
        let is_initial = current.is_none();

        let (last_s, last_d) = match current {
            Some(c) => (
                c.stability.clamp(S_MIN, S_MAX),
                c.difficulty.clamp(D_MIN, D_MAX),
            ),
            None => (0.0, 0.0),
        };

        let init_s = self.init_stability(rating);
        let init_d = self.init_difficulty(rating).clamp(D_MIN, D_MAX);

        let (new_s, new_d) = if is_initial {
            (init_s, init_d)
        } else {
            let retrievability = power_forgetting_curve(delta_t, last_s, self.decay);

            let new_s = if delta_t == 0.0 {
                self.stability_short_term(last_s, rating)
            } else if rating == 1 {
                self.stability_after_failure(last_s, last_d, retrievability)
            } else {
                self.stability_after_success(last_s, last_d, retrievability, rating)
            };

            let mut new_d = self.next_difficulty(last_d, rating);
            new_d = self.mean_reversion(new_d).clamp(D_MIN, D_MAX);

            (new_s, new_d)
        };

        MemoryState {
            stability: new_s.clamp(S_MIN, S_MAX),
            difficulty: new_d,
        }
    }

    fn init_stability(&self, rating: u32) -> f32 {
        // w[0..4] correspond to ratings 1..4
        self.w[(rating - 1) as usize]
    }

    fn init_difficulty(&self, rating: u32) -> f32 {
        self.w[4] - ((self.w[5] * (rating as f32 - 1.0)).exp()) + 1.0
    }

    fn stability_after_success(&self, last_s: f32, last_d: f32, r: f32, rating: u32) -> f32 {
        let hard_penalty = if rating == 2 { self.w[15] } else { 1.0 };
        let easy_bonus = if rating == 4 { self.w[16] } else { 1.0 };

        last_s
            * (self.w[8].exp()
                * (11.0 - last_d)
                * last_s.powf(-self.w[9])
                * (((1.0 - r) * self.w[10]).exp() - 1.0)
                * hard_penalty
                * easy_bonus
                + 1.0)
    }

    fn stability_after_failure(&self, last_s: f32, last_d: f32, r: f32) -> f32 {
        let new_s = self.w[11]
            * last_d.powf(-self.w[12])
            * ((last_s + 1.0).powf(self.w[13]) - 1.0)
            * ((1.0 - r) * self.w[14]).exp();
        let new_s_min = last_s / (self.w[17] * self.w[18]).exp();
        new_s.min(new_s_min)
    }

    fn stability_short_term(&self, last_s: f32, rating: u32) -> f32 {
        let sinc =
            (self.w[17] * (rating as f32 - 3.0 + self.w[18])).exp() * last_s.powf(-self.w[19]);
        let sinc = if rating >= 3 { sinc.max(1.0) } else { sinc };
        last_s * sinc
    }

    fn linear_damping(&self, delta_d: f32, old_d: f32) -> f32 {
        (10.0 - old_d) * delta_d / 9.0
    }

    fn next_difficulty(&self, difficulty: f32, rating: u32) -> f32 {
        let delta_d = -self.w[6] * (rating as f32 - 3.0);
        difficulty + self.linear_damping(delta_d, difficulty)
    }

    fn mean_reversion(&self, new_d: f32) -> f32 {
        // init_difficulty for rating=4 (Easy) is the target
        let target = self.init_difficulty(4);
        self.w[7] * (target - new_d) + new_d
    }
}

pub fn current_retrievability(state: MemoryState, days_elapsed: f32, decay: f32) -> f32 {
    power_forgetting_curve(days_elapsed, state.stability, decay)
}

fn power_forgetting_curve(t: f32, s: f32, decay: f32) -> f32 {
    let factor = (0.9f32.ln() / -decay).exp() - 1.0;
    (t / s * factor + 1.0).powf(-decay)
}

fn grade_to_state(next: &NextStates, grade: Grade) -> &MemoryState {
    match grade {
        Grade::Again => &next.again,
        Grade::Hard => &next.hard,
        Grade::Good => &next.good,
        Grade::Easy => &next.easy,
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
    fn retrievability_matches_formula() {
        let b = bridge();
        let state = EdgeState {
            stability: 10.0,
            difficulty: 5.0,
            last_review_secs: 0,
        };
        let our_r = b.retrievability(&state, 86400 * 5);
        let direct_r = current_retrievability(
            MemoryState {
                stability: 10.0,
                difficulty: 5.0,
            },
            5.0,
            FSRS6_DEFAULT_DECAY,
        );
        assert!(
            (our_r - direct_r).abs() < 0.001,
            "should match formula: ours={our_r}, formula={direct_r}"
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
