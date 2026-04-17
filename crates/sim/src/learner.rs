use std::collections::HashMap;

use rand::Rng;
use rand::rngs::StdRng;

use verse_vault_core::card::Card;
use verse_vault_core::edge::EdgeState;
use verse_vault_core::fsrs_bridge::FsrsBridge;
use verse_vault_core::graph::Graph;
use verse_vault_core::types::{Grade, NodeId};

/// A simulated learner with "true" memory states.
/// Recall is stochastic: pass with probability R_true.
pub struct SimulatedLearner {
    true_states: HashMap<NodeId, f32>,
    last_review: HashMap<NodeId, i64>,
    rng: StdRng,
    fsrs: FsrsBridge,
}

impl SimulatedLearner {
    pub fn new(rng: StdRng, desired_retention: f32) -> Self {
        Self {
            true_states: HashMap::new(),
            last_review: HashMap::new(),
            rng,
            fsrs: FsrsBridge::new(desired_retention),
        }
    }

    pub fn initialize_atoms(
        &mut self,
        atoms: &[NodeId],
        initial_stability: f32,
        last_review_secs: i64,
    ) {
        for &atom in atoms {
            self.true_states.entry(atom).or_insert(initial_stability);
            self.last_review.entry(atom).or_insert(last_review_secs);
        }
    }

    /// Simulate a review: for each hidden atom, stochastically determine recall.
    /// Returns grades for each hidden atom.
    pub fn review(&mut self, _graph: &Graph, card: &Card, now_secs: i64) -> HashMap<NodeId, Grade> {
        let mut grades = HashMap::new();

        for &hidden in &card.hidden {
            let stability = self.true_states.get(&hidden).copied().unwrap_or(1.0);
            let last_rev = self.last_review.get(&hidden).copied().unwrap_or(0);
            let state = EdgeState {
                stability,
                difficulty: 5.0,
                last_review_secs: last_rev,
            };
            let r_true = self.fsrs.retrievability(&state, now_secs);

            let roll: f32 = self.rng.random();
            let grade = if roll < r_true {
                Grade::Good
            } else {
                Grade::Again
            };

            grades.insert(hidden, grade);
        }

        grades
    }

    pub fn update_true_state(&mut self, grades: &HashMap<NodeId, Grade>, now_secs: i64) {
        for (&atom, &grade) in grades {
            let s = self.true_states.get(&atom).copied().unwrap_or(1.0);
            let new_s = match grade {
                Grade::Again => (s * 0.5).max(0.1),
                Grade::Hard => s * 1.1,
                Grade::Good => s * 1.5,
                Grade::Easy => s * 2.0,
            };
            self.true_states.insert(atom, new_s);
            self.last_review.insert(atom, now_secs);
        }
    }

    #[allow(dead_code)]
    pub fn true_stability(&self, atom: NodeId) -> f32 {
        self.true_states.get(&atom).copied().unwrap_or(0.0)
    }
}
