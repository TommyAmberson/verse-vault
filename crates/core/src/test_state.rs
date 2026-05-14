use serde::{Deserialize, Serialize};

/// FSRS-6 memory state for a single test.
///
/// HSRS extends the FSRS pair `(stability, difficulty)` with three timestamps
/// so that propagated (partial) updates can be distinguished from direct
/// (full) ones. See `docs/path-posterior-memory-model.md` for the model and
/// `crate::fsrs_bridge` for the update primitives.
#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
pub struct TestState {
    /// FSRS stability in days.
    pub stability: f32,
    /// FSRS difficulty in `[1, 10]`.
    pub difficulty: f32,
    /// Wall-clock time of the most recent touch, direct or propagated.
    /// Drives the forgetting-curve elapsed input — see `elapsed_days`.
    /// HSRS calls this `lastSeen` and uses it the same way: every update
    /// advances it to `now`, so the next review's forgetting math sees the
    /// true wall-clock interval since the previous touch.
    pub last_seen_secs: i64,
    /// Scheduling anchor for the next due-date computation. Advances fully
    /// on a direct review and partially (interpolated by edge weight) on a
    /// propagated update — soft updates produce a soft due-date refresh,
    /// keeping the scheduler conservative when evidence is weak. Mirrors
    /// HSRS's `lastBase`. Not used in the forgetting curve.
    pub last_base_secs: i64,
    /// Wall-clock time of the most recent *direct* review. Never advances
    /// under propagation — that is the load-bearing invariant of HSRS that
    /// keeps propagated tests from masquerading as directly-reviewed ones.
    pub last_root_secs: i64,
    /// Set to `true` when this test was last graded `Again` and the
    /// learner hasn't passed it since. The session-level relearning lane
    /// surfaces such tests' cards once their FSRS due time elapses,
    /// bypassing the sibling cooldown. Cleared on any non-Again grade.
    #[serde(default)]
    pub pending_relearn: bool,
}

impl TestState {
    /// Construct an "unseen" state seeded one year in the past so the
    /// forgetting curve has had time to decay below the scheduler's target,
    /// putting fresh tests at the front of the queue immediately.
    pub fn new_unseen(now_secs: i64) -> Self {
        let prior = now_secs - 365 * 86400;
        TestState {
            stability: 1.0,
            difficulty: 5.0,
            last_seen_secs: prior,
            last_base_secs: prior,
            last_root_secs: prior,
            pending_relearn: false,
        }
    }

    /// Days elapsed since `last_seen_secs` — the input the FSRS forgetting
    /// curve takes. Mirrors HSRS's `now - state.lastSeen`. Clamped at zero
    /// so future-dated timestamps don't yield negative elapsed.
    pub fn elapsed_days(&self, now_secs: i64) -> f32 {
        ((now_secs - self.last_seen_secs).max(0) as f64 / 86400.0) as f32
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_state_new_unseen() {
        let s = TestState::new_unseen(86400 * 365);
        assert_eq!(s.stability, 1.0);
        assert_eq!(s.difficulty, 5.0);
        assert!((s.elapsed_days(86400 * 365) - 365.0).abs() < 0.01);
    }
}
