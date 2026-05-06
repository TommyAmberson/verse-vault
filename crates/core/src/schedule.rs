use crate::card::Card;
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

/// Pick the card whose weakest test is furthest below the target retention.
/// Cards above target are skipped — they're not yet due. Cards whose tests
/// were touched within the sibling cooldown are also skipped.
pub fn next_card(engine: &ReviewEngine, now_secs: i64) -> Option<CardId> {
    engine
        .cards
        .iter()
        .filter(|c| !engine.is_in_cooldown(c.id, now_secs))
        .filter_map(|c| Some((c.id, engine.card_min_r(c, now_secs)?)))
        .filter(|(_, r)| *r < engine.schedule_params.target_retention)
        .min_by(|(_, a), (_, b)| a.partial_cmp(b).unwrap())
        .map(|(id, _)| id)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::card::CardKind;
    use crate::content::MaterialData;
    use crate::test_kind::TestKey;
    use crate::types::Grade;
    use std::collections::HashMap;

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
                        "text": "For God so loved",
                        "phrases": ["For God", "so loved"],
                        "ftv": "",
                        "clubs": []
                    },
                    {
                        "book": "John", "chapter": 3, "verse": 17,
                        "text": "For God did not send",
                        "phrases": ["For God", "did not send"],
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
    fn next_card_returns_some_when_seeded_unseen_advanced_a_year() {
        let m = sample_material_two_verses();
        // build at t=0; seeds last_base = -365 days. At now_secs = 0, the
        // forgetting curve has had 365 days to decay, so retrievability is
        // far below the 0.9 target and `next_card` should return Some.
        let r = crate::builder::build(&m, 0);
        let engine = ReviewEngine::new(r, 0.9);
        let now = 86400 * 365 + 86400 * 60;
        let pick = next_card(&engine, now);
        assert!(pick.is_some());
    }

    #[test]
    fn sibling_cooldown_blocks_phrasefill_after_recitation() {
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
        let atoms = engine.atoms_for(0);
        let card = engine.card(recit_id).unwrap().clone();
        let grades: HashMap<TestKey, Grade> = card
            .tests(&atoms)
            .into_iter()
            .map(|t| (t, Grade::Good))
            .collect();
        engine.review(recit_id, grades, now);

        let pf_id = engine
            .cards
            .iter()
            .find(|c| matches!(c.kind, CardKind::PhraseFill { .. }))
            .unwrap()
            .id;
        // Recitation grades all PhraseFromChain phrases directly. Phrase from
        // PhraseFill (PhraseFromContext) gets propagated through the sibling
        // edge → its last_seen also advances. So the PhraseFill card is in
        // cooldown one minute after the Recitation.
        assert!(engine.is_in_cooldown(pf_id, now + 60));
        // One day later (default cooldown is 30 minutes), it's free again.
        assert!(!engine.is_in_cooldown(pf_id, now + 86400));
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
