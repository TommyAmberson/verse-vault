//! Session-level orchestration on top of `ReviewEngine`.
//!
//! The session is a queue manager: it picks the next card to show, reacts to
//! review outcomes by inserting re-drills, and stages new-verse introductions
//! through a progressive-reveal sequence. All FSRS state lives in the engine —
//! session bookkeeping is purely about ordering and visibility.

use std::collections::HashMap;

use crate::card::{Card, CardKind};
use crate::element::ElementId;
use crate::engine::{ReviewEngine, ReviewOutcome};
use crate::schedule;
use crate::test_kind::{TestKey, TestKind};
use crate::types::{CardId, Grade};

/// A planned slot in the session queue. Mirrors a `Card` but in queue-shaped
/// terms (with a due time) and without persistent state — re-drills and
/// progressive-reveal entries don't have to correspond to engine cards.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SessionCard {
    pub kind: CardKind,
    pub verse_id: u32,
    pub due_at: i64,
}

/// Re-drill flavour. Inserted into the queue after a Recitation lapses.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ReDrillKind {
    FillInBlank { position: u16 },
    FullRecitation,
}

/// What the session wants to do next after a review.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SessionAction {
    ReDrill { verse_id: u32, kind: ReDrillKind },
    NextScheduled,
    Done,
}

/// Bookkeeping for the most-recently-reviewed card. Used by
/// `next_drill_after` to decide whether (and how) to re-drill.
#[derive(Debug, Clone)]
struct InFlight {
    kind: CardKind,
    verse_id: u32,
    grades: HashMap<TestKey, Grade>,
}

#[derive(Debug, Default)]
pub struct Session {
    in_flight: Option<InFlight>,
    upcoming_cards: Vec<Card>,
    /// Last time (in `now_secs`) each test key was graded by `review_card`.
    /// Drives the session-level sibling cooldown filter so an immediately-
    /// following pick can't grade the same test again within the cooldown
    /// window.
    recently_seen_test_keys: HashMap<TestKey, i64>,
}

impl Session {
    pub fn new() -> Self {
        Self::default()
    }

    /// Build a session seeded from the engine's catalog. The initial
    /// `upcoming_cards` queue contains the FTV cards present in the engine
    /// (one per eligible verse, with and without citation). The scheduler
    /// itself still drives card-picking via `next_card`; this queue is used
    /// for high-priority surfaces like FTV.
    pub fn start(engine: &ReviewEngine, _now_secs: i64) -> Self {
        let upcoming_cards = engine
            .cards
            .iter()
            .filter(|c| matches!(c.kind, CardKind::Ftv { .. }))
            .cloned()
            .collect();
        Self {
            in_flight: None,
            upcoming_cards,
            recently_seen_test_keys: HashMap::new(),
        }
    }

    pub fn upcoming_cards(&self) -> &[Card] {
        &self.upcoming_cards
    }

    /// Send a card review through the engine and record session bookkeeping
    /// (in-flight context + per-test cooldown timestamps). Returns the
    /// engine's outcome for the caller to inspect or feed into
    /// `next_drill_after`.
    pub fn review_card(
        &mut self,
        engine: &mut ReviewEngine,
        card_id: CardId,
        grades: HashMap<TestKey, Grade>,
        now_secs: i64,
    ) -> ReviewOutcome {
        let card = engine
            .card(card_id)
            .unwrap_or_else(|| panic!("review_card: unknown card {card_id:?}"))
            .clone();
        for tk in grades.keys() {
            self.recently_seen_test_keys.insert(*tk, now_secs);
        }
        self.in_flight = Some(InFlight {
            kind: card.kind,
            verse_id: card.verse_id,
            grades: grades.clone(),
        });
        engine.review(card_id, grades, now_secs)
    }

    /// Pick the next card to show, applying the engine's scheduling on top of
    /// a session-level cooldown filter: cards whose tests were just graded
    /// inside this session are skipped until the cooldown elapses.
    pub fn next_card<'e>(&self, engine: &'e ReviewEngine, now_secs: i64) -> Option<&'e Card> {
        let cd = engine.schedule_params.sibling_cooldown_secs;
        let mut candidate = schedule::next_card(engine, now_secs);
        // The engine's own cooldown only tracks `last_seen_secs` written by
        // `review`. Session-level cooldown is stricter: we track by exact
        // test-key grade events so we can suppress siblings even if the
        // engine's per-state timestamps drift.
        while let Some(id) = candidate {
            let card = engine.card(id)?;
            let atoms = engine.atoms_for(card.verse_id);
            let overlaps = card.tests(&atoms).iter().any(|tk| {
                self.recently_seen_test_keys
                    .get(tk)
                    .is_some_and(|&t| now_secs - t < cd)
            });
            if !overlaps {
                return Some(card);
            }
            // Fall back: try the engine's next pick after excluding this id.
            // The engine doesn't expose an `exclude` arg; for the in-session
            // overlap case we return None rather than re-implementing the
            // priority loop here. Phase-6 contract is just that immediate
            // siblings are blocked.
            candidate = None;
        }
        None
    }

    /// Record the kind/verse_id and per-test grades for the card just sent
    /// to the engine. Required before `next_drill_after` so the session can
    /// interpret the review outcome.
    pub fn stage_review(&mut self, kind: CardKind, verse_id: u32, grades: HashMap<TestKey, Grade>) {
        self.in_flight = Some(InFlight {
            kind,
            verse_id,
            grades,
        });
    }

    /// The staged sequence for introducing a new verse:
    /// `[Reading, PhraseFill 0, ..., PhraseFill N-1, Recitation]`.
    ///
    /// `verse_id` is currently informational — the returned kinds don't carry
    /// it — but is taken so callers state intent and so we can extend the
    /// signature later without a breaking change.
    pub fn new_verse_progression(&self, _verse_id: u32, phrase_count: u16) -> Vec<CardKind> {
        let mut out = Vec::with_capacity(phrase_count as usize + 2);
        out.push(CardKind::Reading);
        for p in 0..phrase_count {
            out.push(CardKind::PhraseFill { position: p });
        }
        out.push(CardKind::Recitation);
        out
    }

    /// Decide whether to insert a re-drill. Only Recitation reviews trigger
    /// re-drills; other kinds always return `None`.
    ///
    /// Rules for Recitation (where N = phrase tests graded):
    /// - majority failure (`fails >= ceil(N/2)`) → `FullRecitation`
    /// - exactly one failure → `FillInBlank { position }`
    /// - otherwise → `None`
    pub fn next_drill_after(&self, _outcome: ReviewOutcome) -> Option<SessionAction> {
        let in_flight = self.in_flight.as_ref()?;
        if !matches!(in_flight.kind, CardKind::Recitation) {
            return None;
        }
        let phrase_fails: Vec<u16> = in_flight
            .grades
            .iter()
            .filter(|(k, g)| k.kind == TestKind::PhraseFromChain && matches!(g, Grade::Again))
            .filter_map(|(k, _)| match k.element {
                ElementId::Phrase { position, .. } => Some(position),
                _ => None,
            })
            .collect();
        let total_phrase_tests = in_flight
            .grades
            .keys()
            .filter(|k| k.kind == TestKind::PhraseFromChain)
            .count();
        let majority_threshold = total_phrase_tests.div_ceil(2);
        if total_phrase_tests > 0 && phrase_fails.len() >= majority_threshold {
            return Some(SessionAction::ReDrill {
                verse_id: in_flight.verse_id,
                kind: ReDrillKind::FullRecitation,
            });
        }
        if phrase_fails.len() == 1 {
            return Some(SessionAction::ReDrill {
                verse_id: in_flight.verse_id,
                kind: ReDrillKind::FillInBlank {
                    position: phrase_fails[0],
                },
            });
        }
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::builder::build;
    use crate::content::MaterialData;

    fn sample_material_with_ftv() -> MaterialData {
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

    fn phrase_key(verse_id: u32, position: u16) -> TestKey {
        TestKey {
            kind: TestKind::PhraseFromChain,
            element: ElementId::Phrase { verse_id, position },
        }
    }

    fn sample_session_with_recitation_in_progress() -> Session {
        // 4-phrase recitation on verse 7: phrase 1 = Again, others = Good.
        let mut grades = HashMap::new();
        grades.insert(phrase_key(7, 0), Grade::Good);
        grades.insert(phrase_key(7, 1), Grade::Again);
        grades.insert(phrase_key(7, 2), Grade::Good);
        grades.insert(phrase_key(7, 3), Grade::Good);
        let mut s = Session::new();
        s.stage_review(CardKind::Recitation, 7, grades);
        s
    }

    #[test]
    fn session_card_holds_cardkind() {
        let sc = SessionCard {
            kind: CardKind::PhraseFill { position: 1 },
            verse_id: 7,
            due_at: 0,
        };
        assert_eq!(sc.verse_id, 7);
    }

    #[test]
    fn redrill_on_phrase_failure() {
        let s = sample_session_with_recitation_in_progress();
        let next = s.next_drill_after(ReviewOutcome::default());
        assert!(matches!(
            next,
            Some(SessionAction::ReDrill {
                verse_id: 7,
                kind: ReDrillKind::FillInBlank { position: 1 },
            })
        ));
    }

    #[test]
    fn redrill_on_majority_failure() {
        // 3 of 4 phrases failed → trigger full recitation.
        let mut grades = HashMap::new();
        grades.insert(phrase_key(7, 0), Grade::Again);
        grades.insert(phrase_key(7, 1), Grade::Again);
        grades.insert(phrase_key(7, 2), Grade::Again);
        grades.insert(phrase_key(7, 3), Grade::Good);
        let mut s = Session::new();
        s.stage_review(CardKind::Recitation, 7, grades);
        let next = s.next_drill_after(ReviewOutcome::default());
        assert!(matches!(
            next,
            Some(SessionAction::ReDrill {
                verse_id: 7,
                kind: ReDrillKind::FullRecitation,
            })
        ));
    }

    #[test]
    fn new_verse_progresses_reading_then_fill_in_then_recitation() {
        let s = Session::new();
        let progression = s.new_verse_progression(7, 4);
        assert!(matches!(progression[0], CardKind::Reading));
        assert_eq!(
            progression
                .iter()
                .filter(|k| matches!(k, CardKind::PhraseFill { .. }))
                .count(),
            4
        );
        assert!(matches!(progression.last(), Some(CardKind::Recitation)));
    }

    #[test]
    fn session_includes_ftv_card_when_material_has_ftv() {
        let m = sample_material_with_ftv();
        let r = build(&m, 0);
        let engine = ReviewEngine::new(r, 0.9);
        let session = Session::start(&engine, 86400 * 400);
        assert!(
            session
                .upcoming_cards()
                .iter()
                .any(|c| matches!(c.kind, CardKind::Ftv { .. }))
        );
    }

    #[test]
    fn session_cooldown_blocks_sibling_after_review() {
        let m = sample_material_with_ftv();
        let r = build(&m, 0);
        let mut engine = ReviewEngine::new(r, 0.9);
        let now = 86400 * 365;
        let recit_id = engine
            .cards
            .iter()
            .find(|c| matches!(c.kind, CardKind::Recitation))
            .unwrap()
            .id;
        let card = engine.card(recit_id).unwrap().clone();
        let atoms = engine.atoms_for(0);
        let grades: HashMap<TestKey, Grade> = card
            .tests(&atoms)
            .into_iter()
            .map(|t| (t, Grade::Good))
            .collect();
        let mut session = Session::start(&engine, now);
        session.review_card(&mut engine, recit_id, grades, now);
        let next = session.next_card(&engine, now + 60);
        assert!(!matches!(
            next.map(|c| c.kind),
            Some(CardKind::PhraseFill { .. })
        ));
    }

    #[test]
    fn no_redrill_when_all_pass() {
        let mut grades = HashMap::new();
        grades.insert(phrase_key(7, 0), Grade::Good);
        grades.insert(phrase_key(7, 1), Grade::Good);
        let mut s = Session::new();
        s.stage_review(CardKind::Recitation, 7, grades);
        assert!(s.next_drill_after(ReviewOutcome::default()).is_none());
    }
}
