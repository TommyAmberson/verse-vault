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
    /// Used by sibling cooldown to suppress overlapping cards in a session.
    pub last_seen_secs: i64,
    /// Wall-clock anchor for the forgetting curve. Advances fully on a
    /// direct review and partially (interpolated by edge weight) on a
    /// propagated update.
    pub last_base_secs: i64,
    /// Wall-clock time of the most recent *direct* review. Never advances
    /// under propagation — that is the load-bearing invariant of HSRS that
    /// keeps propagated tests from masquerading as directly-reviewed ones.
    pub last_root_secs: i64,
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
        }
    }

    /// Days elapsed since `last_base_secs`, the input the FSRS forgetting
    /// curve takes. Clamped at zero so future-dated bases don't go negative.
    pub fn elapsed_days(&self, now_secs: i64) -> f32 {
        ((now_secs - self.last_base_secs).max(0) as f64 / 86400.0) as f32
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
