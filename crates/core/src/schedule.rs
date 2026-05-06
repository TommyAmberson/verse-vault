use crate::card::Card;
use crate::engine::ReviewEngine;
use crate::types::CardId;

impl ReviewEngine {
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
/// Cards above target are skipped — they're not yet due.
pub fn next_card(engine: &ReviewEngine, now_secs: i64) -> Option<CardId> {
    engine
        .cards
        .iter()
        .filter_map(|c| Some((c.id, engine.card_min_r(c, now_secs)?)))
        .filter(|(_, r)| *r < engine.schedule_params.target_retention)
        .min_by(|(_, a), (_, b)| a.partial_cmp(b).unwrap())
        .map(|(id, _)| id)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::content::MaterialData;

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
