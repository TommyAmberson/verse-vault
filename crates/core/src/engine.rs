use std::collections::HashMap;

use crate::builder::BuildResult;
use crate::card::{Card, CardState, VerseAtoms};
use crate::fsrs_bridge::FsrsBridge;
use crate::material_config::{ClubStatus, MaterialConfig};
use crate::render::VerseRender;
use crate::test_kind::TestKey;
use crate::test_state::TestState;
use crate::types::{CardId, Grade};
use crate::verse_index::VerseIndex;

#[derive(Debug, Clone, Copy)]
pub struct ScheduleParams {
    /// Per-test retrievability target the scheduler aims at.
    pub target_retention: f32,
    /// Cooldown window during which a card with any test recently touched
    /// is hidden from the scheduler.
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
    /// Atomic-card review: the card's single test is updated as a full
    /// FSRS step, advancing all three timestamps.
    Root,
    /// Composite-card review: one of the contained tests gets a Bayesian-
    /// share sub-update; `last_root_secs` is preserved.
    Sub,
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
    pub cards: Vec<Card>,
    pub tests: HashMap<TestKey, TestState>,
    pub fsrs: FsrsBridge,
    pub schedule_params: ScheduleParams,
    /// Per-verse VerseAtoms. Populated at build time so `atoms_for` is O(1).
    pub verse_atoms_data: HashMap<u32, VerseAtoms>,
    /// Per-verse structural render metadata — phrase word counts, annotations,
    /// FTV word count, heading ranges, club tiers. Verse text is composed
    /// server-side from api.bible chapter HTML at request time.
    pub verse_render_data: HashMap<u32, VerseRender>,
    /// Retained so scheduler queue helpers can honour per-tier
    /// `new_scope` / `review_scope` at request time without callers
    /// re-threading the config.
    pub material_config: MaterialConfig,
}

impl ReviewEngine {
    pub fn new(b: BuildResult, desired_retention: f32) -> Self {
        Self {
            verse_index: b.verse_index,
            cards: b.cards,
            tests: b.tests,
            fsrs: FsrsBridge::new(desired_retention),
            schedule_params: ScheduleParams {
                target_retention: desired_retention,
                ..ScheduleParams::default()
            },
            verse_atoms_data: b.verse_atoms_data,
            verse_render_data: b.verse_render_data,
            material_config: b.material_config,
        }
    }

    /// Effective club status for a verse's most-specific tier under
    /// the current `material_config`. `None` for pseudo-verses with
    /// no tier list. Paused verses never get cards built in the
    /// first place, so this returns `Active` or `Maintenance` in
    /// practice.
    pub fn verse_status(&self, verse_id: u32) -> Option<ClubStatus> {
        let elements = self.verse_index.elements_of(verse_id)?;
        let tier = *elements.clubs.first()?;
        Some(self.material_config.effective_status(tier))
    }

    /// True when the verse may surface in the memorize queue —
    /// every tier status except `Maintenance`. Pseudo-verses (no
    /// tier) pass through.
    pub fn verse_active_for_memorize(&self, verse_id: u32) -> bool {
        !matches!(self.verse_status(verse_id), Some(ClubStatus::Maintenance))
    }

    /// Borrow the per-verse render data for a verse, or `None` if the verse
    /// isn't in the catalog.
    pub fn verse_render(&self, verse_id: u32) -> Option<&VerseRender> {
        self.verse_render_data.get(&verse_id)
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
    /// reconstruction from `verse_index` (phrase count + headings + clubs;
    /// FTV word count not recoverable) if the verse isn't in the populated
    /// data map (shouldn't happen for cards built via `builder::build`).
    pub fn atoms_for(&self, verse_id: u32) -> VerseAtoms {
        if let Some(atoms) = self.verse_atoms_data.get(&verse_id) {
            return atoms.clone();
        }
        let elements = self.verse_index.elements_of(verse_id);
        let phrase_ranges = elements
            .map(|e| e.phrase_ranges.clone())
            .unwrap_or_default();
        let headings = elements.map(|e| e.headings.clone()).unwrap_or_default();
        let clubs = elements.map(|e| e.clubs.clone()).unwrap_or_default();
        VerseAtoms {
            verse_id,
            phrase_count: phrase_ranges.len() as u16,
            phrase_ranges,
            headings,
            clubs,
            ftv_word_count: None,
            phrase_zero_word_count: 0,
            chapter_members: Vec::new(),
            heading_members: Vec::new(),
        }
    }

    /// Flip every `New` card whose `verse_id` matches to `Active`. Returns
    /// the number of cards that transitioned. Idempotent: a second call on
    /// the same verse_id returns 0. The memorize-session graduation step
    /// uses this to "introduce" every card the verse owns in one go.
    pub fn graduate_verse(&mut self, verse_id: u32) -> usize {
        let mut count = 0;
        for card in self.cards.iter_mut().filter(|c| c.verse_id == verse_id) {
            if matches!(card.state, CardState::New) {
                card.state = CardState::Active;
                count += 1;
            }
        }
        count
    }

    /// Flip every card in the deck to `Active`. Convenience for tests and
    /// the sim, which bypass the memorize flow.
    pub fn graduate_all(&mut self) {
        for card in self.cards.iter_mut() {
            card.state = CardState::Active;
        }
    }

    /// Apply a single grade to a card and return the resulting test
    /// updates.
    ///
    /// Atomic cards (one contained test) update that test as a full FSRS
    /// step (`UpdateKind::Root`, `last_root_secs` advances). Composite
    /// cards (multiple contained tests, e.g. `Recitation`) distribute the
    /// grade across their contained tests via HSRS's Bayesian-share weight
    /// `(1 - p_i) / (1 - p_total)` — credit concentrates on the test
    /// whose pass was least expected. Composite-card sub-updates use
    /// `UpdateKind::Sub` and never advance `last_root_secs`.
    ///
    /// Cards with no contained tests (`Reading`) return an empty outcome.
    ///
    /// This mirrors HSRS's `getLearningCardDiff`: one user grade per card,
    /// decomposed across the elements the card contains.
    pub fn review(&mut self, card_id: CardId, grade: Grade, now_secs: i64) -> ReviewOutcome {
        let card = self
            .card(card_id)
            .unwrap_or_else(|| panic!("review: unknown card {card_id:?}"))
            .clone();
        let atoms = self.atoms_for(card.verse_id);
        let tests = card.tests(&atoms);

        if tests.is_empty() {
            return ReviewOutcome::default();
        }

        if tests.len() == 1 {
            // Atomic: full FSRS step, advances last_root.
            let key = tests[0];
            let before = *self
                .tests
                .get(&key)
                .unwrap_or_else(|| panic!("review: missing TestState for {key:?}"));
            let mut after = self.fsrs.update(&before, grade, 1.0, true, now_secs);
            after.pending_relearn = !grade.is_pass();
            self.tests.insert(key, after);
            return ReviewOutcome {
                updates: vec![TestUpdate {
                    key,
                    kind: UpdateKind::Root,
                    before,
                    after,
                }],
            };
        }

        // Composite: HSRS Bayesian-share decomposition over contained tests.
        let probs: Vec<f32> = tests
            .iter()
            .map(|k| {
                self.tests
                    .get(k)
                    .map(|s| self.fsrs.retrievability_of(s, now_secs))
                    .unwrap_or(1.0)
            })
            .collect();
        let p_total: f32 = probs.iter().product();
        let mut updates: Vec<TestUpdate> = Vec::with_capacity(tests.len());
        let pending = !grade.is_pass();
        for (key, p_i) in tests.iter().zip(&probs) {
            let weight = if p_total >= 1.0 - 1e-9 {
                0.0
            } else {
                ((1.0 - p_i) / (1.0 - p_total)).clamp(0.0, 1.0)
            };
            let before = *self
                .tests
                .get(key)
                .unwrap_or_else(|| panic!("review: missing TestState for {key:?}"));
            let mut after = self.fsrs.update(&before, grade, weight, false, now_secs);
            after.pending_relearn = pending;
            self.tests.insert(*key, after);
            updates.push(TestUpdate {
                key: *key,
                kind: UpdateKind::Sub,
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
    use crate::builder::build;
    use crate::card::CardKind;
    use crate::content::MaterialData;
    use crate::element::ElementId;
    use crate::test_kind::TestKind;

    fn sample_material_one_verse() -> MaterialData {
        // John 3:16 — 9 words split into 4 phrases of 2/2/2/3 words.
        // FTV "For God" = 2 words = phrase 0.
        serde_json::from_str(
            r#"{
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
        // atoms_for round-trips ftv_word_count + phrase_zero_word_count.
        let atoms = engine.atoms_for(0);
        assert_eq!(atoms.phrase_count, 4);
        assert_eq!(atoms.ftv_word_count, Some(2));
        assert_eq!(atoms.phrase_zero_word_count, 2);
    }

    #[test]
    fn review_atomic_card_full_update_advances_last_root() {
        let mut engine = build_engine();
        let card_id = engine
            .cards
            .iter()
            .find(|c| matches!(c.kind, CardKind::PhraseFill { .. }))
            .unwrap()
            .id;
        let now = 86400 * 365 + 86400 * 7;
        let outcome = engine.review(card_id, Grade::Good, now);
        // Atomic = exactly one Root update.
        assert_eq!(outcome.updates.len(), 1);
        assert_eq!(outcome.updates[0].kind, UpdateKind::Root);
        assert_eq!(outcome.updates[0].after.last_root_secs, now);
    }

    #[test]
    fn review_composite_distributes_grade_to_contained_tests() {
        let mut engine = build_engine();
        let card_id = engine
            .cards
            .iter()
            .find(|c| matches!(c.kind, CardKind::Citation))
            .unwrap()
            .id;
        let now = 86400 * 365 + 86400 * 7;
        let outcome = engine.review(card_id, Grade::Good, now);
        // Citation contains 3 tests; all should appear as Sub updates.
        assert_eq!(outcome.updates.len(), 3);
        assert!(outcome.updates.iter().all(|u| u.kind == UpdateKind::Sub));
    }

    #[test]
    fn review_composite_does_not_advance_last_root_anywhere() {
        let mut engine = build_engine();
        let card_id = engine
            .cards
            .iter()
            .find(|c| matches!(c.kind, CardKind::Recitation))
            .unwrap()
            .id;
        let initial_root = TestState::new_unseen(0).last_root_secs;
        let now = 86400 * 365 + 86400 * 7;
        let outcome = engine.review(card_id, Grade::Good, now);
        for u in &outcome.updates {
            assert_eq!(u.kind, UpdateKind::Sub);
            assert_eq!(
                u.after.last_root_secs, initial_root,
                "composite Sub update must preserve last_root_secs"
            );
        }
    }

    #[test]
    fn review_reading_card_is_no_op() {
        let mut engine = build_engine();
        // Reading is never emitted by the builder. Insert one ad hoc.
        let reading_id = CardId(u32::MAX);
        engine.cards.push(crate::card::Card {
            id: reading_id,
            kind: CardKind::Reading,
            verse_id: 0,
            state: crate::card::CardState::Active,
        });
        let outcome = engine.review(reading_id, Grade::Good, 86400 * 365);
        assert!(outcome.updates.is_empty());
    }

    #[test]
    fn atomic_again_sets_pending_relearn_then_good_clears_it() {
        let mut engine = build_engine();
        let card_id = engine
            .cards
            .iter()
            .find(|c| matches!(c.kind, CardKind::PhraseFill { .. }))
            .unwrap()
            .id;
        let card = engine.card(card_id).unwrap().clone();
        let key = card.tests(&engine.atoms_for(card.verse_id))[0];

        engine.review(card_id, Grade::Again, 86400 * 365);
        assert!(engine.test_state(key).unwrap().pending_relearn);

        // 6h later, FSRS sub-day due time has passed for a fresh-lapse card.
        engine.review(card_id, Grade::Good, 86400 * 365 + 6 * 3600);
        assert!(!engine.test_state(key).unwrap().pending_relearn);
    }

    #[test]
    fn composite_again_sets_pending_relearn_on_every_contained_test() {
        let mut engine = build_engine();
        let card_id = engine
            .cards
            .iter()
            .find(|c| matches!(c.kind, CardKind::Recitation))
            .unwrap()
            .id;
        let card = engine.card(card_id).unwrap().clone();
        let keys = card.tests(&engine.atoms_for(card.verse_id));

        let outcome = engine.review(card_id, Grade::Again, 86400 * 365);
        assert_eq!(outcome.updates.len(), keys.len());
        for key in &keys {
            assert!(
                engine.test_state(*key).unwrap().pending_relearn,
                "composite Again must set pending_relearn for {key:?}"
            );
        }
    }

    #[test]
    fn bayesian_concentrates_on_low_retr_targets() {
        // Recitation contains the chapter binding directly; pre-condition
        // it once with high stability and once with low. Bayesian share
        // should give the low-retr (more surprising pass) binding a larger
        // fractional lift.
        let m: MaterialData = serde_json::from_str(
            r#"{
                "year": 3,
                "books": ["John"],
                "chapters": [{"book": "John", "number": 3, "start_verse": 16, "end_verse": 16}],
                "verses": [
                    {
                        "book": "John", "chapter": 3, "verse": 16,
                        "phraseWordCounts": [2, 2],
                        "annotations": [],
                        "ftvWordCount": null,
                        "clubs": []
                    }
                ],
                "headings": []
            }"#,
        )
        .unwrap();

        let make_engine = |chapter_stability: f32| {
            let r = build(&m, 0);
            let mut engine = ReviewEngine::new(r, 0.9);
            let chapter_key = TestKey {
                kind: TestKind::VerseChapter,
                element: ElementId::VerseChapterBinding { verse_id: 0 },
            };
            let cs = engine.tests.get_mut(&chapter_key).unwrap();
            cs.stability = chapter_stability;
            cs.last_seen_secs = 0;
            cs.last_base_secs = 0;
            cs.last_root_secs = 0;
            engine
        };

        let recitation_id = |engine: &ReviewEngine| {
            engine
                .cards
                .iter()
                .find(|c| matches!(c.kind, CardKind::Recitation))
                .unwrap()
                .id
        };
        let chapter_key = TestKey {
            kind: TestKind::VerseChapter,
            element: ElementId::VerseChapterBinding { verse_id: 0 },
        };

        let now = 86400; // 1 day later

        let mut engine_strong = make_engine(1000.0);
        let id_strong = recitation_id(&engine_strong);
        let s_before = engine_strong.test_state(chapter_key).copied().unwrap();
        engine_strong.review(id_strong, Grade::Good, now);
        let s_after_strong = engine_strong.test_state(chapter_key).copied().unwrap();

        let mut engine_weak = make_engine(0.5);
        let id_weak = recitation_id(&engine_weak);
        let w_before = engine_weak.test_state(chapter_key).copied().unwrap();
        engine_weak.review(id_weak, Grade::Good, now);
        let s_after_weak = engine_weak.test_state(chapter_key).copied().unwrap();

        assert_eq!(s_after_strong.last_seen_secs, now);
        assert_eq!(s_after_weak.last_seen_secs, now);
        let strong_growth = s_after_strong.stability / s_before.stability;
        let weak_growth = s_after_weak.stability / w_before.stability;
        assert!(
            weak_growth > strong_growth,
            "low-retr binding should get more relative lift: \
             weak {} → {} (×{:.4}) vs strong {} → {} (×{:.4})",
            w_before.stability,
            s_after_weak.stability,
            weak_growth,
            s_before.stability,
            s_after_strong.stability,
            strong_growth,
        );
    }
}
