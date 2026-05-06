//! Minimal FSRS-6 inference. Reimplements the scalar formulas from `fsrs-rs`
//! without its training infrastructure (which pulls in `burn` + ML dependencies
//! incompatible with wasm32).
//!
//! Reference: <https://github.com/open-spaced-repetition/fsrs-rs>

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

    /// Predicted probability of recall at `now_secs` given the FSRS power
    /// forgetting curve and this test's `(stability, last_base_secs)`. The
    /// scheduler treats a card as due when its weakest test's retrievability
    /// drops below `ScheduleParams::target_retention`.
    pub fn retrievability_of(&self, state: &TestState, now_secs: i64) -> f32 {
        let elapsed = state.elapsed_days(now_secs).max(0.0);
        power_forgetting_curve(elapsed, state.stability, FSRS6_DEFAULT_DECAY)
    }

    /// Wall-clock time at which this test's retrievability will hit `target_r`,
    /// measured from `last_base_secs`. Closed-form inverse of the forgetting
    /// curve — no binary search.
    pub fn due_at(&self, state: &TestState, target_r: f32) -> i64 {
        let factor = (0.9_f32.ln() / -FSRS6_DEFAULT_DECAY).exp() - 1.0;
        let interval_days =
            state.stability * (target_r.powf(-1.0 / FSRS6_DEFAULT_DECAY) - 1.0) / factor;
        state.last_base_secs + (interval_days * SECS_PER_DAY as f32) as i64
    }

    /// HSRS partial update applied to a related (non-graded) test.
    ///
    /// Interpolates in retrievability space between the current state and the
    /// hypothetical post-direct state by `weight ∈ [0, 1]`. weight=0 is
    /// identity except for `last_seen_secs`; weight=1 matches `direct_step`
    /// except `last_root_secs` is preserved (the load-bearing invariant —
    /// propagation never claims the test was directly reviewed).
    ///
    /// See `docs/path-posterior-memory-model.md` for derivation.
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

    /// Full FSRS-6 update for a directly-graded test: advances all three
    /// timestamps to `now_secs` and applies the standard FSRS state
    /// transition. Stability and difficulty are clamped to FSRS-6 bounds.
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

#[cfg(test)]
mod tests {
    use super::*;

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
            (86_400 * 8..=86_400 * 12).contains(&secs_from_base),
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
}
