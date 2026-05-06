use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
pub struct TestState {
    pub stability: f32,
    pub difficulty: f32,
    pub last_seen_secs: i64,
    pub last_base_secs: i64,
    pub last_root_secs: i64,
}

impl TestState {
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
