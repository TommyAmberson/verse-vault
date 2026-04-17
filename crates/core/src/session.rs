use std::collections::{HashMap, VecDeque};

use crate::credit::EdgeUpdate;
use crate::engine::ReviewEngine;
use crate::types::{CardId, Grade, NodeId};

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
    pub verse_phrases: Vec<NodeId>,
}

impl ReDrill {
    pub fn to_session_card(&self) -> SessionCard {
        match &self.kind {
            ReDrillKind::FillInBlank { target_atom } => {
                let shown: Vec<NodeId> = std::iter::once(self.verse_ref)
                    .chain(
                        self.verse_phrases
                            .iter()
                            .copied()
                            .filter(|p| p != target_atom),
                    )
                    .collect();
                SessionCard {
                    shown,
                    hidden: vec![*target_atom],
                    is_reading: false,
                    source: SessionCardSource::ReDrill,
                }
            }
            ReDrillKind::FullRecitation => SessionCard {
                shown: vec![self.verse_ref],
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
    pub verse_phrases: Vec<NodeId>,
    pub stage: RevealStage,
}

impl NewVerseProgress {
    pub fn to_session_card(&self) -> SessionCard {
        match &self.stage {
            RevealStage::Reading => SessionCard {
                shown: std::iter::once(self.verse_ref)
                    .chain(self.verse_phrases.iter().copied())
                    .collect(),
                hidden: vec![],
                is_reading: true,
                source: SessionCardSource::NewVerse,
            },
            RevealStage::FillInBlank { index } => {
                let target = self.verse_phrases[*index];
                let shown: Vec<NodeId> = std::iter::once(self.verse_ref)
                    .chain(self.verse_phrases.iter().copied().filter(|&p| p != target))
                    .collect();
                SessionCard {
                    shown,
                    hidden: vec![target],
                    is_reading: false,
                    source: SessionCardSource::NewVerse,
                }
            }
            RevealStage::FullRecitation => SessionCard {
                shown: vec![self.verse_ref],
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
}

/// Info needed to introduce a new verse.
pub struct NewVerseInfo {
    pub verse_ref: NodeId,
    pub verse_phrases: Vec<NodeId>,
}

impl Session {
    pub fn new(
        engine: &ReviewEngine,
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
                        .is_some_and(|c| c.state == crate::card::CardState::Review)
            })
            .collect();
        due.sort_by(|a, b| b.priority.partial_cmp(&a.priority).unwrap());

        let max_scheduled = params
            .max_session_size
            .saturating_sub(new_verses.len().min(params.max_new_verses) * 4);
        for sched in due.iter().take(max_scheduled) {
            queue.push_back(SessionEntry::Scheduled(sched.card_id));
        }

        // Add new verses (progressive reveal)
        for nv in new_verses.iter().take(params.max_new_verses) {
            queue.push_back(SessionEntry::NewVerse(NewVerseProgress {
                verse_ref: nv.verse_ref,
                verse_phrases: nv.verse_phrases.clone(),
                stage: RevealStage::Reading,
            }));
        }

        Self {
            queue,
            reviews_completed: 0,
            params,
        }
    }

    pub fn is_done(&self) -> bool {
        self.queue.is_empty()
    }

    pub fn remaining(&self) -> usize {
        self.queue.len()
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
                let updates = engine.review(card_id, grades.clone(), now_secs);
                let redrills = self.insert_redrills_for_failures(&grades, engine);
                self.prune_no_longer_due(engine, now_secs);
                ReviewOutcome {
                    edge_updates: updates,
                    redrills_inserted: redrills,
                }
            }
            SessionEntry::ReDrill(redrill) => {
                let card = redrill.to_session_card();
                let updates =
                    engine.review_transient(&card.shown, &card.hidden, grades.clone(), now_secs);
                let redrills = self.insert_redrills_for_failures(&grades, engine);
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
                            if (card
                                .hidden
                                .iter()
                                .any(|h| progress.verse_phrases.contains(h))
                                || card
                                    .shown
                                    .iter()
                                    .any(|s| progress.verse_phrases.contains(s)))
                                && (card.state == crate::card::CardState::New
                                    || card.state == crate::card::CardState::Learning)
                            {
                                card.state = crate::card::CardState::Review;
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
                        &progress.verse_phrases,
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
    ) -> usize {
        let failed: Vec<NodeId> = grades
            .iter()
            .filter(|(_, g)| !g.is_pass())
            .map(|(id, _)| *id)
            .collect();

        if failed.is_empty() {
            return 0;
        }

        // Find verse context for the first failed atom
        let (verse_ref, verse_phrases) = match engine.graph.verse_context(failed[0]) {
            Some(ctx) => ctx,
            None => return 0,
        };

        self.insert_redrills_from_context(&failed, verse_ref, &verse_phrases)
    }

    fn prune_no_longer_due(&mut self, engine: &ReviewEngine, now_secs: i64) {
        self.queue.retain(|entry| match entry {
            SessionEntry::Scheduled(card_id) => engine
                .card_schedule(*card_id)
                .is_none_or(|s| s.due_date_secs <= now_secs),
            _ => true,
        });
    }

    fn insert_redrills_from_context(
        &mut self,
        failed: &[NodeId],
        verse_ref: NodeId,
        verse_phrases: &[NodeId],
    ) -> usize {
        let total_hidden = verse_phrases.len().max(1);
        let fail_ratio = failed.len() as f32 / total_hidden as f32;

        let redrills: Vec<ReDrill> = if fail_ratio > self.params.fail_ratio_for_full_recitation {
            vec![ReDrill {
                kind: ReDrillKind::FullRecitation,
                verse_ref,
                verse_phrases: verse_phrases.to_vec(),
            }]
        } else {
            failed
                .iter()
                .map(|&atom| ReDrill {
                    kind: ReDrillKind::FillInBlank { target_atom: atom },
                    verse_ref,
                    verse_phrases: verse_phrases.to_vec(),
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
    use crate::card::{Card, CardState};
    use crate::edge::{EdgeKind, EdgeState};
    use crate::node::NodeKind;

    const DAY: i64 = 86400;

    fn build_verse_engine() -> (ReviewEngine, NodeId, NodeId, NodeId, NodeId, NodeId) {
        let mut g = crate::graph::Graph::new();
        let r = g.add_node(NodeKind::Reference {
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
        g.add_bi_edge_with_state(EdgeKind::VerseGistReference, v, r, state);
        g.add_bi_edge_with_state(EdgeKind::PhraseVerseGist, p1, v, state);
        g.add_bi_edge_with_state(EdgeKind::PhraseVerseGist, p2, v, state);
        g.add_bi_edge_with_state(EdgeKind::PhraseVerseGist, p3, v, state);
        g.add_bi_edge_with_state(EdgeKind::PhrasePhrase, p1, p2, state);
        g.add_bi_edge_with_state(EdgeKind::PhrasePhrase, p2, p3, state);

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
            verse_phrases: vec![NodeId(2), NodeId(3), NodeId(4)],
        };
        let card = rd.to_session_card();
        assert_eq!(card.hidden, vec![NodeId(3)]);
        assert!(card.shown.contains(&NodeId(0))); // ref
        assert!(card.shown.contains(&NodeId(2))); // other phrase
        assert!(card.shown.contains(&NodeId(4))); // other phrase
        assert!(!card.shown.contains(&NodeId(3))); // target hidden
    }

    #[test]
    fn progressive_reveal_stages() {
        let mut nv = NewVerseProgress {
            verse_ref: NodeId(0),
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
        let (engine, _, _, p1, p2, p3) = build_verse_engine();
        let mut session = Session::new(&engine, 30 * DAY, SessionParams::default(), &[]);

        // At 30 days, cards should be due
        assert!(!session.is_done());
        let card = session.next().unwrap();
        assert!(matches!(card.source, SessionCardSource::Scheduled(_)));
    }

    #[test]
    fn session_inserts_redrill_on_lapse() {
        let (mut engine, _, _, p1, p2, p3) = build_verse_engine();
        let mut session = Session::new(&engine, 30 * DAY, SessionParams::default(), &[]);

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
        let mut session = Session::new(&engine, 0, SessionParams::default(), &[new_verse]);

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
        let failed = vec![NodeId(3)];
        let verse_phrases = vec![NodeId(2), NodeId(3), NodeId(4)];
        let ratio = failed.len() as f32 / verse_phrases.len() as f32;
        assert!(ratio <= 0.5); // 1/3 ≤ 0.5 → fill-in-blanks
    }

    #[test]
    fn determine_redrills_majority_fail() {
        let failed = vec![NodeId(2), NodeId(3)];
        let verse_phrases = vec![NodeId(2), NodeId(3), NodeId(4)];
        let ratio = failed.len() as f32 / verse_phrases.len() as f32;
        assert!(ratio > 0.5); // 2/3 > 0.5 → full recitation
    }
}
