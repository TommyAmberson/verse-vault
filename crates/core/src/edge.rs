use serde::{Deserialize, Serialize};

use crate::types::{EdgeId, NodeId};

/// Disambiguates edges that share the same `(source.kind, target.kind)`
/// pair. Presently just parent → first/last child endpoint edges — for
/// a one-child parent those would otherwise be indistinguishable. Every
/// other edge has `role: None` and gets its identity from its endpoint
/// node kinds alone.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum EdgeRole {
    FirstChild,
    LastChild,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
pub struct EdgeState {
    pub stability: f32,
    pub difficulty: f32,
    pub last_review_secs: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Edge {
    pub id: EdgeId,
    pub source: NodeId,
    pub target: NodeId,
    pub state: EdgeState,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub role: Option<EdgeRole>,
}
