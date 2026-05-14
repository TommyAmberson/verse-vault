use crate::card::{Card, CardState};
use crate::engine::ReviewEngine;
use crate::types::CardId;

impl ReviewEngine {
    /// True when any test this card grades was touched (directly or via
    /// propagation) within `schedule_params.sibling_cooldown_secs`.
    /// Used to suppress reviews of overlapping cards inside one session.
    pub fn is_in_cooldown(&self, card_id: CardId, now_secs: i64) -> bool {
        let card = match self.card(card_id) {
            Some(c) => c,
            None => return false,
        };
        let atoms = self.atoms_for(card.verse_id);
        let cd = self.schedule_params.sibling_cooldown_secs;
        card.tests(&atoms).iter().any(|tk| {
            self.tests
                .get(tk)
                .is_some_and(|s| now_secs - s.last_seen_secs < cd)
        })
    }

    /// The minimum predicted retrievability across this card's tests, at
    /// `now_secs`. The card is "due" when this falls below the scheduler's
    /// target retention. Returns None if the card has no tests with state.
    pub fn card_min_r(&self, card: &Card, now_secs: i64) -> Option<f32> {
        let atoms = self.atoms_for(card.verse_id);
        let r_values: Vec<f32> = card
            .tests(&atoms)
            .into_iter()
            .filter_map(|tk| {
                self.tests
                    .get(&tk)
                    .map(|s| self.fsrs.retrievability_of(s, now_secs))
            })
            .collect();
        r_values
            .into_iter()
            .min_by(|a, b| a.partial_cmp(b).unwrap())
    }
}

/// Pick the next due card, ordered by **descending retrievability** of the
/// card's weakest test. Cards at or above `schedule_params.target_retention`
/// are skipped (not yet due); cards in sibling cooldown are skipped. Returns
/// `None` when no card is both due and out of cooldown.
///
/// High-R-first matches the FSRS-author recommendation for capacity-limited
/// sessions: well-known-but-due cards clear cheaply and bank their gains,
/// while at-risk cards left for later get re-scheduled by FSRS regardless.
/// Sims report ~1–5pp retention edge over ascending-R for non-finishers and
/// no difference for users who finish their queue.
///
/// See `docs/scheduling.md` for the full per-test FSRS scheduling story.
pub fn next_card(engine: &ReviewEngine, now_secs: i64) -> Option<CardId> {
    engine
        .cards
        .iter()
        .filter(|c| matches!(c.state, CardState::Active))
        .filter(|c| !engine.is_in_cooldown(c.id, now_secs))
        .filter_map(|c| Some((c.id, engine.card_min_r(c, now_secs)?)))
        .filter(|(_, r)| *r < engine.schedule_params.target_retention)
        .max_by(|(_, a), (_, b)| a.partial_cmp(b).unwrap())
        .map(|(id, _)| id)
}

/// Pick the next card from the memorize queue: any `New` card. Returns one
/// canonical card per call; the caller is expected to walk the per-verse
/// progression client-side (see [`crate::session::Session::new_verse_progression`])
/// and then graduate the verse via [`ReviewEngine::graduate_verse`].
///
/// Cooldown and FSRS due time don't apply — `New` cards have never been
/// reviewed. Ties broken by `CardId` (insertion order), which means the
/// memorize queue surfaces cards in the same order the builder emitted
/// them (early verses first).
pub fn next_memorize_card(engine: &ReviewEngine, _now_secs: i64) -> Option<CardId> {
    engine
        .cards
        .iter()
        .find(|c| matches!(c.state, CardState::New))
        .map(|c| c.id)
}

/// Pick a card from the relearning priority lane: any `Active` card that has
/// at least one test with `pending_relearn = true` whose FSRS-computed due
/// time has elapsed. Bypasses the sibling cooldown — a freshly-lapsed card
/// is exactly what we want the user re-drilling, even if another card in the
/// session just touched a shared test.
///
/// Returns `None` when no lane card is due. Ties broken by earliest due time
/// (the lapse a learner has been kept waiting longest gets cleared first).
pub fn next_relearn_card(engine: &ReviewEngine, now_secs: i64) -> Option<CardId> {
    let target = engine.schedule_params.target_retention;
    engine
        .cards
        .iter()
        .filter(|c| matches!(c.state, CardState::Active))
        .filter_map(|c| {
            let atoms = engine.atoms_for(c.verse_id);
            let earliest_due = c
                .tests(&atoms)
                .into_iter()
                .filter_map(|tk| {
                    let state = engine.tests.get(&tk)?;
                    if !state.pending_relearn {
                        return None;
                    }
                    let due = engine.fsrs.due_at(state, target);
                    (due <= now_secs).then_some(due)
                })
                .min()?;
            Some((c.id, earliest_due))
        })
        .min_by_key(|(_, due)| *due)
        .map(|(id, _)| id)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::card::CardKind;
    use crate::content::MaterialData;
    use crate::types::Grade;

    fn sample_material_one_verse() -> MaterialData {
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

    fn sample_material_two_verses() -> MaterialData {
        serde_json::from_str(
            r#"{
                "year": 3,
                "books": ["John"],
                "chapters": [
                    {"book": "John", "number": 3, "start_verse": 16, "end_verse": 17}
                ],
                "verses": [
                    {
                        "book": "John", "chapter": 3, "verse": 16,
                        "phraseWordCounts": [2, 2],
                        "annotations": [],
                        "ftvWordCount": null,
                        "clubs": []
                    },
                    {
                        "book": "John", "chapter": 3, "verse": 17,
                        "phraseWordCounts": [2, 3],
                        "annotations": [],
                        "ftvWordCount": null,
                        "clubs": []
                    }
                ],
                "headings": []
            }"#,
        )
        .unwrap()
    }

    #[test]
    fn next_card_returns_some_when_seeded_unseen_advanced_a_year() {
        let m = sample_material_two_verses();
        // build at t=0; seeds last_base = -365 days. At now_secs = 0, the
        // forgetting curve has had 365 days to decay, so retrievability is
        // far below the 0.9 target and `next_card` should return Some.
        let r = crate::builder::build(&m, 0);
        let mut engine = ReviewEngine::new(r, 0.9);
        engine.graduate_all();
        let now = 86400 * 365 + 86400 * 60;
        let pick = next_card(&engine, now);
        assert!(pick.is_some());
    }

    #[test]
    fn next_card_skips_new_cards() {
        let m = sample_material_two_verses();
        let r = crate::builder::build(&m, 0);
        let engine = ReviewEngine::new(r, 0.9);
        // No graduation: every card is `New`. `next_card` is a review-only
        // function, so it must return None.
        assert!(next_card(&engine, 86400 * 400).is_none());
    }

    #[test]
    fn next_memorize_card_returns_new_card() {
        let m = sample_material_two_verses();
        let r = crate::builder::build(&m, 0);
        let engine = ReviewEngine::new(r, 0.9);
        assert!(next_memorize_card(&engine, 0).is_some());
    }

    #[test]
    fn graduate_verse_flips_state_and_unblocks_review() {
        let m = sample_material_one_verse();
        let r = crate::builder::build(&m, 0);
        let mut engine = ReviewEngine::new(r, 0.9);
        let count = engine.graduate_verse(0);
        assert!(count > 0);
        // Idempotent.
        assert_eq!(engine.graduate_verse(0), 0);
        // After graduation /memorize empties for that verse and /review
        // sees the cards.
        assert!(next_memorize_card(&engine, 0).is_none());
        assert!(next_card(&engine, 86400 * 400).is_some());
    }

    #[test]
    fn recitation_cools_down_phrasefill_via_shared_test() {
        let m = sample_material_one_verse();
        let r = crate::builder::build(&m, 0);
        let mut engine = ReviewEngine::new(r, 0.9);
        let now = 86400 * 365;
        let recit_id = engine
            .cards
            .iter()
            .find(|c| matches!(c.kind, CardKind::Recitation))
            .unwrap()
            .id;
        engine.review(recit_id, Grade::Good, now);

        let pf_id = engine
            .cards
            .iter()
            .find(|c| matches!(c.kind, CardKind::PhraseFill { .. }))
            .unwrap()
            .id;
        // Recitation and PhraseFill now share the same PhraseFromContext
        // test per phrase, so reviewing Recitation puts every PhraseFill on
        // cooldown — we don't want the user drilling the same phrase twice
        // back-to-back.
        assert!(engine.is_in_cooldown(pf_id, now + 60));
    }

    #[test]
    fn relearn_lane_empty_before_pending_relearn_due_elapsed() {
        // Grade Again at t=now; the FSRS post-failure interval is ~6h, so the
        // lane should not surface the card until that interval elapses.
        let m = sample_material_one_verse();
        let r = crate::builder::build(&m, 0);
        let mut engine = ReviewEngine::new(r, 0.9);
        engine.graduate_all();
        let now = 86400 * 365;
        let card_id = engine
            .cards
            .iter()
            .find(|c| matches!(c.kind, CardKind::PhraseFill { .. }))
            .unwrap()
            .id;
        engine.review(card_id, Grade::Again, now);
        // 1 minute later — well before the 6h FSRS sub-day interval.
        assert!(next_relearn_card(&engine, now + 60).is_none());
    }

    #[test]
    fn relearn_lane_surfaces_card_once_fsrs_due_time_elapses() {
        let m = sample_material_one_verse();
        let r = crate::builder::build(&m, 0);
        let mut engine = ReviewEngine::new(r, 0.9);
        engine.graduate_all();
        let now = 86400 * 365;
        let card_id = engine
            .cards
            .iter()
            .find(|c| matches!(c.kind, CardKind::PhraseFill { .. }))
            .unwrap()
            .id;
        engine.review(card_id, Grade::Again, now);
        // A day later — well past the 6h post-failure interval.
        assert_eq!(next_relearn_card(&engine, now + 86400), Some(card_id));
    }

    #[test]
    fn relearn_lane_skips_new_cards() {
        // A New card's pending_relearn flag should not surface in the lane:
        // the lane is review-only.
        let m = sample_material_one_verse();
        let r = crate::builder::build(&m, 0);
        let mut engine = ReviewEngine::new(r, 0.9);
        let now = 86400 * 365;
        let card_id = engine
            .cards
            .iter()
            .find(|c| matches!(c.kind, CardKind::PhraseFill { .. }))
            .unwrap()
            .id;
        // No graduation: card stays New. Forcibly set pending_relearn anyway.
        let key = engine.card(card_id).unwrap().tests(&engine.atoms_for(0))[0];
        engine.tests.get_mut(&key).unwrap().pending_relearn = true;
        engine.tests.get_mut(&key).unwrap().stability = 0.25;
        engine.tests.get_mut(&key).unwrap().last_base_secs = now - 86400;
        assert!(next_relearn_card(&engine, now).is_none());
    }

    #[test]
    fn relearn_lane_bypasses_sibling_cooldown() {
        // Lapse a card, wait past the FSRS sub-day due time, then re-touch
        // one of its shared tests so the cooldown filter would mask it. The
        // lane must still surface it — defeating that mask is the lane's
        // only job.
        let m = sample_material_one_verse();
        let r = crate::builder::build(&m, 0);
        let mut engine = ReviewEngine::new(r, 0.9);
        engine.graduate_all();
        let now = 86400 * 365;
        let pf_id = engine
            .cards
            .iter()
            .find(|c| matches!(c.kind, CardKind::PhraseFill { .. }))
            .unwrap()
            .id;
        engine.review(pf_id, Grade::Again, now);
        let later = now + 86400;
        let touched_test = engine.card(pf_id).unwrap().tests(&engine.atoms_for(0))[0];
        engine.tests.get_mut(&touched_test).unwrap().last_seen_secs = later - 60;
        assert!(engine.is_in_cooldown(pf_id, later));
        assert_eq!(next_relearn_card(&engine, later), Some(pf_id));
    }

    #[test]
    fn relearn_lane_clears_after_passing_grade() {
        let m = sample_material_one_verse();
        let r = crate::builder::build(&m, 0);
        let mut engine = ReviewEngine::new(r, 0.9);
        engine.graduate_all();
        let now = 86400 * 365;
        let card_id = engine
            .cards
            .iter()
            .find(|c| matches!(c.kind, CardKind::PhraseFill { .. }))
            .unwrap()
            .id;
        engine.review(card_id, Grade::Again, now);
        // Pass after the FSRS due window — lane should clear.
        engine.review(card_id, Grade::Good, now + 86400);
        assert!(next_relearn_card(&engine, now + 2 * 86400).is_none());
    }

    #[test]
    fn next_card_orders_by_descending_retrievability() {
        // Two cards both below target_retention. The one with the *higher*
        // R (closer to remembered) should surface first per the FSRS-author-
        // recommended ordering.
        let m = sample_material_two_verses();
        let r = crate::builder::build(&m, 0);
        let mut engine = ReviewEngine::new(r, 0.9);
        engine.graduate_all();
        let now = 86400 * 365 + 86400 * 60;

        // Pick two PhraseFill cards from different verses to avoid sibling
        // cooldown interactions. Boost one card's stability so its R is
        // higher (closer to 1) at `now` than the other's.
        let pfs: Vec<_> = engine
            .cards
            .iter()
            .filter(|c| matches!(c.kind, CardKind::PhraseFill { .. }))
            .map(|c| (c.id, c.verse_id))
            .collect();
        let (high_r_id, _) = pfs.iter().find(|(_, v)| *v == 0).copied().unwrap();
        let (low_r_id, _) = pfs.iter().find(|(_, v)| *v == 1).copied().unwrap();
        let high_test = engine.card(high_r_id).unwrap().tests(&engine.atoms_for(0))[0];
        engine.tests.get_mut(&high_test).unwrap().stability = 100.0; // high R at `now`

        let pick = next_card(&engine, now).expect("a card should be due");
        assert_eq!(pick, high_r_id, "high-R card must surface before low-R");
        assert_ne!(pick, low_r_id);
    }

    #[test]
    fn next_card_returns_none_when_all_above_target() {
        // After build at t=now, every state's last_base is at now-365 days
        // with stability 1.0. At now (the build time), retrievability has
        // decayed for 365 days. Use a very-low target so all cards fall
        // above it → next_card should return None.
        let m = sample_material_two_verses();
        let r = crate::builder::build(&m, 86400 * 365);
        let mut engine = ReviewEngine::new(r, 0.9);
        engine.schedule_params.target_retention = 0.0;
        let pick = next_card(&engine, 86400 * 365);
        assert!(pick.is_none());
    }
}
