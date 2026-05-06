//! Integration test against the bundled `data/corinthians.json` fixture.
//! Exercises the full builder → engine → scheduler → review pipeline.

use std::collections::HashMap;
use verse_vault_core::builder::build;
use verse_vault_core::content::MaterialData;
use verse_vault_core::engine::ReviewEngine;
use verse_vault_core::schedule::next_card;
use verse_vault_core::types::{CardId, Grade};

const FIXTURE_PATH: &str = "../../data/corinthians.json";

fn load_material() -> MaterialData {
    let json = std::fs::read_to_string(FIXTURE_PATH).expect("corinthians fixture should exist");
    serde_json::from_str(&json).expect("fixture parses as MaterialData")
}

#[test]
fn real_data_loads_and_runs_session() {
    let material = load_material();
    let now = 86400 * 365;
    let result = build(&material, now);
    assert!(!result.cards.is_empty(), "expected non-empty card set");
    let engine = ReviewEngine::new(result, 0.9);
    let pick = next_card(&engine, now + 86400 * 400);
    assert!(pick.is_some(), "scheduler should find a due card");
}

#[test]
fn real_data_review_first_due_card() {
    let material = load_material();
    let now = 86400 * 365;
    let result = build(&material, now);
    let mut engine = ReviewEngine::new(result, 0.9);
    let later = now + 86400 * 400;
    let card_id = next_card(&engine, later).expect("expected a due card to review");
    let card = engine.card(card_id).cloned().expect("card lookup");
    let atoms = engine.atoms_for(card.verse_id);
    let grades: HashMap<_, _> = card
        .tests(&atoms)
        .into_iter()
        .map(|t| (t, Grade::Good))
        .collect();
    assert!(!grades.is_empty(), "card should grade at least one test");
    let outcome = engine.review(CardId(card_id.0), grades, later);
    assert!(!outcome.updates.is_empty(), "review should produce updates");
}
