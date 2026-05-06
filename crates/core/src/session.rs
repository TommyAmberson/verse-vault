//! Session-level orchestration on top of `ReviewEngine`.
//!
//! The session is a queue manager: it picks the next card to show, reacts to
//! review outcomes by inserting re-drills, and stages new-verse introductions
//! through a progressive-reveal sequence. All FSRS state lives in the engine —
//! session bookkeeping is purely about ordering and visibility.

use std::collections::HashMap;

use crate::card::CardKind;
use crate::element::ElementId;
use crate::engine::ReviewOutcome;
use crate::test_kind::{TestKey, TestKind};
use crate::types::Grade;

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
}

impl Session {
    pub fn new() -> Self {
        Self::default()
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
    fn no_redrill_when_all_pass() {
        let mut grades = HashMap::new();
        grades.insert(phrase_key(7, 0), Grade::Good);
        grades.insert(phrase_key(7, 1), Grade::Good);
        let mut s = Session::new();
        s.stage_review(CardKind::Recitation, 7, grades);
        assert!(s.next_drill_after(ReviewOutcome::default()).is_none());
    }
}
