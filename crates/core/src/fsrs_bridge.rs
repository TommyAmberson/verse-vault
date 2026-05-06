//! Minimal FSRS-6 inference. Reimplements the scalar formulas from `fsrs-rs`
//! without its training infrastructure (which pulls in `burn` + ML dependencies
//! incompatible with wasm32).
//!
//! Reference: <https://github.com/open-spaced-repetition/fsrs-rs>

use crate::edge::EdgeState;
use crate::test_state::TestState;
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

impl From<&TestState> for MemoryState {
    fn from(ts: &TestState) -> Self {
        MemoryState {
            stability: ts.stability,
            difficulty: ts.difficulty,
        }
    }
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
            stability: (current.stability + s_delta).clamp(S_MIN, S_MAX),
            difficulty: (current.difficulty + d_delta).clamp(D_MIN, D_MAX),
            last_review_secs: now_secs,
        }
    }

    /// Predict retrievability at `now_secs` from this test's current state.
    pub fn retrievability_of(&self, state: &TestState, now_secs: i64) -> f32 {
        let elapsed = state.elapsed_days(now_secs).max(0.0);
        power_forgetting_curve(elapsed, state.stability, FSRS6_DEFAULT_DECAY)
    }

    /// The wall-clock time when this test will reach `target_r` retrievability,
    /// measured from `last_base_secs`.
    pub fn due_at(&self, state: &TestState, target_r: f32) -> i64 {
        let factor = (0.9_f32.ln() / -FSRS6_DEFAULT_DECAY).exp() - 1.0;
        let interval_days =
            state.stability * (target_r.powf(-1.0 / FSRS6_DEFAULT_DECAY) - 1.0) / factor;
        state.last_base_secs + (interval_days * SECS_PER_DAY as f32) as i64
    }

    /// HSRS-style probabilistic FSRS update with retrievability-space interpolation.
    /// `weight` in [0, 1] determines how strongly to apply the grade. weight=1.0 is
    /// equivalent to direct_step except `last_root_secs` is not advanced. weight=0.0
    /// is identity (only `last_seen_secs` advances).
    pub fn propagated_step(
        &self,
        state: &TestState,
        grade: Grade,
        weight: f32,
        now_secs: i64,
    ) -> TestState {
        let w = weight.clamp(0.0, 1.0);
        let direct = self.direct_step(state, grade, now_secs);
        let elapsed = state.elapsed_days(now_secs).max(0.0);
        let r_now = power_forgetting_curve(elapsed, state.stability, FSRS6_DEFAULT_DECAY);
        let r_direct = power_forgetting_curve(elapsed, direct.stability, FSRS6_DEFAULT_DECAY);
        let r_blend = (1.0 - w) * r_now + w * r_direct;
        let s_blend = invert_r(r_blend, elapsed.max(0.001), FSRS6_DEFAULT_DECAY);
        let d_blend = (1.0 - w) * state.difficulty + w * direct.difficulty;
        let base_blend_f =
            (1.0 - w as f64) * state.last_base_secs as f64 + w as f64 * now_secs as f64;
        TestState {
            stability: s_blend.clamp(S_MIN, S_MAX),
            difficulty: d_blend.clamp(D_MIN, D_MAX),
            last_seen_secs: now_secs,
            last_base_secs: base_blend_f as i64,
            last_root_secs: state.last_root_secs,
        }
    }

    pub fn direct_step(&self, state: &TestState, grade: Grade, now_secs: i64) -> TestState {
        let elapsed_days = state.elapsed_days(now_secs).max(0.0);
        let memory: MemoryState = state.into();
        let next = self.step(Some(memory), elapsed_days, grade as u32);
        TestState {
            stability: next.stability.clamp(S_MIN, S_MAX),
            difficulty: next.difficulty.clamp(D_MIN, D_MAX),
            last_seen_secs: now_secs,
            last_base_secs: now_secs,
            last_root_secs: now_secs,
        }
    }

    fn compute_next_states(&self, current: Option<EdgeState>, days_elapsed: u32) -> NextStates {
        let delta_t = days_elapsed as f32;
        let mut states = [MemoryState {
            stability: 0.0,
            difficulty: 0.0,
        }; 4];

        let memory = current.map(|c| MemoryState {
            stability: c.stability,
            difficulty: c.difficulty,
        });
        for (i, rating) in [1u32, 2, 3, 4].iter().copied().enumerate() {
            states[i] = self.step(memory, delta_t, rating);
        }

        NextStates {
            again: states[0],
            hard: states[1],
            good: states[2],
            easy: states[3],
        }
    }

    /// FSRS state transition. `current=None` means new card (use initial state).
    fn step(&self, current: Option<MemoryState>, delta_t: f32, rating: u32) -> MemoryState {
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
        let sinc = if rating >= 2 { sinc.max(1.0) } else { sinc };
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

/// Inverse of the FSRS power forgetting curve: given a target retrievability,
/// elapsed days, and decay, return the stability that produces that retrievability.
/// Used by HSRS-style retrievability-space interpolation in propagated_step.
pub fn invert_r(r: f32, elapsed_days: f32, decay: f32) -> f32 {
    // R = (1 + factor·t/S)^(-decay), so S = factor·t / (R^(-1/decay) - 1)
    let factor = (0.9_f32.ln() / -decay).exp() - 1.0;
    let denom = r.powf(-1.0 / decay) - 1.0;
    if denom.abs() < 1e-9 {
        return S_MAX;
    }
    (factor * elapsed_days / denom).clamp(S_MIN, S_MAX)
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
    fn direct_step_good_increases_stability() {
        let bridge = FsrsBridge::new(0.9);
        let now0 = 86400 * 365;
        let ts = TestState::new_unseen(now0);
        let now1 = now0 + 86400 * 7;
        let after = bridge.direct_step(&ts, Grade::Good, now1);
        // Note: TestState::new_unseen sets last_base = now0 - 365 days,
        // so elapsed at now1 ≈ 372 days. After Good review, stability should rise.
        assert!(after.stability > ts.stability);
        assert_eq!(after.last_seen_secs, now1);
        assert_eq!(after.last_base_secs, now1);
        assert_eq!(after.last_root_secs, now1);
    }

    #[test]
    fn direct_step_hard_at_zero_delta_does_not_decrease_stability() {
        let bridge = FsrsBridge::new(0.9);
        let now = 86400 * 365;
        let ts = TestState {
            stability: 10.0,
            difficulty: 5.0,
            last_seen_secs: now,
            last_base_secs: now,
            last_root_secs: now,
        };
        let after = bridge.direct_step(&ts, Grade::Hard, now);
        assert!(
            after.stability >= ts.stability,
            "audit B1: Hard at delta=0 must not decrease S"
        );
    }

    #[test]
    fn retrievability_of_at_zero_elapsed_is_one() {
        let bridge = FsrsBridge::new(0.9);
        let ts = TestState {
            stability: 10.0,
            difficulty: 5.0,
            last_seen_secs: 100,
            last_base_secs: 100,
            last_root_secs: 100,
        };
        let r = bridge.retrievability_of(&ts, 100);
        assert!((r - 1.0).abs() < 0.001);
    }

    #[test]
    fn due_at_returns_now_plus_interval() {
        let bridge = FsrsBridge::new(0.9);
        let ts = TestState {
            stability: 10.0,
            difficulty: 5.0,
            last_seen_secs: 0,
            last_base_secs: 0,
            last_root_secs: 0,
        };
        let due = bridge.due_at(&ts, 0.9);
        let secs_from_base = due - ts.last_base_secs;
        // With FSRS-6 the interval at R=0.9 from S=10 is roughly 9-11 days
        assert!(
            secs_from_base >= 86400 * 8 && secs_from_base <= 86400 * 12,
            "due interval out of range: {} secs ({} days)",
            secs_from_base,
            secs_from_base / 86400
        );
    }

    #[test]
    fn propagated_step_zero_weight_is_identity() {
        let bridge = FsrsBridge::new(0.9);
        let ts = TestState {
            stability: 10.0,
            difficulty: 5.0,
            last_seen_secs: 0,
            last_base_secs: 0,
            last_root_secs: 0,
        };
        let after = bridge.propagated_step(&ts, Grade::Good, 0.0, 86400 * 7);
        assert!((after.stability - ts.stability).abs() < 1e-3);
        assert_eq!(after.last_seen_secs, 86400 * 7);
        assert_eq!(after.last_base_secs, ts.last_base_secs); // unchanged
        assert_eq!(after.last_root_secs, ts.last_root_secs); // unchanged
    }

    #[test]
    fn propagated_step_full_weight_matches_direct_modulo_root() {
        let bridge = FsrsBridge::new(0.9);
        let ts = TestState {
            stability: 10.0,
            difficulty: 5.0,
            last_seen_secs: 0,
            last_base_secs: 0,
            last_root_secs: 0,
        };
        let direct = bridge.direct_step(&ts, Grade::Good, 86400 * 7);
        let prop = bridge.propagated_step(&ts, Grade::Good, 1.0, 86400 * 7);
        assert!(
            (prop.stability - direct.stability).abs() < 0.5,
            "stability close: {} vs {}",
            prop.stability,
            direct.stability
        );
        assert!((prop.difficulty - direct.difficulty).abs() < 0.1);
        assert_eq!(prop.last_root_secs, ts.last_root_secs); // last_root never advances on propagation
        assert_eq!(prop.last_base_secs, 86400 * 7); // (1-1)·old + 1·now = now
    }

    #[test]
    fn invert_r_round_trip() {
        let s = 10.0;
        let elapsed_days = 5.0;
        let r = power_forgetting_curve(elapsed_days, s, FSRS6_DEFAULT_DECAY);
        let s_back = invert_r(r, elapsed_days, FSRS6_DEFAULT_DECAY);
        assert!((s - s_back).abs() < 0.01, "round trip: {} vs {}", s, s_back);
    }

    #[test]
    fn test_state_to_memory_round_trip() {
        let ts = TestState {
            stability: 12.0,
            difficulty: 6.5,
            last_seen_secs: 0,
            last_base_secs: 0,
            last_root_secs: 0,
        };
        let ms: MemoryState = (&ts).into();
        assert_eq!(ms.stability, 12.0);
        assert_eq!(ms.difficulty, 6.5);
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
    fn same_session_hard_does_not_decrease_stability() {
        let b = bridge();
        let state = EdgeState {
            stability: 10.0,
            difficulty: 5.0,
            last_review_secs: 0,
        };
        let updated = b.apply_weighted_update(&state, &[(Grade::Hard, 1.0)], 0);
        assert!(
            updated.stability >= state.stability,
            "same-day Hard must not decrease S (upstream fsrs-rs #376): {} -> {}",
            state.stability,
            updated.stability
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
