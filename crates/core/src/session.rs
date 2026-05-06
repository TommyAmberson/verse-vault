//! Session-level orchestration on top of `ReviewEngine`.
//!
//! The session is a queue manager: it picks the next card to show, reacts to
//! review outcomes by inserting re-drills, and stages new-verse introductions
//! through a progressive-reveal sequence. All FSRS state lives in the engine —
//! session bookkeeping is purely about ordering and visibility.

use crate::card::CardKind;

/// A planned slot in the session queue. Mirrors a `Card` but in queue-shaped
/// terms (with a due time) and without persistent state — re-drills and
/// progressive-reveal entries don't have to correspond to engine cards.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SessionCard {
    pub kind: CardKind,
    pub verse_id: u32,
    pub due_at: i64,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn session_card_holds_cardkind() {
        let sc = SessionCard {
            kind: CardKind::PhraseFill { position: 1 },
            verse_id: 7,
            due_at: 0,
        };
        assert_eq!(sc.verse_id, 7);
    }
}
