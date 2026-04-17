use crate::types::{CardId, NodeId};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CardState {
    New,
    Learning,
    Review,
    Relearning,
}

#[derive(Debug, Clone)]
pub struct Card {
    pub id: CardId,
    pub shown: Vec<NodeId>,
    pub hidden: Vec<NodeId>,
    pub state: CardState,
}

#[derive(Debug, Clone)]
pub struct CardSchedule {
    pub card_id: CardId,
    pub due_r: f32,
    pub due_date_secs: i64,
    pub priority: f32,
}
