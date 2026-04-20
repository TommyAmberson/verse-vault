use std::collections::HashMap;

use serde::{Deserialize, Serialize};
use wasm_bindgen::prelude::*;

use verse_vault_core::card::{Card, CardSchedule, CardState};
use verse_vault_core::edge::EdgeState;
use verse_vault_core::engine::ReviewEngine;
use verse_vault_core::graph::Graph;
use verse_vault_core::session::{
    NewVerseInfo, ReviewOutcome, Session, SessionCard, SessionCardSource, SessionParams,
};
use verse_vault_core::types::{CardId, EdgeId, Grade, NodeId};

#[wasm_bindgen(start)]
pub fn init() {
    console_error_panic_hook::set_once();
}

/// Wire type for loading/exporting edge state.
#[derive(Serialize, Deserialize)]
pub struct EdgeStateEntry {
    pub edge_id: u32,
    pub stability: f32,
    pub difficulty: f32,
    pub last_review_secs: i64,
}

/// Wire type for loading/exporting card state.
#[derive(Serialize, Deserialize)]
pub struct CardStateEntry {
    pub card_id: u32,
    pub state: String,
    pub due_r: Option<f32>,
    pub due_date_secs: Option<i64>,
    pub priority: Option<f32>,
}

/// Wire type for new verse info passed from JS.
#[derive(Serialize, Deserialize)]
pub struct NewVerseInfoWire {
    pub verse_ref: u32,
    pub verse_phrases: Vec<u32>,
}

/// Wire type for grades.
#[derive(Serialize, Deserialize)]
pub struct GradeEntry {
    pub node_id: u32,
    pub grade: u8, // 1=Again, 2=Hard, 3=Good, 4=Easy
}

/// Wire type for session cards exposed to JS.
#[derive(Serialize, Deserialize)]
pub struct SessionCardWire {
    pub shown: Vec<u32>,
    pub hidden: Vec<u32>,
    pub is_reading: bool,
    pub source_kind: String, // "scheduled" | "redrill" | "new_verse"
    pub source_card_id: Option<u32>,
}

/// Wire type for review outcome.
#[derive(Serialize, Deserialize)]
pub struct ReviewOutcomeWire {
    pub edge_updates: Vec<EdgeUpdateWire>,
    pub redrills_inserted: usize,
}

#[derive(Serialize, Deserialize)]
pub struct EdgeUpdateWire {
    pub edge_id: u32,
    pub grade: u8,
    pub weight: f32,
}

#[wasm_bindgen]
pub struct WasmEngine {
    engine: ReviewEngine,
    session: Option<Session>,
}

#[wasm_bindgen]
impl WasmEngine {
    /// Load an engine from JSON: graph + card catalog, and optional
    /// persisted edge/card states (pass empty strings to skip).
    /// When edge/card states are provided they override the initial state
    /// derived from the graph — this is how a user's progress is resumed.
    #[wasm_bindgen(constructor)]
    pub fn new(
        graph_json: &str,
        cards_json: &str,
        edge_states_json: &str,
        card_states_json: &str,
        desired_retention: f32,
    ) -> Result<WasmEngine, JsError> {
        let graph: Graph = serde_json::from_str(graph_json)
            .map_err(|e| JsError::new(&format!("graph parse: {e}")))?;
        let cards: Vec<Card> = serde_json::from_str(cards_json)
            .map_err(|e| JsError::new(&format!("cards parse: {e}")))?;

        let mut engine = ReviewEngine::new(graph, cards, desired_retention);

        // Apply persisted edge states if provided
        if !edge_states_json.is_empty() && edge_states_json != "[]" {
            let edges: Vec<EdgeStateEntry> = serde_json::from_str(edge_states_json)
                .map_err(|e| JsError::new(&format!("edge_states parse: {e}")))?;
            for entry in edges {
                if let Some(edge) = engine.graph.edge_mut(EdgeId(entry.edge_id)) {
                    edge.state = Some(EdgeState {
                        stability: entry.stability,
                        difficulty: entry.difficulty,
                        last_review_secs: entry.last_review_secs,
                    });
                }
            }
        }

        // Apply persisted card states if provided
        if !card_states_json.is_empty() && card_states_json != "[]" {
            let card_states: Vec<CardStateEntry> = serde_json::from_str(card_states_json)
                .map_err(|e| JsError::new(&format!("card_states parse: {e}")))?;
            for entry in card_states {
                let state = parse_card_state(&entry.state)?;
                engine.set_card_state(CardId(entry.card_id), state);
            }
        }

        Ok(WasmEngine {
            engine,
            session: None,
        })
    }

    /// Export current edge states as JSON.
    pub fn export_edge_states(&self) -> Result<String, JsError> {
        let entries: Vec<EdgeStateEntry> = self
            .engine
            .graph
            .edges()
            .filter_map(|e| {
                e.state.map(|s| EdgeStateEntry {
                    edge_id: e.id.0,
                    stability: s.stability,
                    difficulty: s.difficulty,
                    last_review_secs: s.last_review_secs,
                })
            })
            .collect();
        serde_json::to_string(&entries).map_err(|e| JsError::new(&e.to_string()))
    }

    /// Export current card states + schedules as JSON.
    pub fn export_card_states(&self) -> Result<String, JsError> {
        let mut schedules: HashMap<u32, &CardSchedule> = HashMap::new();
        for s in &self.engine.schedules {
            schedules.insert(s.card_id.0, s);
        }
        let entries: Vec<CardStateEntry> = self
            .engine
            .cards
            .iter()
            .map(|c| {
                let sched = schedules.get(&c.id.0);
                CardStateEntry {
                    card_id: c.id.0,
                    state: card_state_str(c.state).to_string(),
                    due_r: sched.map(|s| s.due_r),
                    due_date_secs: sched.map(|s| s.due_date_secs),
                    priority: sched.map(|s| s.priority),
                }
            })
            .collect();
        serde_json::to_string(&entries).map_err(|e| JsError::new(&e.to_string()))
    }

    /// Pick the next due card (no session). Returns null if none due.
    pub fn next_due_card(&self, now_secs: i64) -> Option<u32> {
        self.engine.next_card(now_secs).map(|s| s.card_id.0)
    }

    /// Start a session with optional new verses.
    pub fn start_session(
        &mut self,
        now_secs: i64,
        new_verses_json: &str,
        params_json: &str,
    ) -> Result<(), JsError> {
        let new_verses_wire: Vec<NewVerseInfoWire> = if new_verses_json.is_empty() {
            Vec::new()
        } else {
            serde_json::from_str(new_verses_json)
                .map_err(|e| JsError::new(&format!("new_verses parse: {e}")))?
        };
        let new_verses: Vec<NewVerseInfo> = new_verses_wire
            .into_iter()
            .map(|nv| NewVerseInfo {
                verse_ref: NodeId(nv.verse_ref),
                verse_phrases: nv.verse_phrases.into_iter().map(NodeId).collect(),
            })
            .collect();

        let params: SessionParams = if params_json.is_empty() {
            SessionParams::default()
        } else {
            let wire: SessionParamsWire = serde_json::from_str(params_json)
                .map_err(|e| JsError::new(&format!("params parse: {e}")))?;
            SessionParams {
                max_session_size: wire.max_session_size,
                max_new_verses: wire.max_new_verses,
                fail_ratio_for_full_recitation: wire.fail_ratio_for_full_recitation,
            }
        };

        let session = Session::new(&mut self.engine, now_secs, params, &new_verses);
        self.session = Some(session);
        Ok(())
    }

    /// Peek at the next session card, returning a SessionCardWire as JSON.
    /// Returns null if session is done or not started.
    pub fn session_next(&self) -> Result<Option<String>, JsError> {
        let session = match &self.session {
            Some(s) => s,
            None => return Ok(None),
        };
        let Some(card) = session.next() else {
            return Ok(None);
        };

        // For Scheduled cards, fill in shown/hidden from the catalog
        let wire = session_card_to_wire(&card, &self.engine);
        serde_json::to_string(&wire)
            .map(Some)
            .map_err(|e| JsError::new(&e.to_string()))
    }

    /// Record a review. Returns ReviewOutcomeWire as JSON.
    pub fn session_review(&mut self, grades_json: &str, now_secs: i64) -> Result<String, JsError> {
        let session = self
            .session
            .as_mut()
            .ok_or_else(|| JsError::new("no active session"))?;

        let grade_entries: Vec<GradeEntry> = if grades_json.is_empty() {
            Vec::new()
        } else {
            serde_json::from_str(grades_json)
                .map_err(|e| JsError::new(&format!("grades parse: {e}")))?
        };
        let mut grades: HashMap<NodeId, Grade> = HashMap::new();
        for g in grade_entries {
            grades.insert(NodeId(g.node_id), int_to_grade(g.grade)?);
        }

        let outcome: ReviewOutcome = session.record_review(grades, &mut self.engine, now_secs);
        let wire = ReviewOutcomeWire {
            edge_updates: outcome
                .edge_updates
                .iter()
                .map(|u| EdgeUpdateWire {
                    edge_id: u.edge_id.0,
                    grade: grade_to_int(u.grade),
                    weight: u.weight,
                })
                .collect(),
            redrills_inserted: outcome.redrills_inserted,
        };
        serde_json::to_string(&wire).map_err(|e| JsError::new(&e.to_string()))
    }

    /// Abort the current session.
    pub fn session_abort(&mut self) {
        if let Some(session) = self.session.take() {
            session.abort(&mut self.engine);
        }
    }

    /// Whether the current session is done (empty queue).
    pub fn session_is_done(&self) -> bool {
        self.session.as_ref().is_none_or(|s| s.is_done())
    }

    /// Number of entries remaining in the session queue.
    pub fn session_remaining(&self) -> usize {
        self.session.as_ref().map_or(0, |s| s.remaining())
    }
}

#[derive(Serialize, Deserialize)]
struct SessionParamsWire {
    max_session_size: usize,
    max_new_verses: usize,
    fail_ratio_for_full_recitation: f32,
}

fn session_card_to_wire(card: &SessionCard, engine: &ReviewEngine) -> SessionCardWire {
    let (shown, hidden, source_kind, source_card_id) = match &card.source {
        SessionCardSource::Scheduled(card_id) => {
            // For scheduled cards, fill in shown/hidden from engine.card()
            if let Some(c) = engine.card(*card_id) {
                (
                    c.shown.iter().map(|n| n.0).collect(),
                    c.hidden.iter().map(|n| n.0).collect(),
                    "scheduled".to_string(),
                    Some(card_id.0),
                )
            } else {
                (vec![], vec![], "scheduled".to_string(), Some(card_id.0))
            }
        }
        SessionCardSource::ReDrill => (
            card.shown.iter().map(|n| n.0).collect(),
            card.hidden.iter().map(|n| n.0).collect(),
            "redrill".to_string(),
            None,
        ),
        SessionCardSource::NewVerse => (
            card.shown.iter().map(|n| n.0).collect(),
            card.hidden.iter().map(|n| n.0).collect(),
            "new_verse".to_string(),
            None,
        ),
    };

    SessionCardWire {
        shown,
        hidden,
        is_reading: card.is_reading,
        source_kind,
        source_card_id,
    }
}

fn card_state_str(state: CardState) -> &'static str {
    match state {
        CardState::New => "new",
        CardState::Learning => "learning",
        CardState::Review => "review",
        CardState::Relearning => "relearning",
    }
}

fn parse_card_state(s: &str) -> Result<CardState, JsError> {
    match s {
        "new" => Ok(CardState::New),
        "learning" => Ok(CardState::Learning),
        "review" => Ok(CardState::Review),
        "relearning" => Ok(CardState::Relearning),
        _ => Err(JsError::new(&format!("invalid card state: {s}"))),
    }
}

fn int_to_grade(v: u8) -> Result<Grade, JsError> {
    match v {
        1 => Ok(Grade::Again),
        2 => Ok(Grade::Hard),
        3 => Ok(Grade::Good),
        4 => Ok(Grade::Easy),
        _ => Err(JsError::new(&format!("invalid grade: {v}"))),
    }
}

fn grade_to_int(g: Grade) -> u8 {
    match g {
        Grade::Again => 1,
        Grade::Hard => 2,
        Grade::Good => 3,
        Grade::Easy => 4,
    }
}
