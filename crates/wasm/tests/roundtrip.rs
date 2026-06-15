//! Smoke tests for the WASM boundary. The `verse-vault-wasm` crate is built
//! as both `cdylib` and `rlib`, so we can drive its public API from a plain
//! Rust integration test without spinning up `wasm-pack`.

use verse_vault_core::card::CardKind;
use verse_vault_wasm::{TestStateEntry, WasmEngine};

// John 3:16 (partial) — 9 words split into 4 phrases of 2/2/2/3.
// FTV "For God" = 2 words = phrase 0.
const MATERIAL_JSON: &str = r#"{
    "year": 3,
    "books": ["John"],
    "chapters": [{"book": "John", "number": 3, "start_verse": 16, "end_verse": 16}],
    "verses": [
        {
            "book": "John", "chapter": 3, "verse": 16,
            "phraseWordCounts": [2, 2, 2, 3],
            "annotations": [],
            "ftvWordCount": 2,
            "clubs": []
        }
    ],
    "headings": []
}"#;

const GRADE_GOOD: u8 = 3;

#[test]
fn constructor_loads_material_without_panic() {
    let _engine = WasmEngine::new(MATERIAL_JSON, "", "", 0.9, 86400 * 365)
        .expect("constructor should succeed");
}

#[test]
fn constructor_accepts_empty_persisted_states() {
    let _engine = WasmEngine::new(MATERIAL_JSON, "", "[]", 0.9, 86400 * 365).unwrap();
}

/// Look up the first card for verse 0 from the material.
fn first_card_id() -> u32 {
    let material: verse_vault_core::content::MaterialData =
        serde_json::from_str(MATERIAL_JSON).unwrap();
    let build = verse_vault_core::builder::build(&material, 0);
    build.cards.first().expect("at least one card").id.0
}

/// Look up the first card whose kind matches the predicate.
fn first_card_id_where<F: Fn(&CardKind) -> bool>(pred: F) -> u32 {
    let material: verse_vault_core::content::MaterialData =
        serde_json::from_str(MATERIAL_JSON).unwrap();
    let build = verse_vault_core::builder::build(&material, 0);
    build
        .cards
        .iter()
        .find(|c| pred(&c.kind))
        .expect("expected a matching card")
        .id
        .0
}

#[test]
fn replay_event_returns_root_update_for_atomic_card() {
    let now = 86400 * 365;
    let mut engine = WasmEngine::new(MATERIAL_JSON, "", "", 0.9, now).unwrap();
    let card_id = first_card_id_where(|k| matches!(k, CardKind::PhraseFill { .. }));
    let resp = engine
        .replay_event(card_id, GRADE_GOOD, now + 86400 * 30)
        .unwrap();
    let updates: Vec<serde_json::Value> = serde_json::from_str(&resp).unwrap();
    assert_eq!(updates.len(), 1, "atomic card should produce one update");
    assert_eq!(updates[0]["kind"], "Root");
}

#[test]
fn replay_event_returns_sub_updates_for_composite_card() {
    let now = 86400 * 365;
    let mut engine = WasmEngine::new(MATERIAL_JSON, "", "", 0.9, now).unwrap();
    let card_id = first_card_id_where(|k| matches!(k, CardKind::Recitation));
    let resp = engine
        .replay_event(card_id, GRADE_GOOD, now + 86400 * 30)
        .unwrap();
    let updates: Vec<serde_json::Value> = serde_json::from_str(&resp).unwrap();
    assert!(
        updates.len() > 1,
        "composite card should produce multiple updates"
    );
    assert!(
        updates.iter().all(|u| u["kind"] == "Sub"),
        "all composite-card updates must be Sub"
    );
}

#[test]
fn export_test_states_after_review_round_trips() {
    let now = 86400 * 365;
    let mut engine = WasmEngine::new(MATERIAL_JSON, "", "", 0.9, now).unwrap();
    let card_id = first_card_id();
    let _ = engine
        .replay_event(card_id, GRADE_GOOD, now + 86400 * 30)
        .unwrap();
    let exported = engine.export_test_states().unwrap();
    let entries: Vec<TestStateEntry> = serde_json::from_str(&exported).unwrap();
    assert!(!entries.is_empty(), "export should be non-empty");
}

// `JsError::new` calls a wasm-bindgen import that panics on native targets,
// so we exercise the validation logic via the testable `replay_event_for_test`
// hook.

#[test]
fn replay_event_unknown_card_id_returns_error() {
    let now = 86400 * 365;
    let mut engine = WasmEngine::new(MATERIAL_JSON, "", "", 0.9, now).unwrap();
    let bogus_id: u32 = 999_999;
    let result = engine.replay_event_for_test(bogus_id, GRADE_GOOD, now);
    let err = result.expect_err("unknown card id should yield Err, not panic");
    assert!(err.contains("unknown card id"), "got: {err}");
}

#[test]
fn replay_event_invalid_grade_returns_error() {
    let now = 86400 * 365;
    let mut engine = WasmEngine::new(MATERIAL_JSON, "", "", 0.9, now).unwrap();
    let card_id = first_card_id();
    let result = engine.replay_event_for_test(card_id, 0, now);
    let err = result.expect_err("invalid grade should yield Err, not panic");
    assert!(err.contains("invalid grade"), "got: {err}");
    let result = engine.replay_event_for_test(card_id, 5, now);
    let err = result.expect_err("invalid grade should yield Err, not panic");
    assert!(err.contains("invalid grade"), "got: {err}");
}

#[test]
fn next_card_returns_some_when_due_after_graduation() {
    // Build at t=0; every test seeds with last_base = -365 days. By the time
    // we ask at +60 days past t=365d, retrievability is well below 0.9. The
    // verse has to be graduated (memorize → Active) before `next_card` will
    // surface its cards — without graduation, /review is empty.
    let mut engine = WasmEngine::new(MATERIAL_JSON, "", "", 0.9, 0).unwrap();
    engine.graduate_verse(0);
    let pick = engine.next_review_card(86400 * 365 + 86400 * 60);
    assert!(pick.is_some(), "expected a due card");
}

#[test]
fn next_card_empty_until_verse_graduates() {
    // Brand-new engine: every card is `New`. /review must be empty.
    let engine = WasmEngine::new(MATERIAL_JSON, "", "", 0.9, 0).unwrap();
    assert!(engine.next_review_card(86400 * 365 + 86400 * 60).is_none());
}

#[test]
fn get_card_render_for_phrase_fill_returns_structural_metadata() {
    let engine = WasmEngine::new(MATERIAL_JSON, "", "", 0.9, 0).unwrap();
    let card_id = first_card_id_where(|k| matches!(k, CardKind::PhraseFill { position: 1 }));
    let json = engine.get_card_render_for_test(card_id).unwrap();
    let v: serde_json::Value = serde_json::from_str(&json).unwrap();
    assert_eq!(v["cardId"], card_id);
    assert_eq!(v["kind"], "PhraseFill");
    assert_eq!(v["position"], 1);
    assert_eq!(v["verse"]["book"], "John");
    assert_eq!(v["verse"]["chapter"], 3);
    assert_eq!(v["verse"]["verse"], 16);
    assert_eq!(v["verse"]["phraseWordCounts"].as_array().unwrap().len(), 4);
    assert_eq!(v["verse"]["phraseWordCounts"][0], 2);
    assert_eq!(v["verse"]["ftvWordCount"], 2);
    assert!(v["verse"]["annotations"].as_array().unwrap().is_empty());
}

#[test]
fn get_card_render_for_recitation_has_structural_verse_data() {
    let engine = WasmEngine::new(MATERIAL_JSON, "", "", 0.9, 0).unwrap();
    let card_id = first_card_id_where(|k| matches!(k, CardKind::Recitation));
    let json = engine.get_card_render_for_test(card_id).unwrap();
    let v: serde_json::Value = serde_json::from_str(&json).unwrap();
    assert_eq!(v["kind"], "Recitation");
    assert!(
        v["verse"].get("text").is_none(),
        "verse text must not cross the wire"
    );
    assert!(
        v["verse"].get("phrases").is_none(),
        "phrase strings must not cross the wire"
    );
    assert_eq!(v["verse"]["phraseWordCounts"].as_array().unwrap().len(), 4);
    assert!(v["verse"]["headings"].as_array().unwrap().is_empty());
    // MATERIAL_JSON has no club tag, so the verse lands in the Full tier.
    assert_eq!(v["verse"]["clubs"], serde_json::json!(["Full"]));
}

#[test]
fn get_card_render_unknown_card_id_returns_error() {
    let engine = WasmEngine::new(MATERIAL_JSON, "", "", 0.9, 0).unwrap();
    let err = engine.get_card_render_for_test(999_999).unwrap_err();
    assert!(err.contains("unknown card id"), "got: {err}");
}

#[test]
fn material_config_json_parses_and_filters_emission() {
    // FTV-eligible verse with everything-off in the config: when we count
    // by club tier (a proxy for total card count), the everything-off
    // engine produces fewer cards than the default. Core-level tests
    // verify the specific kinds dropped; this test just confirms the
    // config JSON crosses the wasm boundary and reaches `build_with_config`.
    let default_engine = WasmEngine::new(MATERIAL_JSON, "", "", 0.9, 0).unwrap();
    // Turn off the year-wide toggles. Club configs stay at their map
    // entries from build_with_config; we only need `headings` and `ftv`
    // off to demonstrate that config JSON crosses the wasm boundary.
    let off_engine = WasmEngine::new(
        MATERIAL_JSON,
        // Legacy-shape JSON; new_scope/review_scope=all keeps the Full
        // verse out of Paused via the legacy → per-club migrator.
        r#"{"headings":false,"ftv":false,
            "new_scope":"all","review_scope":"all",
            "club_card_scope":"off","chapter_list_scope":"off"}"#,
        "",
        0.9,
        0,
    )
    .unwrap();
    let default_counts: serde_json::Value =
        serde_json::from_str(&default_engine.card_count_by_club_for_test()).unwrap();
    let off_counts: serde_json::Value =
        serde_json::from_str(&off_engine.card_count_by_club_for_test()).unwrap();
    let default_total = default_counts["Full"].as_u64().unwrap();
    let off_total = off_counts["Full"].as_u64().unwrap();
    assert!(
        off_total < default_total,
        "everything-off should produce fewer cards: default={default_total}, off={off_total}"
    );
}

// Two-verse Club150 chapter with a heading covering both: builder emits
// one HeadingPassage card and one ChapterClubList card alongside the
// per-verse content cards.
const MATERIAL_HP_CCL_JSON: &str = r#"{
    "year": 3,
    "books": ["John"],
    "chapters": [{"book": "John", "number": 3, "start_verse": 16, "end_verse": 17}],
    "verses": [
        {"book": "John", "chapter": 3, "verse": 16, "phraseWordCounts": [2, 2], "annotations": [], "clubs": [150]},
        {"book": "John", "chapter": 3, "verse": 17, "phraseWordCounts": [2, 3], "annotations": [], "clubs": [150]}
    ],
    "headings": [{
        "book": "John",
        "startChapter": 3, "startVerse": 16,
        "endChapter": 3, "endVerse": 17
    }]
}"#;

#[test]
fn memorize_session_surfaces_hp_and_ccl_as_standalone_slots() {
    let engine = WasmEngine::new(MATERIAL_HP_CCL_JSON, "", "", 0.9, 0).unwrap();
    let json = engine.memorize_session(10).unwrap();
    let session: serde_json::Value = serde_json::from_str(&json).unwrap();
    let entries = session["verses"].as_array().unwrap();
    let any_hp = entries
        .iter()
        .filter_map(|e| e.get("hpCardId").and_then(|v| v.as_u64()))
        .next();
    let any_ccl = entries
        .iter()
        .filter_map(|e| e.get("cclCardId").and_then(|v| v.as_u64()))
        .next();
    assert!(any_hp.is_some(), "expected an hpCardId slot in {json}");
    assert!(any_ccl.is_some(), "expected a cclCardId slot in {json}");
    // The HP/CCL ids must not also appear inside any verse's cardIds —
    // they're surfaced as their own session items now.
    let all_card_ids: Vec<u64> = entries
        .iter()
        .flat_map(|e| e["cardIds"].as_array().unwrap().iter())
        .map(|v| v.as_u64().unwrap())
        .collect();
    assert!(
        !all_card_ids.contains(&any_hp.unwrap()),
        "hp card surfaced inside cardIds"
    );
    assert!(
        !all_card_ids.contains(&any_ccl.unwrap()),
        "ccl card surfaced inside cardIds"
    );
}

#[test]
fn memorize_session_surfaces_orphan_conditional_cards() {
    // Turn on club_card_scope so VerseInClub cards exist on the Club150
    // verses. Graduate verse 0 — only its unconditional cards flip,
    // leaving its VerseInClub `New`. memorize_session must then
    // surface that orphan as a standalone item on verse 1's entry;
    // verse 0 no longer anchors a session-verse since it has no fresh
    // unconditional content.
    let config_json = r#"{
        "heading_card": false,
        "heading_passage_card": true,
        "ftv": true,
        "new_scope": "all",
        "review_scope": "all",
        "club_card_scope": "all",
        "chapter_list_scope": "up150",
        "clubs": {"Club150": "Active"}
    }"#;
    let mut engine = WasmEngine::new(MATERIAL_HP_CCL_JSON, config_json, "", 0.9, 0).unwrap();
    engine.graduate_verse(0);
    let json = engine.memorize_session(10).unwrap();
    let session: serde_json::Value = serde_json::from_str(&json).unwrap();
    let entries = session["verses"].as_array().unwrap();
    assert_eq!(
        entries.len(),
        1,
        "only verse 1 should anchor a session-verse: {json}"
    );
    assert_eq!(entries[0]["verseId"], 1);
    let orphans = session["orphans"]
        .as_array()
        .expect("top-level orphans array should be present");
    assert!(
        !orphans.is_empty(),
        "expected verse 0's orphan VerseInClub to surface: {json}"
    );
}

#[test]
fn memorize_session_surfaces_orphans_when_no_fresh_verses() {
    // Graduate BOTH verses, then enable VerseInClub via the config so
    // their VerseInClub cards exist as orphans on already-Active
    // verses. With no fresh verses left, the session has no
    // verse-anchored entries — orphans must still surface so the user
    // can engage with them up to the configured per-session cap.
    let config_json = r#"{
        "heading_card": false,
        "heading_passage_card": true,
        "ftv": true,
        "new_scope": "all",
        "review_scope": "all",
        "club_card_scope": "all",
        "chapter_list_scope": "up150",
        "clubs": {"Club150": "Active"}
    }"#;
    let mut engine = WasmEngine::new(MATERIAL_HP_CCL_JSON, config_json, "", 0.9, 0).unwrap();
    engine.graduate_verse(0);
    engine.graduate_verse(1);
    let json = engine.memorize_session(3).unwrap();
    let session: serde_json::Value = serde_json::from_str(&json).unwrap();
    let entries = session["verses"].as_array().unwrap();
    assert!(
        entries.is_empty(),
        "no fresh verses should be anchored: {json}"
    );
    let orphans = session["orphans"]
        .as_array()
        .expect("top-level orphans should be present when verse_order is empty");
    assert!(
        !orphans.is_empty(),
        "expected orphans to surface even without fresh verses: {json}"
    );
}

#[test]
fn graduate_card_flips_one_card_and_is_idempotent() {
    let mut engine = WasmEngine::new(MATERIAL_HP_CCL_JSON, "", "", 0.9, 0).unwrap();
    let json = engine.memorize_session(10).unwrap();
    let session: serde_json::Value = serde_json::from_str(&json).unwrap();
    let entries = session["verses"].as_array().unwrap();
    let hp_id = entries
        .iter()
        .filter_map(|e| e.get("hpCardId").and_then(|v| v.as_u64()))
        .next()
        .map(|x| x as u32)
        .expect("hpCardId slot");
    assert!(engine.graduate_card(hp_id));
    assert!(!engine.graduate_card(hp_id));
    // graduate_verse on either verse must NOT flip the HP card —
    // it stays Active from the explicit graduate_card above. We can't
    // re-check the HP state through the wire shape here, but a second
    // graduate_card returns false (already Active), and a fresh engine
    // confirms graduate_verse alone leaves the HP New.
    let mut engine2 = WasmEngine::new(MATERIAL_HP_CCL_JSON, "", "", 0.9, 0).unwrap();
    engine2.graduate_verse(0);
    engine2.graduate_verse(1);
    // HP is still New, so graduate_card returns true.
    assert!(engine2.graduate_card(hp_id));
}

#[test]
fn card_count_by_club_returns_buckets_for_full_tier_material() {
    let engine = WasmEngine::new(MATERIAL_JSON, "", "", 0.9, 0).unwrap();
    let json = engine.card_count_by_club_for_test();
    let v: serde_json::Value = serde_json::from_str(&json).unwrap();
    // MATERIAL_JSON has empty clubs on its single verse, so parse_tiers
    // routes everything into the Full tier. The narrower tier keys
    // don't appear at all (not 0).
    let full = v["Full"].as_u64().expect("Full bucket missing");
    assert!(full > 0, "expected some Full-tier cards");
    assert!(v.get("Club150").is_none());
    assert!(v.get("Club300").is_none());
}
