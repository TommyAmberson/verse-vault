mod learner;
mod metrics;

use std::collections::HashMap;
use std::fs;

use rand::SeedableRng;
use rand::rngs::StdRng;

use verse_vault_core::builder;
use verse_vault_core::card::Card;
use verse_vault_core::card_types::CardTypesConfig;
use verse_vault_core::content::MaterialData;
use verse_vault_core::engine::ReviewEngine;
use verse_vault_core::session::{NewVerseInfo, Session, SessionCardSource, SessionParams};
use verse_vault_core::types::{CardId, NodeId};

use crate::learner::SimulatedLearner;
use crate::metrics::{Prediction, auc, log_loss, rmse_binned};

const DAY: i64 = 86400;

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let data_path = args
        .get(1)
        .map(|s| s.as_str())
        .unwrap_or("data/corinthians.json");
    let chapter_filter: Option<u16> = args.get(2).and_then(|s| s.parse().ok());
    let days: i64 = args.get(3).and_then(|s| s.parse().ok()).unwrap_or(60);

    println!("=== Verse-Vault Simulation ===\n");

    if let Err(e) = run(data_path, chapter_filter, days) {
        eprintln!("Error: {e}");
        eprintln!("Usage: verse-vault-sim [data.json] [chapter] [days]");
        eprintln!("  e.g.: verse-vault-sim data/corinthians.json 13 60");
        std::process::exit(1);
    }
}

fn run(data_path: &str, chapter_filter: Option<u16>, days: i64) -> Result<(), String> {
    // Load data
    let json_str =
        fs::read_to_string(data_path).map_err(|e| format!("Can't read {data_path}: {e}"))?;
    let mut data: MaterialData =
        MaterialData::from_json(&json_str).map_err(|e| format!("Bad JSON: {e}"))?;

    if let Some(ch) = chapter_filter {
        data.verses.retain(|v| v.chapter == ch);
        data.chapters.retain(|c| c.number == ch);
        data.headings
            .retain(|h| h.start_chapter <= ch && h.end_chapter >= ch);
    }

    let verse_count = data.verses_with_text().count();
    if verse_count == 0 {
        return Err("No verses with text found".into());
    }

    println!(
        "Material: {} verses{}",
        verse_count,
        chapter_filter
            .map(|ch| format!(" (chapter {ch})"))
            .unwrap_or_default()
    );

    // Build graph
    let card_types = CardTypesConfig::from_toml(include_str!("../../core/card_types.toml"))
        .map_err(|e| format!("Bad TOML: {e}"))?;

    let result = builder::build(&data, &card_types, 0);
    println!(
        "Graph: {} nodes, {} edges, {} cards\n",
        result.graph.node_count(),
        result.graph.edge_count(),
        result.cards.len()
    );

    let new_verse_infos: Vec<NewVerseInfo> = result
        .verse_atoms
        .iter()
        .map(|va| NewVerseInfo {
            verse_ref: va.ref_node,
            verse_phrases: va.phrases.clone(),
        })
        .collect();

    let mut engine = ReviewEngine::new(result.graph, result.cards, 0.9);

    // Simulated learner
    let rng = StdRng::seed_from_u64(42);
    let mut learner = SimulatedLearner::new(rng, 0.9);
    let all_atoms: Vec<NodeId> = new_verse_infos
        .iter()
        .flat_map(|nv| nv.verse_phrases.iter().copied())
        .collect();
    learner.initialize_atoms(&all_atoms, 3.0, -365 * DAY);

    // Run simulation
    let mut total_reviews = 0u32;
    let mut total_passes = 0u32;
    let mut total_fails = 0u32;
    let mut verses_introduced = 0usize;
    let mut predictions: Vec<Prediction> = Vec::new();
    let mut active_days = 0u32;

    let session_params = SessionParams {
        max_session_size: 30,
        max_new_verses: 3,
        fail_ratio_for_full_recitation: 0.5,
    };

    println!("Day  Reviews  Pass  Fail  Verses  Notes");
    println!("{}", "-".repeat(55));

    for day in 0..days {
        let now = day * DAY;

        let new_verses: Vec<NewVerseInfo> = new_verse_infos
            .iter()
            .skip(verses_introduced)
            .take(session_params.max_new_verses)
            .map(|nv| NewVerseInfo {
                verse_ref: nv.verse_ref,
                verse_phrases: nv.verse_phrases.clone(),
            })
            .collect();

        let new_count = new_verses.len();
        let mut session = Session::new(&mut engine, now, session_params.clone(), &new_verses);

        if session.is_done() && new_count == 0 {
            continue;
        }

        let mut day_reviews = 0u32;
        let mut day_passes = 0u32;
        let mut day_fails = 0u32;
        let mut day_redrills = 0u32;

        while let Some(card) = session.next() {
            if card.is_reading {
                session.record_review(HashMap::new(), &mut engine, now);
                day_reviews += 1;
                continue;
            }

            let (shown, hidden) = match &card.source {
                SessionCardSource::Scheduled(card_id) => {
                    let c = engine.card(*card_id).unwrap();
                    (c.shown.clone(), c.hidden.clone())
                }
                _ => (card.shown.clone(), card.hidden.clone()),
            };

            if hidden.is_empty() {
                session.record_review(HashMap::new(), &mut engine, now);
                day_reviews += 1;
                continue;
            }

            let temp_card = Card {
                id: CardId(9999),
                shown,
                hidden,
                state: verse_vault_core::card::CardState::Review,
            };
            let grades = learner.review(&engine.graph, &temp_card, now);
            let all_passed = grades.values().all(|g| g.is_pass());

            if let SessionCardSource::Scheduled(id) = &card.source
                && let Some(sched) = engine.card_schedule(*id)
            {
                predictions.push(Prediction {
                    predicted_r: sched.due_r.clamp(0.01, 0.99),
                    actual_pass: all_passed,
                });
            }

            let outcome = session.record_review(grades.clone(), &mut engine, now);
            learner.update_true_state(&grades, now);

            day_reviews += 1;
            if all_passed {
                day_passes += 1;
            } else {
                day_fails += 1;
            }
            day_redrills += outcome.redrills_inserted as u32;

            if day_reviews > 50 {
                break;
            }
        }

        verses_introduced += new_count;
        total_reviews += day_reviews;
        total_passes += day_passes;
        total_fails += day_fails;
        active_days += 1;

        let notes = if new_count > 0 {
            format!("+{new_count} new")
        } else {
            String::new()
        };
        let drill_note = if day_redrills > 0 {
            format!(" +{day_redrills}drill")
        } else {
            String::new()
        };

        println!(
            "{:3}  {:7}  {:4}  {:4}  {:6}  {notes}{drill_note}",
            day, day_reviews, day_passes, day_fails, verses_introduced,
        );
    }

    // Summary
    println!("\n{}", "=".repeat(55));
    println!("SUMMARY");
    println!("{}", "=".repeat(55));
    println!("  Days simulated:    {days}");
    println!("  Active days:       {active_days}");
    println!("  Verses introduced: {verses_introduced}/{verse_count}");
    println!("  Total reviews:     {total_reviews}");
    println!(
        "  Pass rate:         {:.1}%",
        if total_passes + total_fails > 0 {
            total_passes as f64 / (total_passes + total_fails) as f64 * 100.0
        } else {
            0.0
        }
    );
    println!(
        "  Avg reviews/day:   {:.1}",
        if active_days > 0 {
            total_reviews as f64 / active_days as f64
        } else {
            0.0
        }
    );

    if !predictions.is_empty() {
        println!("\nPREDICTION QUALITY");
        println!("  Log loss:  {:.4}", log_loss(&predictions));
        println!("  AUC:       {:.4}", auc(&predictions));
        println!("  RMSE:      {:.4}", rmse_binned(&predictions));
        println!("  ({} predictions)", predictions.len());
    }

    let mut stabilities: Vec<f32> = engine
        .graph
        .edges()
        .filter_map(|e| e.state.map(|s| s.stability))
        .filter(|&s| s > 0.01)
        .collect();
    stabilities.sort_by(|a, b| a.partial_cmp(b).unwrap());

    if !stabilities.is_empty() {
        let n = stabilities.len();
        println!("\nEDGE STABILITY");
        println!(
            "  min={:.1}  p25={:.1}  median={:.1}  p75={:.1}  max={:.1}",
            stabilities[0],
            stabilities[n / 4],
            stabilities[n / 2],
            stabilities[n * 3 / 4],
            stabilities[n - 1],
        );
        println!("  {} learnable edges", n);
    }

    Ok(())
}
