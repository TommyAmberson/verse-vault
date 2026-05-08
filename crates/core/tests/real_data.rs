//! Integration test against the bundled `data/corinthians.json` fixture.
//! Exercises the full builder → engine → scheduler → review pipeline.
//!
//! `data/` is gitignored — CI environments and fresh clones don't have the
//! fixture. When it's absent the test prints a skip notice and returns
//! ok rather than panicking, so CI on master stays green for everyone but
//! the test still runs locally (and in CI runs that explicitly hydrate
//! the data dir) when the file is present.

use verse_vault_core::builder::build;
use verse_vault_core::content::MaterialData;
use verse_vault_core::engine::ReviewEngine;
use verse_vault_core::schedule::next_card;
use verse_vault_core::types::Grade;

const FIXTURE_PATH: &str = "../../data/corinthians.json";

fn try_load_material() -> Option<MaterialData> {
    let json = std::fs::read_to_string(FIXTURE_PATH).ok()?;
    Some(serde_json::from_str(&json).expect("fixture parses as MaterialData"))
}

#[test]
fn real_data_loads_and_runs_session() {
    let Some(material) = try_load_material() else {
        eprintln!("skipping: {FIXTURE_PATH} not present (data/ is gitignored)");
        return;
    };
    let now = 86400 * 365;
    let result = build(&material, now);
    assert!(!result.cards.is_empty(), "expected non-empty card set");
    let engine = ReviewEngine::new(result, 0.9);
    let pick = next_card(&engine, now + 86400 * 400);
    assert!(pick.is_some(), "scheduler should find a due card");
}

#[test]
fn real_data_review_first_due_card() {
    let Some(material) = try_load_material() else {
        eprintln!("skipping: {FIXTURE_PATH} not present (data/ is gitignored)");
        return;
    };
    let now = 86400 * 365;
    let result = build(&material, now);
    let mut engine = ReviewEngine::new(result, 0.9);
    let later = now + 86400 * 400;
    let card_id = next_card(&engine, later).expect("expected a due card to review");
    let outcome = engine.review(card_id, Grade::Good, later);
    assert!(!outcome.updates.is_empty(), "review should produce updates");
}
