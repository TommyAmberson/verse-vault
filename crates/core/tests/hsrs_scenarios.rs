//! Scenario tests from `docs/path-posterior-memory-model.md`: many
//! Recitation reviews on a verse should lift the directly-graded phrase
//! tests' stability, and via propagation also lift the verse-binding tests'
//! stability — but the bindings stay strictly below an equivalently-aged
//! direct phrase test, and their `last_root_secs` never advances.

use std::collections::HashMap;

use verse_vault_core::builder::build;
use verse_vault_core::card::CardKind;
use verse_vault_core::content::MaterialData;
use verse_vault_core::element::ElementId;
use verse_vault_core::engine::ReviewEngine;
use verse_vault_core::test_kind::{TestKey, TestKind};
use verse_vault_core::test_state::TestState;
use verse_vault_core::types::Grade;

fn one_verse_material() -> MaterialData {
    serde_json::from_str(
        r#"{
            "year": 3,
            "books": ["John"],
            "chapters": [{"book": "John", "number": 3, "start_verse": 16, "end_verse": 16}],
            "verses": [
                {
                    "book": "John", "chapter": 3, "verse": 16,
                    "text": "For God so loved the world that he gave",
                    "phrases": ["For God", "so loved", "the world", "that he gave"],
                    "ftv": "",
                    "clubs": []
                }
            ],
            "headings": []
        }"#,
    )
    .unwrap()
}

#[test]
fn recitation_lifts_phrases_directly_and_bindings_via_propagation() {
    let material = one_verse_material();
    let build_now = 0;
    let r = build(&material, build_now);
    let mut engine = ReviewEngine::new(r, 0.9);

    let initial_root = TestState::new_unseen(build_now).last_root_secs;

    let recitation_id = engine
        .cards
        .iter()
        .find(|c| matches!(c.kind, CardKind::Recitation))
        .expect("Recitation card built")
        .id;

    // Grade the Recitation Good 5 times, spaced 7 days apart.
    let mut now = build_now + 86_400 * 365;
    for _ in 0..5 {
        let card = engine.card(recitation_id).unwrap().clone();
        let atoms = engine.atoms_for(card.verse_id);
        let grades: HashMap<TestKey, Grade> = card
            .tests(&atoms)
            .into_iter()
            .map(|t| (t, Grade::Good))
            .collect();
        engine.review(recitation_id, grades, now);
        now += 86_400 * 7;
    }

    // Recitation grades PhraseFromChain for every phrase directly.
    let phrase_chain_0 = TestKey {
        kind: TestKind::PhraseFromChain,
        element: ElementId::Phrase {
            verse_id: 0,
            position: 0,
        },
    };
    let phrase_state = engine
        .test_state(phrase_chain_0)
        .copied()
        .expect("phrase test seeded");
    let phrase_initial = TestState::new_unseen(build_now);
    assert!(
        phrase_state.stability > phrase_initial.stability,
        "directly-graded phrase stability must climb (got {} vs initial {})",
        phrase_state.stability,
        phrase_initial.stability,
    );
    assert!(
        phrase_state.last_root_secs > initial_root,
        "phrase last_root must advance under direct review",
    );

    // VerseChapterBinding only sees propagated updates from Recitation —
    // its stability should rise, but stay strictly below the directly-graded
    // phrase test's stability.
    let chapter_binding = TestKey {
        kind: TestKind::VerseChapter,
        element: ElementId::VerseChapterBinding { verse_id: 0 },
    };
    let chapter_state = engine
        .test_state(chapter_binding)
        .copied()
        .expect("chapter binding test seeded");
    assert!(
        chapter_state.stability > phrase_initial.stability,
        "binding stability must climb via propagation (got {})",
        chapter_state.stability,
    );
    assert!(
        chapter_state.stability < phrase_state.stability,
        "binding stability must stay below directly-graded phrase ({} vs {})",
        chapter_state.stability,
        phrase_state.stability,
    );

    // The load-bearing HSRS invariant: propagation never advances
    // last_root_secs. The chapter binding was only ever propagated to.
    assert_eq!(
        chapter_state.last_root_secs, initial_root,
        "binding last_root must remain at initial value under propagation",
    );

    // last_seen on the binding should still have advanced — propagation
    // does refresh that timestamp so sibling cooldown applies.
    assert!(
        chapter_state.last_seen_secs > initial_root,
        "binding last_seen must advance under propagation",
    );
}

/// Holistic grades both phrases and verse-bindings directly in the same
/// review. Without HSRS-style dedup of the propagation set against the
/// direct set, a phrase direct's propagation would land on a verse-binding
/// that was already direct-stepped this tick — its `last_base_secs` would
/// equal `now_secs`, `elapsed = 0`, and `invert_r(r ≈ 1.0, 0.001, decay)`
/// would saturate stability to `S_MAX`. Regression test for that.
#[test]
fn holistic_does_not_saturate_bindings_to_s_max() {
    let material = one_verse_material();
    let build_now = 0;
    let r = build(&material, build_now);
    let mut engine = ReviewEngine::new(r, 0.9);

    let holistic_id = engine
        .cards
        .iter()
        .find(|c| matches!(c.kind, CardKind::Holistic))
        .expect("Holistic card built")
        .id;

    let now = build_now + 86_400 * 365;
    let card = engine.card(holistic_id).unwrap().clone();
    let atoms = engine.atoms_for(card.verse_id);
    let grades: HashMap<TestKey, Grade> = card
        .tests(&atoms)
        .into_iter()
        .map(|t| (t, Grade::Good))
        .collect();
    engine.review(holistic_id, grades, now);

    // After one Holistic review: phrase tests are direct-graded, binding
    // tests are direct-graded too. Neither should be anywhere near S_MAX.
    let chapter_binding = TestKey {
        kind: TestKind::VerseChapter,
        element: ElementId::VerseChapterBinding { verse_id: 0 },
    };
    let phrase_chain_0 = TestKey {
        kind: TestKind::PhraseFromChain,
        element: ElementId::Phrase {
            verse_id: 0,
            position: 0,
        },
    };
    let chapter_state = engine.test_state(chapter_binding).copied().unwrap();
    let phrase_state = engine.test_state(phrase_chain_0).copied().unwrap();

    // 365 days is roughly HSRS's softClamp ceiling. Anything well above
    // that on a single Good review is the saturation bug.
    assert!(
        chapter_state.stability < 365.0,
        "binding stability ballooned to {} — saturation bug regressed",
        chapter_state.stability,
    );
    assert!(
        phrase_state.stability < 365.0,
        "phrase stability ballooned to {} — saturation bug regressed",
        phrase_state.stability,
    );
}
