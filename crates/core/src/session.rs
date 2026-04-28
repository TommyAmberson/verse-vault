use std::collections::{HashMap, VecDeque};

use crate::card::{Card, CardState};
use crate::credit::EdgeUpdate;
use crate::engine::ReviewEngine;
use crate::types::{CardId, Grade, NodeId};

fn card_overlaps_verse(card: &Card, verse_phrases: &[NodeId]) -> bool {
    card.hidden.iter().any(|h| verse_phrases.contains(h))
        || card.shown.iter().any(|s| verse_phrases.contains(s))
}

#[derive(Clone)]
pub struct SessionParams {
    pub max_session_size: usize,
    pub max_new_verses: usize,
    pub fail_ratio_for_full_recitation: f32,
}

impl Default for SessionParams {
    fn default() -> Self {
        Self {
            max_session_size: 20,
            max_new_verses: 3,
            fail_ratio_for_full_recitation: 0.5,
        }
    }
}

// --- Re-drill ---

#[derive(Debug, Clone)]
pub enum ReDrillKind {
    FillInBlank { target_atom: NodeId },
    FullRecitation,
}

#[derive(Debug, Clone)]
pub struct ReDrill {
    pub kind: ReDrillKind,
    pub verse_ref: NodeId,
    /// Parent refs for the verse, if the graph carries the chapter/book
    /// layers. Populated alongside `verse_ref` so card rendering carries the
    /// full ref triple. Both fields are `Some` together or both `None`.
    pub chapter_ref: Option<NodeId>,
    pub book_ref: Option<NodeId>,
    pub verse_phrases: Vec<NodeId>,
    pub origin_card: Option<CardId>,
}

fn ref_triple(book: Option<NodeId>, chapter: Option<NodeId>, verse: NodeId) -> Vec<NodeId> {
    let mut out = Vec::with_capacity(3);
    if let Some(b) = book {
        out.push(b);
    }
    if let Some(c) = chapter {
        out.push(c);
    }
    out.push(verse);
    out
}

impl ReDrill {
    pub fn to_session_card(&self) -> SessionCard {
        match &self.kind {
            ReDrillKind::FillInBlank { target_atom } => {
                let mut shown = ref_triple(self.book_ref, self.chapter_ref, self.verse_ref);
                shown.extend(
                    self.verse_phrases
                        .iter()
                        .copied()
                        .filter(|p| p != target_atom),
                );
                SessionCard {
                    shown,
                    hidden: vec![*target_atom],
                    is_reading: false,
                    source: SessionCardSource::ReDrill,
                }
            }
            ReDrillKind::FullRecitation => SessionCard {
                shown: ref_triple(self.book_ref, self.chapter_ref, self.verse_ref),
                hidden: self.verse_phrases.clone(),
                is_reading: false,
                source: SessionCardSource::ReDrill,
            },
        }
    }
}

// --- Progressive reveal ---

#[derive(Debug, Clone)]
pub enum RevealStage {
    Reading,
    FillInBlank { index: usize },
    FullRecitation,
    Complete,
}

#[derive(Debug, Clone)]
pub struct NewVerseProgress {
    pub verse_ref: NodeId,
    pub chapter_ref: Option<NodeId>,
    pub book_ref: Option<NodeId>,
    pub verse_phrases: Vec<NodeId>,
    pub stage: RevealStage,
}

impl NewVerseProgress {
    pub fn to_session_card(&self) -> SessionCard {
        match &self.stage {
            RevealStage::Reading => {
                let mut shown = ref_triple(self.book_ref, self.chapter_ref, self.verse_ref);
                shown.extend(self.verse_phrases.iter().copied());
                SessionCard {
                    shown,
                    hidden: vec![],
                    is_reading: true,
                    source: SessionCardSource::NewVerse,
                }
            }
            RevealStage::FillInBlank { index } => {
                let target = self.verse_phrases[*index];
                let mut shown = ref_triple(self.book_ref, self.chapter_ref, self.verse_ref);
                shown.extend(self.verse_phrases.iter().copied().filter(|&p| p != target));
                SessionCard {
                    shown,
                    hidden: vec![target],
                    is_reading: false,
                    source: SessionCardSource::NewVerse,
                }
            }
            RevealStage::FullRecitation => SessionCard {
                shown: ref_triple(self.book_ref, self.chapter_ref, self.verse_ref),
                hidden: self.verse_phrases.clone(),
                is_reading: false,
                source: SessionCardSource::NewVerse,
            },
            RevealStage::Complete => SessionCard {
                shown: vec![],
                hidden: vec![],
                is_reading: false,
                source: SessionCardSource::NewVerse,
            },
        }
    }

    fn advance(&mut self) {
        self.stage = match &self.stage {
            RevealStage::Reading => RevealStage::FillInBlank { index: 0 },
            RevealStage::FillInBlank { index } => {
                if *index + 1 < self.verse_phrases.len() {
                    RevealStage::FillInBlank { index: index + 1 }
                } else {
                    RevealStage::FullRecitation
                }
            }
            RevealStage::FullRecitation => RevealStage::Complete,
            RevealStage::Complete => RevealStage::Complete,
        };
    }
}

// --- Session ---

#[derive(Debug, Clone)]
pub enum SessionEntry {
    Scheduled(CardId),
    ReDrill(ReDrill),
    NewVerse(NewVerseProgress),
}

#[derive(Debug, Clone)]
pub enum SessionCardSource {
    Scheduled(CardId),
    ReDrill,
    NewVerse,
}

#[derive(Debug, Clone)]
pub struct SessionCard {
    pub shown: Vec<NodeId>,
    pub hidden: Vec<NodeId>,
    pub is_reading: bool,
    pub source: SessionCardSource,
}

pub struct ReviewOutcome {
    pub edge_updates: Vec<EdgeUpdate>,
    pub redrills_inserted: usize,
}

pub struct Session {
    queue: VecDeque<SessionEntry>,
    reviews_completed: u32,
    params: SessionParams,
    /// Verse phrases for each verse introduced this session (for abort rollback).
    introduced_verses: Vec<Vec<NodeId>>,
}

/// Info needed to introduce a new verse.
#[derive(Clone)]
pub struct NewVerseInfo {
    pub verse_ref: NodeId,
    pub verse_phrases: Vec<NodeId>,
}

impl Session {
    pub fn new(
        engine: &mut ReviewEngine,
        now_secs: i64,
        params: SessionParams,
        new_verses: &[NewVerseInfo],
    ) -> Self {
        let mut queue = VecDeque::new();

        // Add due Review cards sorted by priority (skip New/Learning/Relearning)
        let mut due: Vec<_> = engine
            .schedules
            .iter()
            .filter(|s| {
                s.due_date_secs <= now_secs
                    && engine
                        .card(s.card_id)
                        .is_some_and(|c| c.state == CardState::Review)
            })
            .collect();
        due.sort_by(|a, b| b.priority.partial_cmp(&a.priority).unwrap());

        let max_scheduled = params
            .max_session_size
            .saturating_sub(new_verses.len().min(params.max_new_verses) * 4);
        for sched in due.iter().take(max_scheduled) {
            queue.push_back(SessionEntry::Scheduled(sched.card_id));
        }

        // Add new verses (progressive reveal) and transition their cards to Learning
        let mut introduced_verses = Vec::new();
        for nv in new_verses.iter().take(params.max_new_verses) {
            for card in &mut engine.cards {
                if card.state == CardState::New && card_overlaps_verse(card, &nv.verse_phrases) {
                    card.state = CardState::Learning;
                }
            }
            introduced_verses.push(nv.verse_phrases.clone());
            let (chapter_ref, book_ref) = match engine.graph.verse_ref_parents(nv.verse_ref) {
                Some((cr, br)) => (Some(cr), Some(br)),
                None => (None, None),
            };
            queue.push_back(SessionEntry::NewVerse(NewVerseProgress {
                verse_ref: nv.verse_ref,
                chapter_ref,
                book_ref,
                verse_phrases: nv.verse_phrases.clone(),
                stage: RevealStage::Reading,
            }));
        }

        Self {
            queue,
            reviews_completed: 0,
            params,
            introduced_verses,
        }
    }

    pub fn is_done(&self) -> bool {
        self.queue.is_empty()
    }

    pub fn remaining(&self) -> usize {
        self.queue.len()
    }

    /// Abort the session, rolling back Learning cards to New.
    /// Cards that already completed progressive reveal (now Review) are not rolled back.
    pub fn abort(self, engine: &mut ReviewEngine) {
        for phrases in &self.introduced_verses {
            for card in &mut engine.cards {
                if card.state == CardState::Learning && card_overlaps_verse(card, phrases) {
                    card.state = CardState::New;
                }
            }
        }
    }

    /// Peek at the next card to present. Returns None if session is done.
    /// Does NOT consume the entry — call record_review() after grading.
    pub fn next(&self) -> Option<SessionCard> {
        let entry = self.queue.front()?;
        match entry {
            SessionEntry::Scheduled(card_id) => Some(SessionCard {
                shown: vec![], // caller fills from engine.card(card_id)
                hidden: vec![],
                is_reading: false,
                source: SessionCardSource::Scheduled(*card_id),
            }),
            SessionEntry::ReDrill(rd) => Some(rd.to_session_card()),
            SessionEntry::NewVerse(nv) => Some(nv.to_session_card()),
        }
    }

    /// Process grades from the current review (front of queue).
    /// Runs credit assignment, updates edges, inserts re-drills for lapses.
    pub fn record_review(
        &mut self,
        grades: HashMap<NodeId, Grade>,
        engine: &mut ReviewEngine,
        now_secs: i64,
    ) -> ReviewOutcome {
        let entry = match self.queue.pop_front() {
            Some(e) => e,
            None => {
                return ReviewOutcome {
                    edge_updates: vec![],
                    redrills_inserted: 0,
                };
            }
        };

        self.reviews_completed += 1;

        match entry {
            SessionEntry::Scheduled(card_id) => {
                let has_failures = grades.values().any(|g| !g.is_pass());
                let updates = engine.review(card_id, grades.clone(), now_secs);
                let redrills = self.insert_redrills_for_failures(&grades, engine, Some(card_id));
                // Lapse: transition Review → Relearning
                if has_failures {
                    engine.set_card_state(card_id, CardState::Relearning);
                }
                self.prune_no_longer_due(engine, now_secs);
                ReviewOutcome {
                    edge_updates: updates,
                    redrills_inserted: redrills,
                }
            }
            SessionEntry::ReDrill(redrill) => {
                let card = redrill.to_session_card();
                let all_passed = grades.values().all(|g| g.is_pass());
                let updates =
                    engine.review_transient(&card.shown, &card.hidden, grades.clone(), now_secs);
                let redrills =
                    self.insert_redrills_for_failures(&grades, engine, redrill.origin_card);
                // Re-drill success: find the original card and transition Relearning → Review
                if all_passed {
                    self.transition_relearning_to_review(&redrill, engine);
                }
                self.prune_no_longer_due(engine, now_secs);
                ReviewOutcome {
                    edge_updates: updates,
                    redrills_inserted: redrills,
                }
            }
            SessionEntry::NewVerse(mut progress) => {
                if progress.is_reading() {
                    // Reading stage: no grading, just advance
                    progress.advance();
                    self.queue.push_front(SessionEntry::NewVerse(progress));
                    return ReviewOutcome {
                        edge_updates: vec![],
                        redrills_inserted: 0,
                    };
                }

                // Build a transient card for credit assignment
                let card = progress.to_session_card();
                let updates =
                    engine.review_transient(&card.shown, &card.hidden, grades.clone(), now_secs);

                let failed: Vec<NodeId> = grades
                    .iter()
                    .filter(|(_, g)| !g.is_pass())
                    .map(|(id, _)| *id)
                    .collect();

                if failed.is_empty() {
                    progress.advance();
                    if matches!(progress.stage, RevealStage::Complete) {
                        // Progressive reveal done — transition all cards for this
                        // verse from New/Learning to Review
                        for card in &mut engine.cards {
                            if card_overlaps_verse(card, &progress.verse_phrases)
                                && (card.state == CardState::New
                                    || card.state == CardState::Learning)
                            {
                                card.state = CardState::Review;
                            }
                        }
                    } else {
                        self.queue.push_front(SessionEntry::NewVerse(progress));
                    }
                    ReviewOutcome {
                        edge_updates: updates,
                        redrills_inserted: 0,
                    }
                } else {
                    // Insert re-drills for failed phrases, then retry current stage
                    let redrills = self.insert_redrills_from_context(
                        &failed,
                        progress.verse_ref,
                        progress.chapter_ref,
                        progress.book_ref,
                        &progress.verse_phrases,
                        None,
                    );
                    // Re-queue current stage after re-drills
                    let insert_pos = redrills.min(self.queue.len());
                    self.queue
                        .insert(insert_pos, SessionEntry::NewVerse(progress));
                    ReviewOutcome {
                        edge_updates: updates,
                        redrills_inserted: redrills,
                    }
                }
            }
        }
    }

    fn insert_redrills_for_failures(
        &mut self,
        grades: &HashMap<NodeId, Grade>,
        engine: &ReviewEngine,
        origin_card: Option<CardId>,
    ) -> usize {
        let failed: Vec<NodeId> = grades
            .iter()
            .filter(|(_, g)| !g.is_pass())
            .map(|(id, _)| *id)
            .collect();

        if failed.is_empty() {
            return 0;
        }

        let (verse_ref, verse_phrases) = match engine.graph.verse_context(failed[0]) {
            Some(ctx) => ctx,
            None => return 0,
        };
        let (chapter_ref, book_ref) = match engine.graph.verse_ref_parents(verse_ref) {
            Some((cr, br)) => (Some(cr), Some(br)),
            None => (None, None),
        };

        self.insert_redrills_from_context(
            &failed,
            verse_ref,
            chapter_ref,
            book_ref,
            &verse_phrases,
            origin_card,
        )
    }

    fn prune_no_longer_due(&mut self, engine: &ReviewEngine, now_secs: i64) {
        self.queue.retain(|entry| match entry {
            SessionEntry::Scheduled(card_id) => {
                engine
                    .card(*card_id)
                    .is_some_and(|c| c.state == CardState::Review)
                    && engine
                        .card_schedule(*card_id)
                        .is_some_and(|s| s.due_date_secs <= now_secs)
            }
            _ => true,
        });
    }

    fn transition_relearning_to_review(&self, redrill: &ReDrill, engine: &mut ReviewEngine) {
        if let Some(card_id) = redrill.origin_card
            && engine
                .card(card_id)
                .is_some_and(|c| c.state == CardState::Relearning)
        {
            engine.set_card_state(card_id, CardState::Review);
        }
    }

    #[allow(clippy::too_many_arguments)]
    fn insert_redrills_from_context(
        &mut self,
        failed: &[NodeId],
        verse_ref: NodeId,
        chapter_ref: Option<NodeId>,
        book_ref: Option<NodeId>,
        verse_phrases: &[NodeId],
        origin_card: Option<CardId>,
    ) -> usize {
        let total_hidden = verse_phrases.len().max(1);
        let fail_ratio = failed.len() as f32 / total_hidden as f32;

        let redrills: Vec<ReDrill> = if fail_ratio > self.params.fail_ratio_for_full_recitation {
            vec![ReDrill {
                kind: ReDrillKind::FullRecitation,
                verse_ref,
                chapter_ref,
                book_ref,
                verse_phrases: verse_phrases.to_vec(),
                origin_card,
            }]
        } else {
            failed
                .iter()
                .map(|&atom| ReDrill {
                    kind: ReDrillKind::FillInBlank { target_atom: atom },
                    verse_ref,
                    chapter_ref,
                    book_ref,
                    verse_phrases: verse_phrases.to_vec(),
                    origin_card,
                })
                .collect()
        };

        let count = redrills.len();
        // Insert near front — after 1-2 other reviews for spacing
        let insert_pos = 1.min(self.queue.len());
        for (i, rd) in redrills.into_iter().enumerate() {
            let pos = (insert_pos + i).min(self.queue.len());
            self.queue.insert(pos, SessionEntry::ReDrill(rd));
        }
        count
    }
}

impl NewVerseProgress {
    fn is_reading(&self) -> bool {
        matches!(self.stage, RevealStage::Reading)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::edge::EdgeState;
    use crate::node::NodeKind;

    const DAY: i64 = 86400;

    fn build_verse_engine() -> (ReviewEngine, NodeId, NodeId, NodeId, NodeId, NodeId) {
        let mut g = crate::graph::Graph::new();
        let r = g.add_node(NodeKind::VerseRef {
            chapter: 3,
            verse: 16,
        });
        let v = g.add_node(NodeKind::VerseGist {
            chapter: 3,
            verse: 16,
        });
        let p1 = g.add_node(NodeKind::Phrase {
            text: "phrase one".into(),
            verse_id: 0,
            position: 0,
        });
        let p2 = g.add_node(NodeKind::Phrase {
            text: "phrase two".into(),
            verse_id: 0,
            position: 1,
        });
        let p3 = g.add_node(NodeKind::Phrase {
            text: "phrase three".into(),
            verse_id: 0,
            position: 2,
        });

        let state = EdgeState {
            stability: 5.0,
            difficulty: 5.0,
            last_review_secs: 0,
        };
        g.add_bi_edge_with_state(v, r, state);
        g.add_bi_edge_with_state(p1, v, state);
        g.add_bi_edge_with_state(p2, v, state);
        g.add_bi_edge_with_state(p3, v, state);
        g.add_bi_edge_with_state(p1, p2, state);
        g.add_bi_edge_with_state(p2, p3, state);

        let full = Card {
            id: CardId(0),
            shown: vec![r],
            hidden: vec![p1, p2, p3],
            state: CardState::Review,
        };
        let engine = ReviewEngine::new(g, vec![full], 0.9);
        (engine, r, v, p1, p2, p3)
    }

    #[test]
    fn verse_context_from_phrase() {
        let (engine, r, _v, p1, p2, p3) = build_verse_engine();
        let (ref_id, phrases) = engine.graph.verse_context(p2).unwrap();
        assert_eq!(ref_id, r);
        assert_eq!(phrases, vec![p1, p2, p3]);
    }

    #[test]
    fn redrill_fill_in_blank_construction() {
        let rd = ReDrill {
            kind: ReDrillKind::FillInBlank {
                target_atom: NodeId(3),
            },
            verse_ref: NodeId(0),
            chapter_ref: None,
            book_ref: None,
            verse_phrases: vec![NodeId(2), NodeId(3), NodeId(4)],
            origin_card: None,
        };
        let card = rd.to_session_card();
        assert_eq!(card.hidden, vec![NodeId(3)]);
        assert!(card.shown.contains(&NodeId(0))); // ref
        assert!(card.shown.contains(&NodeId(2))); // other phrase
        assert!(card.shown.contains(&NodeId(4))); // other phrase
        assert!(!card.shown.contains(&NodeId(3))); // target hidden
    }

    #[test]
    fn redrill_includes_ref_triple_when_parents_known() {
        let rd = ReDrill {
            kind: ReDrillKind::FullRecitation,
            verse_ref: NodeId(7),
            chapter_ref: Some(NodeId(5)),
            book_ref: Some(NodeId(3)),
            verse_phrases: vec![NodeId(10), NodeId(11)],
            origin_card: None,
        };
        let card = rd.to_session_card();
        // book_ref → chapter_ref → verse_ref ordering, then phrases hidden.
        assert_eq!(card.shown, vec![NodeId(3), NodeId(5), NodeId(7)]);
        assert_eq!(card.hidden, vec![NodeId(10), NodeId(11)]);
    }

    #[test]
    fn new_verse_includes_ref_triple_when_parents_known() {
        let nv = NewVerseProgress {
            verse_ref: NodeId(7),
            chapter_ref: Some(NodeId(5)),
            book_ref: Some(NodeId(3)),
            verse_phrases: vec![NodeId(10), NodeId(11)],
            stage: RevealStage::FullRecitation,
        };
        let card = nv.to_session_card();
        assert_eq!(card.shown, vec![NodeId(3), NodeId(5), NodeId(7)]);
        assert_eq!(card.hidden, vec![NodeId(10), NodeId(11)]);
    }

    #[test]
    fn progressive_reveal_stages() {
        let mut nv = NewVerseProgress {
            verse_ref: NodeId(0),
            chapter_ref: None,
            book_ref: None,
            verse_phrases: vec![NodeId(1), NodeId(2)],
            stage: RevealStage::Reading,
        };

        // Reading
        let card = nv.to_session_card();
        assert!(card.is_reading);
        assert_eq!(card.hidden.len(), 0);

        // Advance to fill-in-blank 0
        nv.advance();
        assert!(matches!(nv.stage, RevealStage::FillInBlank { index: 0 }));
        let card = nv.to_session_card();
        assert_eq!(card.hidden, vec![NodeId(1)]);

        // Advance to fill-in-blank 1
        nv.advance();
        assert!(matches!(nv.stage, RevealStage::FillInBlank { index: 1 }));
        let card = nv.to_session_card();
        assert_eq!(card.hidden, vec![NodeId(2)]);

        // Advance to full recitation
        nv.advance();
        assert!(matches!(nv.stage, RevealStage::FullRecitation));
        let card = nv.to_session_card();
        assert_eq!(card.hidden.len(), 2);

        // Advance to complete
        nv.advance();
        assert!(matches!(nv.stage, RevealStage::Complete));
    }

    #[test]
    fn session_with_due_cards() {
        let (mut engine, _, _, _p1, _p2, _p3) = build_verse_engine();
        let session = Session::new(&mut engine, 30 * DAY, SessionParams::default(), &[]);

        // At 30 days, cards should be due
        assert!(!session.is_done());
        let card = session.next().unwrap();
        assert!(matches!(card.source, SessionCardSource::Scheduled(_)));
    }

    #[test]
    fn session_inserts_redrill_on_lapse() {
        let (mut engine, _, _, p1, p2, p3) = build_verse_engine();
        let mut session = Session::new(&mut engine, 30 * DAY, SessionParams::default(), &[]);

        let _card = session.next().unwrap();
        let grades = HashMap::from([(p1, Grade::Good), (p2, Grade::Again), (p3, Grade::Good)]);
        let outcome = session.record_review(grades, &mut engine, 30 * DAY);

        assert!(
            outcome.redrills_inserted > 0,
            "should insert re-drill for p2"
        );
        assert!(!session.is_done(), "session should have re-drill in queue");
    }

    #[test]
    fn session_new_verse_progressive_reveal() {
        let (mut engine, r, _, p1, p2, p3) = build_verse_engine();
        let new_verse = NewVerseInfo {
            verse_ref: r,
            verse_phrases: vec![p1, p2, p3],
        };
        let mut session = Session::new(&mut engine, 0, SessionParams::default(), &[new_verse]);

        // First card should be reading
        let card = session.next().unwrap();
        assert!(card.is_reading);

        // Record (no grades for reading)
        let outcome = session.record_review(HashMap::new(), &mut engine, 0);
        assert_eq!(outcome.redrills_inserted, 0);

        // Next should be fill-in-blank for p1
        let card = session.next().unwrap();
        assert!(!card.is_reading);
        assert!(matches!(card.source, SessionCardSource::NewVerse));
    }

    #[test]
    fn determine_redrills_single_fail() {
        let failed = [NodeId(3)];
        let verse_phrases = [NodeId(2), NodeId(3), NodeId(4)];
        let ratio = failed.len() as f32 / verse_phrases.len() as f32;
        assert!(ratio <= 0.5); // 1/3 ≤ 0.5 → fill-in-blanks
    }

    #[test]
    fn determine_redrills_majority_fail() {
        let failed = [NodeId(2), NodeId(3)];
        let verse_phrases = [NodeId(2), NodeId(3), NodeId(4)];
        let ratio = failed.len() as f32 / verse_phrases.len() as f32;
        assert!(ratio > 0.5); // 2/3 > 0.5 → full recitation
    }

    #[test]
    fn abort_rolls_back_learning_to_new() {
        let (mut engine, r, _, p1, p2, p3) = build_verse_engine();
        engine.cards[0].state = CardState::New;

        let new_verse = NewVerseInfo {
            verse_ref: r,
            verse_phrases: vec![p1, p2, p3],
        };
        let session = Session::new(&mut engine, 0, SessionParams::default(), &[new_verse]);

        assert_eq!(engine.cards[0].state, CardState::Learning);

        session.abort(&mut engine);

        assert_eq!(engine.cards[0].state, CardState::New);
    }

    #[test]
    fn abort_mid_session_rolls_back_learning() {
        let (mut engine, r, _, p1, p2, p3) = build_verse_engine();
        engine.cards[0].state = CardState::New;

        let new_verse = NewVerseInfo {
            verse_ref: r,
            verse_phrases: vec![p1, p2, p3],
        };
        let mut session = Session::new(&mut engine, 0, SessionParams::default(), &[new_verse]);

        assert_eq!(engine.cards[0].state, CardState::Learning);

        // Complete the reading stage (pops the NewVerse entry from queue)
        let _card = session.next().unwrap();
        session.record_review(HashMap::new(), &mut engine, 0);

        // NewVerse entry was popped and re-queued at FillInBlank stage,
        // but abort should still roll back because it uses introduced_verses
        session.abort(&mut engine);

        assert_eq!(
            engine.cards[0].state,
            CardState::New,
            "abort should roll back even after partial progress"
        );
    }
}
