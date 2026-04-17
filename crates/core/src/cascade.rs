use std::collections::HashMap;

use crate::card::{Card, CardSchedule};
use crate::fsrs_bridge::FsrsBridge;
use crate::graph::Graph;
use crate::schedule::{self, ScheduleParams};
use crate::types::{CardId, EdgeId};

/// Maps each edge to the cards that depend on it.
/// When an edge is updated, all mapped cards need their schedule recomputed.
pub struct EdgeCardMapping {
    edge_to_cards: HashMap<EdgeId, Vec<CardId>>,
}

impl EdgeCardMapping {
    /// Build the mapping by scanning all cards and finding which edges are on
    /// paths from shown to hidden atoms.
    pub fn build(graph: &Graph, cards: &[Card], params: &ScheduleParams) -> Self {
        let mut edge_to_cards: HashMap<EdgeId, Vec<CardId>> = HashMap::new();

        for card in cards {
            let edges = collect_card_edges(graph, card, params);
            for edge_id in edges {
                edge_to_cards
                    .entry(edge_id)
                    .or_default()
                    .push(card.id);
            }
        }

        Self { edge_to_cards }
    }

    /// Get the card IDs affected by an edge update.
    pub fn affected_cards(&self, edge_id: EdgeId) -> &[CardId] {
        self.edge_to_cards
            .get(&edge_id)
            .map_or(&[], |v| v.as_slice())
    }

    /// Get all card IDs affected by any of the given edge updates.
    pub fn affected_cards_for_edges(&self, edge_ids: &[EdgeId]) -> Vec<CardId> {
        let mut seen = std::collections::HashSet::new();
        let mut result = Vec::new();
        for &eid in edge_ids {
            for &cid in self.affected_cards(eid) {
                if seen.insert(cid) {
                    result.push(cid);
                }
            }
        }
        result
    }
}

/// Recompute schedule for a set of affected cards.
pub fn recompute_schedules(
    graph: &Graph,
    cards: &[Card],
    affected_ids: &[CardId],
    fsrs: &FsrsBridge,
    now_secs: i64,
    params: &ScheduleParams,
) -> Vec<CardSchedule> {
    let card_map: HashMap<CardId, &Card> = cards.iter().map(|c| (c.id, c)).collect();

    affected_ids
        .iter()
        .filter_map(|&cid| {
            let card = card_map.get(&cid)?;
            let dr = schedule::due_r(graph, card, fsrs, now_secs, params);
            let dd = schedule::due_date(graph, card, fsrs, now_secs, params);
            let p = schedule::priority(graph, card, fsrs, now_secs, params);
            Some(CardSchedule {
                card_id: cid,
                due_r: dr,
                due_date_secs: dd,
                priority: p,
            })
        })
        .collect()
}

fn collect_card_edges(graph: &Graph, card: &Card, params: &ScheduleParams) -> Vec<EdgeId> {
    use std::collections::HashSet;

    let shown: HashSet<_> = card.shown.iter().copied().collect();
    let mut edges = HashSet::new();

    for &hidden in &card.hidden {
        let paths = schedule::all_paths_for_pub(graph, &shown, hidden, params);
        for ap in paths {
            for &eid in &ap.path.edges {
                edges.insert(eid);
            }
        }
    }

    // Also include shown↔shown edges (for reinforcement bonus)
    for &node in &card.shown {
        for &eid in graph.outgoing_edges(node) {
            if let Some(edge) = graph.edge(eid)
                && shown.contains(&edge.target) {
                    edges.insert(eid);
                }
        }
    }

    edges.into_iter().collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::edge::{EdgeKind, EdgeState};
    use crate::node::NodeKind;

    fn make_test_graph_and_cards() -> (Graph, Vec<Card>) {
        let mut g = Graph::new();
        let r = g.add_node(NodeKind::Reference {
            chapter: 1,
            verse: 1,
        });
        let v = g.add_node(NodeKind::VerseGist {
            chapter: 1,
            verse: 1,
        });
        let p1 = g.add_node(NodeKind::Phrase {
            text: "phrase one".into(),
            verse_id: 0,
            position: 0,
        });
        let p2 = g.add_node(NodeKind::Phrase {
            text: "phrase two".into(),
            verse_id: 0,
            position: 1,
        });

        let state = EdgeState {
            stability: 10.0,
            difficulty: 5.0,
            last_review_secs: 0,
        };
        g.add_bi_edge_with_state(EdgeKind::VerseGistReference, v, r, state);
        g.add_bi_edge_with_state(EdgeKind::PhraseVerseGist, p1, v, state);
        g.add_bi_edge_with_state(EdgeKind::PhraseVerseGist, p2, v, state);
        g.add_bi_edge_with_state(EdgeKind::PhrasePhrase, p1, p2, state);

        let full_recitation = Card {
            id: CardId(0),
            shown: vec![r],
            hidden: vec![p1, p2],
        };
        let fill_in_p1 = Card {
            id: CardId(1),
            shown: vec![r, p2],
            hidden: vec![p1],
        };
        let verse_to_ref = Card {
            id: CardId(2),
            shown: vec![p1, p2],
            hidden: vec![r],
        };

        (g, vec![full_recitation, fill_in_p1, verse_to_ref])
    }

    #[test]
    fn mapping_finds_affected_cards() {
        let (g, cards) = make_test_graph_and_cards();
        let params = ScheduleParams::default();
        let mapping = EdgeCardMapping::build(&g, &cards, &params);

        // The verse→p1 edge should affect at least the full recitation card
        let v_to_p1_edges: Vec<_> = g
            .edge_ids()
            .filter(|&eid| {
                let e = g.edge(eid).unwrap();
                matches!(e.kind, EdgeKind::PhraseVerseGist)
            })
            .collect();

        assert!(!v_to_p1_edges.is_empty());
        let affected = mapping.affected_cards(v_to_p1_edges[0]);
        assert!(!affected.is_empty(), "edge should affect at least one card");
    }

    #[test]
    fn recompute_produces_schedules() {
        let (g, cards) = make_test_graph_and_cards();
        let params = ScheduleParams::default();
        let fsrs = FsrsBridge::new(0.9);

        let all_ids: Vec<CardId> = cards.iter().map(|c| c.id).collect();
        let schedules = recompute_schedules(&g, &cards, &all_ids, &fsrs, 0, &params);

        assert_eq!(schedules.len(), 3);
        for s in &schedules {
            assert!(s.due_r > 0.0, "due_r should be positive");
            assert!(s.due_date_secs >= 0, "due_date should be valid");
        }
    }

    #[test]
    fn affected_cards_for_multiple_edges() {
        let (g, cards) = make_test_graph_and_cards();
        let params = ScheduleParams::default();
        let mapping = EdgeCardMapping::build(&g, &cards, &params);

        let edge_ids: Vec<EdgeId> = g.edge_ids().take(3).collect();
        let affected = mapping.affected_cards_for_edges(&edge_ids);
        // Should deduplicate
        let unique_count = affected.len();
        let mut deduped = affected.clone();
        deduped.sort_by_key(|c| c.0);
        deduped.dedup();
        assert_eq!(unique_count, deduped.len(), "should be deduplicated");
    }
}
