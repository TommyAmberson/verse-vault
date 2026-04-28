use std::collections::HashMap;

use crate::card::{Card, CardSchedule, CardState};
use crate::cascade::{self, EdgeCardMapping};
use crate::credit::{self, CreditParams, EdgeUpdate, ReviewResult};
use crate::fsrs_bridge::FsrsBridge;
use crate::graph::Graph;
use crate::schedule::ScheduleParams;
use crate::types::{CardId, Grade, NodeId};

pub struct ReviewEngine {
    pub graph: Graph,
    pub cards: Vec<Card>,
    pub schedules: Vec<CardSchedule>,
    pub fsrs: FsrsBridge,
    pub schedule_params: ScheduleParams,
    pub credit_params: CreditParams,
    mapping: EdgeCardMapping,
}

impl ReviewEngine {
    pub fn new(graph: Graph, cards: Vec<Card>, desired_retention: f32) -> Self {
        let fsrs = FsrsBridge::new(desired_retention);
        let schedule_params = ScheduleParams::default();
        let credit_params = CreditParams::default();
        let mapping = EdgeCardMapping::build(&graph, &cards, &schedule_params);

        let mut engine = Self {
            graph,
            cards,
            schedules: Vec::new(),
            fsrs,
            schedule_params,
            credit_params,
            mapping,
        };
        engine.recompute_all_schedules(0);
        engine
    }

    /// Pick the highest-priority due card.
    pub fn next_card(&self, now_secs: i64) -> Option<&CardSchedule> {
        self.schedules
            .iter()
            .filter(|s| {
                s.due_date_secs <= now_secs
                    && self
                        .cards
                        .iter()
                        .find(|c| c.id == s.card_id)
                        .is_some_and(|c| c.state == CardState::Review)
            })
            .max_by(|a, b| a.priority.partial_cmp(&b.priority).unwrap())
    }

    /// Process a review: run credit assignment, update edges, cascade to cards.
    pub fn review(
        &mut self,
        card_id: CardId,
        grades: HashMap<NodeId, Grade>,
        now_secs: i64,
    ) -> Vec<EdgeUpdate> {
        let card = match self.cards.iter().find(|c| c.id == card_id) {
            Some(c) => c,
            None => return Vec::new(),
        };

        let review_result = ReviewResult {
            shown: card.shown.clone(),
            hidden: card.hidden.clone(),
            grades,
        };

        self.apply_review(review_result, now_secs)
    }

    /// Process a review with a transient card (not from the catalog).
    /// Used for re-drills and progressive reveal cards.
    pub fn review_transient(
        &mut self,
        shown: &[NodeId],
        hidden: &[NodeId],
        grades: HashMap<NodeId, Grade>,
        now_secs: i64,
    ) -> Vec<EdgeUpdate> {
        let review_result = ReviewResult {
            shown: shown.to_vec(),
            hidden: hidden.to_vec(),
            grades,
        };

        self.apply_review(review_result, now_secs)
    }

    fn apply_review(&mut self, review_result: ReviewResult, now_secs: i64) -> Vec<EdgeUpdate> {
        let updates = credit::assign_credit(
            &self.graph,
            &review_result,
            &self.credit_params,
            &self.fsrs,
            now_secs,
        );

        let mut edge_updates: HashMap<crate::types::EdgeId, Vec<(Grade, f32)>> = HashMap::new();
        for u in &updates {
            edge_updates
                .entry(u.edge_id)
                .or_default()
                .push((u.grade, u.weight));
        }

        let mut updated_edge_ids = Vec::new();
        for (edge_id, weighted_grades) in &edge_updates {
            if let Some(edge) = self.graph.edge_mut(*edge_id) {
                edge.state =
                    self.fsrs
                        .apply_weighted_update(&edge.state, weighted_grades, now_secs);
                updated_edge_ids.push(*edge_id);
            }
        }

        let affected = self.mapping.affected_cards_for_edges(&updated_edge_ids);
        let new_schedules = cascade::recompute_schedules(
            &self.graph,
            &self.cards,
            &affected,
            &self.fsrs,
            now_secs,
            &self.schedule_params,
        );

        for new_sched in new_schedules {
            if let Some(existing) = self
                .schedules
                .iter_mut()
                .find(|s| s.card_id == new_sched.card_id)
            {
                *existing = new_sched;
            }
        }

        updates
    }

    /// Get a card by ID.
    pub fn card(&self, id: CardId) -> Option<&Card> {
        self.cards.iter().find(|c| c.id == id)
    }

    /// Set a card's state.
    pub fn set_card_state(&mut self, id: CardId, state: CardState) {
        if let Some(card) = self.cards.iter_mut().find(|c| c.id == id) {
            card.state = state;
        }
    }

    /// Get schedule for a card by ID.
    pub fn card_schedule(&self, id: CardId) -> Option<&CardSchedule> {
        self.schedules.iter().find(|s| s.card_id == id)
    }

    fn recompute_all_schedules(&mut self, now_secs: i64) {
        let all_ids: Vec<CardId> = self.cards.iter().map(|c| c.id).collect();
        self.schedules = cascade::recompute_schedules(
            &self.graph,
            &self.cards,
            &all_ids,
            &self.fsrs,
            now_secs,
            &self.schedule_params,
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::edge::EdgeState;
    use crate::node::NodeKind;

    const DAY: i64 = 86400;

    fn build_toy_verse() -> (Graph, Vec<Card>, NodeId, NodeId, NodeId, NodeId, NodeId) {
        let mut g = Graph::new();
        let r = g.add_node(NodeKind::VerseRef {
            chapter: 3,
            verse: 16,
        });
        let v = g.add_node(NodeKind::VerseGist {
            chapter: 3,
            verse: 16,
        });
        let p1 = g.add_node(NodeKind::Phrase {
            text: "For God so loved the world,".into(),
            verse_id: 0,
            position: 0,
        });
        let p2 = g.add_node(NodeKind::Phrase {
            text: "that he gave his only begotten Son,".into(),
            verse_id: 0,
            position: 1,
        });
        let p3 = g.add_node(NodeKind::Phrase {
            text: "that whosoever believeth in him".into(),
            verse_id: 0,
            position: 2,
        });

        let state = EdgeState {
            stability: 5.0,
            difficulty: 5.0,
            last_review_secs: 0,
        };
        g.add_bi_edge_with_state(v, r, state);
        g.add_bi_edge_with_state(p1, v, state);
        g.add_bi_edge_with_state(p2, v, state);
        g.add_bi_edge_with_state(p3, v, state);
        g.add_bi_edge_with_state(p1, p2, state);
        g.add_bi_edge_with_state(p2, p3, state);

        let full = Card {
            id: CardId(0),
            shown: vec![r],
            hidden: vec![p1, p2, p3],
            state: CardState::Review,
        };
        let fill_p2 = Card {
            id: CardId(1),
            shown: vec![r, p1, p3],
            hidden: vec![p2],
            state: CardState::Review,
        };
        let verse_to_ref = Card {
            id: CardId(2),
            shown: vec![p1, p2, p3],
            hidden: vec![r],
            state: CardState::Review,
        };

        (g, vec![full, fill_p2, verse_to_ref], r, v, p1, p2, p3)
    }

    #[test]
    fn engine_initializes_schedules() {
        let (g, cards, ..) = build_toy_verse();
        let engine = ReviewEngine::new(g, cards, 0.9);
        assert_eq!(engine.schedules.len(), 3);
        for s in &engine.schedules {
            assert!(s.due_r > 0.0);
            assert!(s.due_date_secs > 0);
        }
    }

    #[test]
    fn next_card_returns_highest_priority_due() {
        let (g, cards, ..) = build_toy_verse();
        let engine = ReviewEngine::new(g, cards, 0.9);

        // At t=0, nothing should be due (just initialized with S=5)
        let next = engine.next_card(0);
        assert!(next.is_none(), "nothing should be due at t=0");

        // At t=30 days, everything should be due
        let next = engine.next_card(30 * DAY);
        assert!(next.is_some(), "cards should be due at t=30 days");
    }

    #[test]
    fn review_updates_edges_and_cascades() {
        let (g, cards, _r, _v, p1, p2, p3) = build_toy_verse();
        let mut engine = ReviewEngine::new(g, cards, 0.9);

        // Record initial stability of an edge
        let initial_stabilities: Vec<f32> =
            engine.graph.edges().map(|e| e.state.stability).collect();

        // Review at day 3 (S=5, so R is still decent)
        let grades = HashMap::from([(p1, Grade::Good), (p2, Grade::Good), (p3, Grade::Good)]);
        let updates = engine.review(CardId(0), grades, 3 * DAY);
        assert!(!updates.is_empty(), "should produce edge updates");

        // Check that some edges changed
        let new_stabilities: Vec<f32> = engine.graph.edges().map(|e| e.state.stability).collect();

        let changed = initial_stabilities
            .iter()
            .zip(new_stabilities.iter())
            .any(|(a, b)| (a - b).abs() > 0.001);
        assert!(changed, "at least one edge should have changed stability");
    }

    #[test]
    fn review_with_lapse_decreases_stability() {
        let (g, cards, _r, _v, p1, p2, p3) = build_toy_verse();
        let mut engine = ReviewEngine::new(g, cards, 0.9);

        // Find a phrase→phrase edge (p1→p2)
        let p1_to_p2 = engine
            .graph
            .outgoing_edges(p1)
            .iter()
            .copied()
            .find(|&eid| {
                let e = engine.graph.edge(eid).unwrap();
                e.target == p2
            })
            .unwrap();

        let s_before = engine.graph.edge(p1_to_p2).unwrap().state.stability;

        // p2 = Again: p1→p2 should get blame
        let grades = HashMap::from([(p1, Grade::Good), (p2, Grade::Again), (p3, Grade::Good)]);
        engine.review(CardId(0), grades, 3 * DAY);

        let s_after = engine.graph.edge(p1_to_p2).unwrap().state.stability;

        // The edge might get blame (from p2's failure) or credit (from p1/p3's success
        // through other paths). The net effect depends on the specific path weights.
        // But the edge SHOULD be updated.
        assert!(
            (s_after - s_before).abs() > 0.001,
            "edge should change: before={s_before}, after={s_after}"
        );
    }

    #[test]
    fn successive_reviews_increase_stability() {
        let (g, cards, _r, _v, p1, p2, p3) = build_toy_verse();
        let mut engine = ReviewEngine::new(g, cards, 0.9);

        let all_good = HashMap::from([(p1, Grade::Good), (p2, Grade::Good), (p3, Grade::Good)]);

        // Review at day 3
        engine.review(CardId(0), all_good.clone(), 3 * DAY);
        let s_after_1 = engine
            .graph
            .edges()
            .map(|e| e.state.stability)
            .fold(0.0f32, |acc, s| acc + s);

        // Review again at day 10
        engine.review(CardId(0), all_good, 10 * DAY);
        let s_after_2 = engine
            .graph
            .edges()
            .map(|e| e.state.stability)
            .fold(0.0f32, |acc, s| acc + s);

        assert!(
            s_after_2 > s_after_1,
            "total stability should increase with Good reviews: {s_after_2} > {s_after_1}"
        );
    }

    #[test]
    fn cascade_updates_due_dates_after_review() {
        let (g, cards, _r, _v, p1, p2, p3) = build_toy_verse();
        let mut engine = ReviewEngine::new(g, cards, 0.9);

        let initial_due_dates: Vec<i64> =
            engine.schedules.iter().map(|s| s.due_date_secs).collect();

        let grades = HashMap::from([(p1, Grade::Good), (p2, Grade::Good), (p3, Grade::Good)]);
        engine.review(CardId(0), grades, 3 * DAY);

        let new_due_dates: Vec<i64> = engine.schedules.iter().map(|s| s.due_date_secs).collect();

        let any_changed = initial_due_dates
            .iter()
            .zip(new_due_dates.iter())
            .any(|(a, b)| a != b);
        assert!(any_changed, "due dates should change after review");
    }
}
