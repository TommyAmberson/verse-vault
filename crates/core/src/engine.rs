use std::collections::HashMap;

use crate::builder::BuildResult;
use crate::card::{Card, VerseAtoms};
use crate::element::ElementId;
use crate::element::ElementMeta;
use crate::fsrs_bridge::FsrsBridge;
use crate::propagate::PropagationParams;
use crate::test_kind::TestKey;
use crate::test_state::TestState;
use crate::types::CardId;
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

    pub fn card(&self, id: CardId) -> Option<&Card> {
        self.cards.iter().find(|c| c.id == id)
    }

    pub fn test_state(&self, k: TestKey) -> Option<&TestState> {
        self.tests.get(&k)
    }

    /// Return the `VerseAtoms` for a verse. Falls back to a phrase-count-only
    /// reconstruction from `verse_index` if the verse isn't in the populated
    /// data map (shouldn't happen for cards built via `builder::build`).
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
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::content::MaterialData;

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
}
