//! Session-level orchestration on top of `ReviewEngine`.
//!
//! The session is a queue manager: it picks the next card to show, reacts to
//! review outcomes by inserting re-drills, and stages new-verse introductions
//! through a progressive-reveal sequence. All FSRS state lives in the engine —
//! session bookkeeping is purely about ordering and visibility.

use crate::card::{Card, CardKind};
use crate::engine::{ReviewEngine, ReviewOutcome};
use crate::schedule;
use crate::types::{CardId, Grade};

// Cooldown lives on the engine: every `update` advances `last_seen_secs`,
// and `schedule::next_card` filters cards via `engine.is_in_cooldown`
// against that field. The session shouldn't keep a parallel timestamp
// map — it would duplicate information already on `engine.tests`.

/// A planned slot in the session queue. Mirrors a `Card` but in queue-shaped
/// terms (with a due time) and without persistent state — re-drills and
/// progressive-reveal entries don't have to correspond to engine cards.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SessionCard {
    pub kind: CardKind,
    pub verse_id: u32,
    pub due_at: i64,
}

/// Re-drill flavour. Inserted into the queue after an `Again`. With the
/// single-grade-per-card pipeline there's no way to tell *which* phrase the
/// learner missed, so the only sensible recovery is re-queueing the same
/// card later in the session.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ReDrillKind {
    SameCard { kind: CardKind },
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
#[derive(Debug, Clone, Copy)]
struct InFlight {
    kind: CardKind,
    verse_id: u32,
}

#[derive(Debug, Default)]
pub struct Session {
    in_flight: Option<InFlight>,
    upcoming_cards: Vec<Card>,
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
        }
    }

    pub fn upcoming_cards(&self) -> &[Card] {
        &self.upcoming_cards
    }

    /// Send a card review through the engine and stash the in-flight context
    /// so `next_drill_after` can interpret the outcome.
    pub fn review_card(
        &mut self,
        engine: &mut ReviewEngine,
        card_id: CardId,
        grade: Grade,
        now_secs: i64,
    ) -> ReviewOutcome {
        let card = engine
            .card(card_id)
            .unwrap_or_else(|| panic!("review_card: unknown card {card_id:?}"))
            .clone();
        self.in_flight = Some(InFlight {
            kind: card.kind,
            verse_id: card.verse_id,
        });
        engine.review(card_id, grade, now_secs)
    }

    /// Pick the next card to review. Priority order:
    ///
    /// 1. **Relearning lane** — any `Active` card whose any test has
    ///    `pending_relearn = true` and whose FSRS sub-day due time has
    ///    elapsed. Bypasses the sibling cooldown so a freshly-lapsed card
    ///    is re-drilled even when another card in the session just touched
    ///    a shared test.
    /// 2. **Regular schedule** — `schedule::next_card`, the descending-R
    ///    review queue with cooldown enforcement.
    ///
    /// The FTV queue (`upcoming_cards`) is exposed for the UI to surface
    /// independently; the scheduler doesn't drain it.
    pub fn next_card<'e>(&self, engine: &'e ReviewEngine, now_secs: i64) -> Option<&'e Card> {
        if let Some(id) = schedule::next_relearn_card(engine, now_secs) {
            return engine.card(id);
        }
        let id = schedule::next_card(engine, now_secs)?;
        engine.card(id)
    }

    /// Record the kind/verse_id of the card just sent to the engine.
    /// Required before `next_drill_after` so the session can interpret the
    /// review outcome.
    pub fn stage_review(&mut self, kind: CardKind, verse_id: u32) {
        self.in_flight = Some(InFlight { kind, verse_id });
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

    /// Decide whether to insert a re-drill. With a single grade per card,
    /// any `Again` re-queues the same card; anything else returns `None`.
    pub fn next_drill_after(&mut self, grade: Grade) -> Option<SessionAction> {
        let in_flight = self.in_flight.take()?;
        if grade == Grade::Again {
            Some(SessionAction::ReDrill {
                verse_id: in_flight.verse_id,
                kind: ReDrillKind::SameCard {
                    kind: in_flight.kind,
                },
            })
        } else {
            None
        }
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
    fn redrill_on_again_requeues_same_card() {
        let mut s = Session::new();
        s.stage_review(CardKind::Recitation, 7);
        let next = s.next_drill_after(Grade::Again);
        assert!(matches!(
            next,
            Some(SessionAction::ReDrill {
                verse_id: 7,
                kind: ReDrillKind::SameCard {
                    kind: CardKind::Recitation,
                },
            })
        ));
    }

    #[test]
    fn no_redrill_when_pass() {
        let mut s = Session::new();
        s.stage_review(CardKind::Recitation, 7);
        assert!(s.next_drill_after(Grade::Good).is_none());
    }

    #[test]
    fn redrill_works_for_atomic_cards_too() {
        // Any kind triggers a SameCard re-drill on Again — the session no
        // longer special-cases Recitation.
        let mut s = Session::new();
        s.stage_review(CardKind::PhraseFill { position: 2 }, 7);
        let next = s.next_drill_after(Grade::Again);
        assert!(matches!(
            next,
            Some(SessionAction::ReDrill {
                verse_id: 7,
                kind: ReDrillKind::SameCard {
                    kind: CardKind::PhraseFill { position: 2 },
                },
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
    fn session_next_card_returns_lane_card_before_regular_schedule() {
        // Lapse a card and advance time past the FSRS sub-day due. The
        // session must hand the lane card back before consulting the
        // descending-R review queue. This is the load-bearing wiring for
        // /review surfacing freshly-lapsed cards within minutes.
        let m = sample_material_with_ftv();
        let r = build(&m, 0);
        let mut engine = ReviewEngine::new(r, 0.9);
        let verse_ids: Vec<u32> = engine.cards.iter().map(|c| c.verse_id).collect();
        for v in verse_ids {
            engine.graduate_verse(v);
        }
        let pf_id = engine
            .cards
            .iter()
            .find(|c| matches!(c.kind, CardKind::PhraseFill { .. }))
            .unwrap()
            .id;
        let now = 86400 * 365;
        engine.review(pf_id, Grade::Again, now);

        let session = Session::start(&engine, now);
        let later = now + 86400;
        let pick = session.next_card(&engine, later).unwrap();
        assert_eq!(pick.id, pf_id, "lane card must surface ahead of schedule");
    }

    #[test]
    fn session_cooldown_blocks_overlapping_card_after_review() {
        // After grading Recitation (which contains the chapter binding
        // test), the VerseInChapter card — whose only test is that same
        // binding — must be in cooldown. Pick the next card and assert
        // it's not VerseInChapter.
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
        let mut session = Session::start(&engine, now);
        session.review_card(&mut engine, recit_id, Grade::Good, now);
        let next = session.next_card(&engine, now + 60);
        assert!(!matches!(
            next.map(|c| c.kind),
            Some(CardKind::VerseInChapter)
        ));
    }
}
