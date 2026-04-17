mod learner;
mod metrics;


use rand::SeedableRng;
use rand::rngs::StdRng;

use verse_vault_core::card::Card;
use verse_vault_core::edge::{EdgeKind, EdgeState};
use verse_vault_core::engine::ReviewEngine;
use verse_vault_core::graph::Graph;
use verse_vault_core::node::NodeKind;
use verse_vault_core::types::{CardId, NodeId};

use crate::learner::SimulatedLearner;
use crate::metrics::{Prediction, auc, log_loss, rmse_binned};

const DAY: i64 = 86400;

fn main() {
    println!("=== Verse-Vault Simulation ===\n");
    run_single_verse_scenario();
}

fn run_single_verse_scenario() {
    println!("--- Single Verse Scenario ---");
    println!("1 verse, 3 phrases, 30 review sessions over 90 days\n");

    let (graph, cards, hidden_atoms) = build_single_verse();
    let mut engine = ReviewEngine::new(graph, cards, 0.9);

    let seed = 42u64;
    let rng = StdRng::seed_from_u64(seed);
    let mut learner = SimulatedLearner::new(rng, 0.9);
    learner.initialize_atoms(&hidden_atoms, 3.0);

    let mut review_count = 0;

    for day in 0..90 {
        let now = day as i64 * DAY;

        // Check if any card is due
        let due_card_id = engine.next_card(now).map(|s| s.card_id);
        let card_id = match due_card_id {
            Some(id) => id,
            None => {
                if day == 0 {
                    CardId(0) // first review: introduce verse
                } else {
                    continue;
                }
            }
        };

        let card = engine.card(card_id).unwrap().clone();

        // Learner reviews
        let grades = learner.review(&engine.graph, &card, now);

        // Apply review to engine
        engine.review(card_id, grades.clone(), now);

        // Update learner's true state
        learner.update_true_state(&grades);

        review_count += 1;

        let pass_count = grades.values().filter(|g| g.is_pass()).count();
        let total = grades.len();
        println!(
            "  Day {day:3}: card {}, {pass_count}/{total} passed",
            card_id.0
        );

        // Accumulate predictions for metrics
        // (using preds_this_review but the due_r is card-level, not per-atom ideal)
    }

    println!("\n--- Results ---");
    println!("Total reviews: {review_count}");

    // Build final prediction set from all reviews
    // For a proper evaluation we'd track per-atom predictions, but this gives
    // a rough metric using card-level due_r
    let all_preds: Vec<Prediction> = (0..review_count)
        .map(|i| {
            // Synthetic: use the engine's rough prediction quality
            Prediction {
                predicted_r: 0.85 + (i as f32 * 0.001), // placeholder
                actual_pass: true,
            }
        })
        .collect();

    if !all_preds.is_empty() {
        println!("(Metrics use placeholder predictions — proper per-atom tracking needed)");
        println!("Log loss:  {:.4}", log_loss(&all_preds));
        println!("AUC:       {:.4}", auc(&all_preds));
        println!("RMSE:      {:.4}", rmse_binned(&all_preds));
    }

    println!("\nFinal edge stabilities:");
    for edge in engine.graph.edges() {
        if let Some(state) = &edge.state
            && state.stability > 0.01 {
                let kind = format!("{:?}", edge.kind);
                println!("  {}: S={:.2}, D={:.2}", kind, state.stability, state.difficulty);
            }
    }
}

fn build_single_verse() -> (Graph, Vec<Card>, Vec<NodeId>) {
    let mut g = Graph::new();
    let r = g.add_node(NodeKind::Reference {
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
        stability: 1.0,
        difficulty: 5.0,
        last_review_secs: 0,
    };
    g.add_bi_edge_with_state(EdgeKind::VerseGistReference, v, r, state);
    g.add_bi_edge_with_state(EdgeKind::PhraseVerseGist, p1, v, state);
    g.add_bi_edge_with_state(EdgeKind::PhraseVerseGist, p2, v, state);
    g.add_bi_edge_with_state(EdgeKind::PhraseVerseGist, p3, v, state);
    g.add_bi_edge_with_state(EdgeKind::PhrasePhrase, p1, p2, state);
    g.add_bi_edge_with_state(EdgeKind::PhrasePhrase, p2, p3, state);

    let full = Card {
        id: CardId(0),
        shown: vec![r],
        hidden: vec![p1, p2, p3],
    };
    let fill_p2 = Card {
        id: CardId(1),
        shown: vec![r, p1, p3],
        hidden: vec![p2],
    };
    let verse_to_ref = Card {
        id: CardId(2),
        shown: vec![p1, p2, p3],
        hidden: vec![r],
    };

    let hidden_atoms = vec![p1, p2, p3, r];

    (g, vec![full, fill_p2, verse_to_ref], hidden_atoms)
}
