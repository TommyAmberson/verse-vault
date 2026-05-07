//! Scenario tests for the single-grade Recitation pipeline.
//!
//! Recitation now contains every phrase plus the citation triple. Grading
//! the card distributes one user grade across all those tests via HSRS's
//! Bayesian-share decomposition — every contained test sees a sub-update
//! (`last_seen` advances, stability climbs) but `last_root_secs` never
//! advances on any of them, since no atomic-card review fired.

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
fn recitation_lifts_phrases_and_bindings_without_advancing_last_root() {
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
        engine.review(recitation_id, Grade::Good, now);
        now += 86_400 * 7;
    }

    let phrase_initial = TestState::new_unseen(build_now);

    // Recitation contains PhraseFromChain for every phrase.
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
    assert!(
        phrase_state.stability > phrase_initial.stability,
        "phrase stability must climb under repeated Recitation reviews \
         (got {} vs initial {})",
        phrase_state.stability,
        phrase_initial.stability,
    );

    // Recitation also contains the chapter binding directly. Stability
    // should rise from sub-updates.
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
        "binding stability must climb (got {})",
        chapter_state.stability,
    );

    // The load-bearing HSRS invariant for the new pipeline: Recitation is
    // a composite card, so every contained test gets a Sub update —
    // `last_root_secs` never advances on any of them.
    assert_eq!(
        phrase_state.last_root_secs, initial_root,
        "phrase last_root must stay at initial under composite-only review",
    );
    assert_eq!(
        chapter_state.last_root_secs, initial_root,
        "binding last_root must stay at initial under composite-only review",
    );

    // last_seen on both should still have advanced.
    assert!(phrase_state.last_seen_secs > initial_root);
    assert!(chapter_state.last_seen_secs > initial_root);
}

/// One Recitation review at delta_t > 0 must not saturate any of its
/// contained tests' stabilities to S_MAX. Regression for the
/// `invert_r(r ≈ 1.0, ε)` saturation bug.
#[test]
fn recitation_does_not_saturate_bindings_to_s_max() {
    let material = one_verse_material();
    let build_now = 0;
    let r = build(&material, build_now);
    let mut engine = ReviewEngine::new(r, 0.9);

    let recitation_id = engine
        .cards
        .iter()
        .find(|c| matches!(c.kind, CardKind::Recitation))
        .expect("Recitation card built")
        .id;

    let now = build_now + 86_400 * 365;
    engine.review(recitation_id, Grade::Good, now);

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

    // 365 days is roughly the soft-clamp ceiling. Anything well above
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
