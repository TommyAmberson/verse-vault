mod learner;
mod metrics;

use rand::SeedableRng;
use rand::rngs::StdRng;

use verse_vault_core::card::Card;
use verse_vault_core::edge::{EdgeKind, EdgeState};
use verse_vault_core::engine::ReviewEngine;
use verse_vault_core::graph::Graph;
use verse_vault_core::node::NodeKind;
use verse_vault_core::session::{NewVerseInfo, Session, SessionCardSource, SessionParams};
use verse_vault_core::types::{CardId, NodeId};

use crate::learner::SimulatedLearner;
use crate::metrics::{Prediction, auc, log_loss, rmse_binned};

const DAY: i64 = 86400;

fn main() {
    println!("=== Verse-Vault Simulation ===\n");
    run_single_verse_scenario();
}

fn run_single_verse_scenario() {
    println!("--- Single Verse Scenario (with Session) ---");
    println!("1 verse, 3 phrases, 90 days, progressive reveal + re-drills\n");

    let (graph, cards, hidden_atoms, verse_ref, verse_phrases) = build_single_verse();
    let mut engine = ReviewEngine::new(graph, cards, 0.9);

    let seed = 42u64;
    let rng = StdRng::seed_from_u64(seed);
    let mut learner = SimulatedLearner::new(rng, 0.9);
    learner.initialize_atoms(&hidden_atoms, 3.0);

    let mut total_reviews = 0u32;
    let mut predictions: Vec<Prediction> = Vec::new();

    for day in 0..90 {
        let now = day as i64 * DAY;

        // Build a session for this day
        let new_verses = if day == 0 {
            vec![NewVerseInfo {
                verse_ref,
                verse_phrases: verse_phrases.clone(),
            }]
        } else {
            vec![]
        };

        let mut session = Session::new(&engine, now, SessionParams::default(), &new_verses);

        if session.is_done() {
            continue;
        }

        let mut day_reviews = 0u32;

        while let Some(card) = session.next() {
            if card.is_reading {
                // Reading stage: no grading, just advance
                session.record_review(std::collections::HashMap::new(), &mut engine, now);
                day_reviews += 1;
                continue;
            }

            // For scheduled cards, get the actual shown/hidden from engine
            let (shown, hidden) = match &card.source {
                SessionCardSource::Scheduled(card_id) => {
                    let c = engine.card(*card_id).unwrap();
                    (c.shown.clone(), c.hidden.clone())
                }
                _ => (card.shown.clone(), card.hidden.clone()),
            };

            if hidden.is_empty() {
                session.record_review(std::collections::HashMap::new(), &mut engine, now);
                day_reviews += 1;
                continue;
            }

            // Record prediction before review
            let card_id_for_sched = match &card.source {
                SessionCardSource::Scheduled(id) => {
                    engine.card_schedule(*id).map(|s| s.due_r.clamp(0.01, 0.99))
                }
                _ => None,
            };
            let predicted_r = card_id_for_sched.unwrap_or(0.5);

            // Learner reviews using a transient card
            let temp_card = Card {
                id: CardId(9999),
                shown: shown.clone(),
                hidden: hidden.clone(),
            };
            let grades = learner.review(&engine.graph, &temp_card, now);

            let all_passed = grades.values().all(|g| g.is_pass());
            predictions.push(Prediction {
                predicted_r,
                actual_pass: all_passed,
            });

            // Record to session (handles re-drills, progressive reveal)
            let outcome = session.record_review(grades.clone(), &mut engine, now);

            learner.update_true_state(&grades);
            day_reviews += 1;

            let pass_count = grades.values().filter(|g| g.is_pass()).count();
            let total = grades.len();
            let card_type = match &card.source {
                SessionCardSource::Scheduled(_) => "sched",
                SessionCardSource::ReDrill => "drill",
                SessionCardSource::NewVerse => "new  ",
            };
            println!(
                "  Day {day:3} [{card_type}]: {pass_count}/{total} passed{}",
                if outcome.redrills_inserted > 0 {
                    format!(" (+{} re-drills)", outcome.redrills_inserted)
                } else {
                    String::new()
                }
            );

            if day_reviews > 20 {
                break; // safety cap
            }
        }

        total_reviews += day_reviews;
    }

    println!("\n--- Results ---");
    println!("Total reviews: {total_reviews}");
    println!("Predictions recorded: {}", predictions.len());

    if !predictions.is_empty() {
        println!("Log loss:  {:.4}", log_loss(&predictions));
        println!("AUC:       {:.4}", auc(&predictions));
        println!("RMSE:      {:.4}", rmse_binned(&predictions));
    }

    println!("\nFinal edge stabilities:");
    for edge in engine.graph.edges() {
        if let Some(state) = &edge.state
            && state.stability > 0.01 {
                let kind = format!("{:?}", edge.kind);
                println!(
                    "  {}: S={:.2}, D={:.2}",
                    kind, state.stability, state.difficulty
                );
            }
    }
}

fn build_single_verse() -> (Graph, Vec<Card>, Vec<NodeId>, NodeId, Vec<NodeId>) {
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

    let hidden_atoms = vec![p1, p2, p3, r];
    let verse_phrases = vec![p1, p2, p3];

    (g, vec![full], hidden_atoms, r, verse_phrases)
}
