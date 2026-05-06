//! Smoke tests for the WASM boundary. The `verse-vault-wasm` crate is built
//! as both `cdylib` and `rlib`, so we can drive its public API from a plain
//! Rust integration test without spinning up `wasm-pack`.

use verse_vault_wasm::WasmEngine;

const MATERIAL_JSON: &str = r#"{
    "year": 3,
    "books": ["John"],
    "chapters": [{"book": "John", "number": 3, "start_verse": 16, "end_verse": 16}],
    "verses": [
        {
            "book": "John", "chapter": 3, "verse": 16,
            "text": "For God so loved the world that he gave",
            "phrases": ["For God", "so loved", "the world", "that he gave"],
            "ftv": "For God",
            "clubs": []
        }
    ],
    "headings": []
}"#;

#[test]
fn constructor_loads_material_without_panic() {
    let _engine =
        WasmEngine::new(MATERIAL_JSON, "", 0.9, 86400 * 365).expect("constructor should succeed");
}

#[test]
fn constructor_accepts_empty_persisted_states() {
    let _engine = WasmEngine::new(MATERIAL_JSON, "[]", 0.9, 86400 * 365).unwrap();
}

/// Look up the first card for verse 0 and build a Good-on-everything grades
/// JSON for it. We rebuild the material on the side because the engine
/// doesn't expose its card list at the wire level.
fn first_card_with_grades(now_secs: i64) -> (u32, String) {
    let material: verse_vault_core::content::MaterialData =
        serde_json::from_str(MATERIAL_JSON).unwrap();
    let build = verse_vault_core::builder::build(&material, now_secs);
    let card = build.cards.first().expect("at least one card");
    let atoms = build.verse_atoms_data.get(&card.verse_id).unwrap();
    let entries: Vec<serde_json::Value> = card
        .tests(atoms)
        .into_iter()
        .map(|t| serde_json::json!({"key": t, "grade": "Good"}))
        .collect();
    (card.id.0, serde_json::to_string(&entries).unwrap())
}

#[test]
fn replay_event_returns_at_least_one_direct_update() {
    let now = 86400 * 365;
    let mut engine = WasmEngine::new(MATERIAL_JSON, "", 0.9, now).unwrap();
    let (card_id, grades_json) = first_card_with_grades(now);
    let resp = engine
        .replay_event(card_id, &grades_json, now + 86400 * 30)
        .unwrap();
    let updates: Vec<serde_json::Value> = serde_json::from_str(&resp).unwrap();
    assert!(!updates.is_empty(), "review should produce updates");
    let direct = updates.iter().filter(|u| u["kind"] == "Direct").count();
    assert!(direct >= 1, "expected at least one Direct update");
}
