use std::collections::{HashMap, HashSet};

use crate::builder::BuildResult;
use crate::card::{Card, VerseAtoms};
use crate::element::ElementId;
use crate::element::ElementMeta;
use crate::fsrs_bridge::FsrsBridge;
use crate::propagate::{PropagationParams, related_tests};
use crate::test_kind::TestKey;
use crate::test_state::TestState;
use crate::types::{CardId, Grade};
use crate::verse_index::VerseIndex;

#[derive(Debug, Clone, Copy)]
pub struct ScheduleParams {
    /// Per-test retrievability target the scheduler aims at.
    pub target_retention: f32,
    /// Cooldown window during which a card with any test recently touched
    /// (directly or via propagation) is hidden from the scheduler.
    pub sibling_cooldown_secs: i64,
}

impl Default for ScheduleParams {
    fn default() -> Self {
        Self {
            target_retention: 0.9,
            sibling_cooldown_secs: 30 * 60,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum UpdateKind {
    Direct,
    Propagated,
}

#[derive(Debug, Clone)]
pub struct TestUpdate {
    pub key: TestKey,
    pub kind: UpdateKind,
    pub before: TestState,
    pub after: TestState,
}

#[derive(Debug, Clone, Default)]
pub struct ReviewOutcome {
    pub updates: Vec<TestUpdate>,
}

/// Owns the entire HSRS review state: cards, per-test memory states, the
/// FSRS bridge, and the schedule / propagation tunables. Mutated only via
/// `review`; `next_card` reads it.
///
/// Fields are `pub` so persistence layers (WASM, future server) can
/// snapshot and replay without going through accessors.
pub struct ReviewEngine {
    pub verse_index: VerseIndex,
    pub element_meta: HashMap<ElementId, ElementMeta>,
    pub cards: Vec<Card>,
    pub tests: HashMap<TestKey, TestState>,
    pub fsrs: FsrsBridge,
    pub schedule_params: ScheduleParams,
    pub propagation_params: PropagationParams,
    /// Per-verse VerseAtoms. Populated at build time so `atoms_for` is O(1).
    pub verse_atoms_data: HashMap<u32, VerseAtoms>,
}

impl ReviewEngine {
    pub fn new(b: BuildResult, desired_retention: f32) -> Self {
        Self {
            verse_index: b.verse_index,
            element_meta: b.element_meta,
            cards: b.cards,
            tests: b.tests,
            fsrs: FsrsBridge::new(desired_retention),
            schedule_params: ScheduleParams {
                target_retention: desired_retention,
                ..ScheduleParams::default()
            },
            propagation_params: PropagationParams::default(),
            verse_atoms_data: b.verse_atoms_data,
        }
    }

    /// Look up a card by id. Linear scan — fine for the few-thousand-card
    /// scale this engine is designed for.
    pub fn card(&self, id: CardId) -> Option<&Card> {
        self.cards.iter().find(|c| c.id == id)
    }

    /// Borrow a test's memory state, or `None` if the test was never seeded.
    pub fn test_state(&self, k: TestKey) -> Option<&TestState> {
        self.tests.get(&k)
    }

    /// Return the `VerseAtoms` for a verse — the data needed by `Card::tests`
    /// to expand composite cards into per-test grade keys. Falls back to a
    /// phrase-count-only reconstruction from `verse_index` if the verse isn't
    /// in the populated data map (shouldn't happen for cards built via
    /// `builder::build`).
    pub fn atoms_for(&self, verse_id: u32) -> VerseAtoms {
        if let Some(atoms) = self.verse_atoms_data.get(&verse_id) {
            return atoms.clone();
        }
        let phrases = self.verse_index.phrases_of(verse_id);
        let headings = if let Some(e) = self.verse_index.elements_of(verse_id) {
            e.headings.clone()
        } else {
            Vec::new()
        };
        let clubs = if let Some(e) = self.verse_index.elements_of(verse_id) {
            e.clubs.clone()
        } else {
            Vec::new()
        };
        VerseAtoms {
            verse_id,
            phrase_count: phrases.len() as u16,
            headings,
            clubs,
            ftv: None,
            phrase_zero_text: None,
        }
    }

    /// Apply a per-test grade map to this card and return the resulting
    /// updates (for replay / persistence).
    ///
    /// `grades.keys()` must equal `card.tests(atoms)` exactly — the engine
    /// panics on mismatch rather than silently dropping or seeding tests.
    ///
    /// Pipeline (HSRS-style: one update per `TestKey` per review):
    ///
    /// 1. Build the propagation set: for each direct, fan out
    ///    `related_tests`. Drop targets that are themselves direct-graded
    ///    this review (a real grade is stronger evidence than a related
    ///    test's nudge). If multiple directs propagate to the same target,
    ///    keep the highest-weight edge.
    /// 2. `direct_step` every graded test.
    /// 3. `propagated_step` every (deduped) propagation target — exactly
    ///    once each.
    ///
    /// This mirrors HSRS's `getLearningCardDiff` which dedupes flattened
    /// learnings by `cardId` so each target receives at most one update per
    /// observation. Without the dedup, a direct already stamped at
    /// `now_secs` would receive a propagated update with `elapsed = 0`,
    /// which falls into `invert_r`'s `r ≈ 1.0` short-circuit and saturates
    /// the test's stability to `S_MAX`.
    pub fn review(
        &mut self,
        card_id: CardId,
        grades: HashMap<TestKey, Grade>,
        now_secs: i64,
    ) -> ReviewOutcome {
        let card = self
            .card(card_id)
            .unwrap_or_else(|| panic!("review: unknown card {card_id:?}"))
            .clone();
        let atoms = self.atoms_for(card.verse_id);
        let expected: HashSet<TestKey> = card.tests(&atoms).into_iter().collect();
        let actual: HashSet<TestKey> = grades.keys().copied().collect();
        assert_eq!(
            actual, expected,
            "review: graded tests must equal card.tests(atoms)"
        );

        let mut updates: Vec<TestUpdate> = Vec::with_capacity(expected.len() * 4);

        // 1. Build the propagation set, deduping against directs and across
        //    multiple directs. `prop_targets[target] = (grade, weight)` —
        //    the strongest-weight edge wins on collision.
        let direct_pairs: Vec<(TestKey, Grade)> = grades.iter().map(|(&k, &g)| (k, g)).collect();
        let direct_keys: HashSet<TestKey> = direct_pairs.iter().map(|(k, _)| *k).collect();
        let mut prop_targets: HashMap<TestKey, (Grade, f32)> = HashMap::new();
        for (direct_key, grade) in &direct_pairs {
            for edge in related_tests(*direct_key, &self.verse_index, &self.propagation_params) {
                if direct_keys.contains(&edge.target) {
                    continue;
                }
                let entry = prop_targets
                    .entry(edge.target)
                    .or_insert((*grade, edge.weight));
                if edge.weight > entry.1 {
                    *entry = (*grade, edge.weight);
                }
            }
        }

        // 2. Direct updates.
        for (key, grade) in &direct_pairs {
            let before = *self
                .tests
                .get(key)
                .unwrap_or_else(|| panic!("review: missing TestState for direct key {key:?}"));
            let after = self.fsrs.direct_step(&before, *grade, now_secs);
            self.tests.insert(*key, after);
            updates.push(TestUpdate {
                key: *key,
                kind: UpdateKind::Direct,
                before,
                after,
            });
        }

        // 3. Propagated updates — each target hit exactly once.
        for (target, (grade, weight)) in prop_targets {
            let before = match self.tests.get(&target) {
                Some(s) => *s,
                None => continue, // target not in card universe — skip silently.
            };
            let after = self.fsrs.propagated_step(&before, grade, weight, now_secs);
            self.tests.insert(target, after);
            updates.push(TestUpdate {
                key: target,
                kind: UpdateKind::Propagated,
                before,
                after,
            });
        }

        ReviewOutcome { updates }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::card::CardKind;
    use crate::content::MaterialData;
    use crate::test_kind::TestKind;

    fn sample_material_one_verse() -> MaterialData {
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
                        "ftv": "For God",
                        "clubs": []
                    }
                ],
                "headings": []
            }"#,
        )
        .unwrap()
    }

    fn build_engine() -> ReviewEngine {
        let m = sample_material_one_verse();
        let r = crate::builder::build(&m, 0);
        ReviewEngine::new(r, 0.9)
    }

    #[test]
    fn engine_constructs_from_buildresult() {
        let engine = build_engine();
        assert!(!engine.cards.is_empty());
        assert!(!engine.tests.is_empty());
        // atoms_for round-trips ftv + phrase_zero_text from build.
        let atoms = engine.atoms_for(0);
        assert_eq!(atoms.phrase_count, 4);
        assert_eq!(atoms.ftv.as_deref(), Some("For God"));
        assert_eq!(atoms.phrase_zero_text.as_deref(), Some("For God"));
    }

    #[test]
    fn review_citation_card_updates_three_tests() {
        let mut engine = build_engine();
        let card_id = engine
            .cards
            .iter()
            .find(|c| matches!(c.kind, CardKind::Citation))
            .unwrap()
            .id;
        let atoms = engine.atoms_for(0);
        let card = engine.card(card_id).unwrap().clone();
        let grades: HashMap<_, _> = card
            .tests(&atoms)
            .into_iter()
            .map(|t| (t, Grade::Good))
            .collect();
        let now = 86400 * 365 + 86400 * 7;
        let outcome = engine.review(card_id, grades, now);
        let direct_count = outcome
            .updates
            .iter()
            .filter(|u| u.kind == UpdateKind::Direct)
            .count();
        assert_eq!(direct_count, 3);
        // Direct binding tests get last_root advanced.
        let s = engine
            .test_state(TestKey {
                kind: TestKind::VerseRefPosition,
                element: ElementId::VerseRefPosition { verse_id: 0 },
            })
            .unwrap();
        assert_eq!(s.last_root_secs, now);
    }

    #[test]
    fn review_propagates_to_related_tests() {
        let mut engine = build_engine();
        let card_id = engine
            .cards
            .iter()
            .find(|c| matches!(c.kind, CardKind::PhraseFill { .. }))
            .unwrap()
            .id;
        let atoms = engine.atoms_for(0);
        let card = engine.card(card_id).unwrap().clone();
        let grades: HashMap<_, _> = card
            .tests(&atoms)
            .into_iter()
            .map(|t| (t, Grade::Good))
            .collect();
        let now = 86400 * 365 + 86400 * 7;
        let outcome = engine.review(card_id, grades, now);
        assert!(
            outcome
                .updates
                .iter()
                .any(|u| u.kind == UpdateKind::Propagated)
        );
        // The propagated VerseChapter binding should have been touched but
        // its last_root must remain at the seeded (initial) value.
        let chapter_state = engine
            .test_state(TestKey {
                kind: TestKind::VerseChapter,
                element: ElementId::VerseChapterBinding { verse_id: 0 },
            })
            .unwrap();
        assert_eq!(chapter_state.last_seen_secs, now);
        // Initial `last_root_secs` is `now_at_build - 365 days` (build time was 0).
        let initial_root = TestState::new_unseen(0).last_root_secs;
        assert_eq!(chapter_state.last_root_secs, initial_root);
    }

    #[test]
    fn review_phrasefill_has_one_direct_and_propagated() {
        let mut engine = build_engine();
        let card_id = engine
            .cards
            .iter()
            .find(|c| matches!(c.kind, CardKind::PhraseFill { .. }))
            .unwrap()
            .id;
        let atoms = engine.atoms_for(0);
        let card = engine.card(card_id).unwrap().clone();
        let grades: HashMap<_, _> = card
            .tests(&atoms)
            .into_iter()
            .map(|t| (t, Grade::Good))
            .collect();
        let now = 86400 * 365 + 86400 * 7;
        let outcome = engine.review(card_id, grades, now);
        let direct = outcome
            .updates
            .iter()
            .filter(|u| u.kind == UpdateKind::Direct)
            .count();
        let propagated = outcome
            .updates
            .iter()
            .filter(|u| u.kind == UpdateKind::Propagated)
            .count();
        assert_eq!(direct, 1);
        // 1 sibling + 3 verse-binding endpoints (no headings, no clubs).
        assert_eq!(propagated, 4);
    }

    #[test]
    #[should_panic(expected = "graded tests must equal")]
    fn review_panics_on_mismatched_grades() {
        let mut engine = build_engine();
        let card_id = engine
            .cards
            .iter()
            .find(|c| matches!(c.kind, CardKind::Citation))
            .unwrap()
            .id;
        let mut grades: HashMap<TestKey, Grade> = HashMap::new();
        // missing the other two — Citation grades 3.
        grades.insert(
            TestKey {
                kind: TestKind::VerseRefPosition,
                element: ElementId::VerseRefPosition { verse_id: 0 },
            },
            Grade::Good,
        );
        engine.review(card_id, grades, 86400 * 365);
    }
}
