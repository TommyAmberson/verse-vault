use std::collections::HashMap;

use serde::{Deserialize, Serialize};

use crate::edge::{Edge, EdgeRole, EdgeState};
use crate::node::{Node, NodeKind};
use crate::types::{EdgeId, NodeId};

#[derive(Default, Serialize, Deserialize)]
pub struct Graph {
    nodes: HashMap<NodeId, Node>,
    edges: HashMap<EdgeId, Edge>,
    outgoing: HashMap<NodeId, Vec<EdgeId>>,
    incoming: HashMap<NodeId, Vec<EdgeId>>,
    next_node_id: u32,
    next_edge_id: u32,
}

const DEFAULT_EDGE_STATE: EdgeState = EdgeState {
    stability: 0.0,
    difficulty: 5.0,
    last_review_secs: 0,
};

impl Graph {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn add_node(&mut self, kind: NodeKind) -> NodeId {
        let id = NodeId(self.next_node_id);
        self.next_node_id += 1;
        self.nodes.insert(id, Node { id, kind });
        self.outgoing.entry(id).or_default();
        self.incoming.entry(id).or_default();
        id
    }

    pub fn add_edge(&mut self, source: NodeId, target: NodeId) -> EdgeId {
        self.insert_edge(source, target, DEFAULT_EDGE_STATE, None)
    }

    pub fn add_edge_with_state(
        &mut self,
        source: NodeId,
        target: NodeId,
        state: EdgeState,
    ) -> EdgeId {
        self.insert_edge(source, target, state, None)
    }

    pub fn add_edge_with_role(
        &mut self,
        source: NodeId,
        target: NodeId,
        role: EdgeRole,
        state: EdgeState,
    ) -> EdgeId {
        self.insert_edge(source, target, state, Some(role))
    }

    /// Add a bidirectional edge pair (two directed edges with independent state).
    pub fn add_bi_edge(&mut self, a: NodeId, b: NodeId) -> (EdgeId, EdgeId) {
        let forward = self.add_edge(a, b);
        let backward = self.add_edge(b, a);
        (forward, backward)
    }

    /// Add a bidirectional edge pair with explicit initial state.
    pub fn add_bi_edge_with_state(
        &mut self,
        a: NodeId,
        b: NodeId,
        state: EdgeState,
    ) -> (EdgeId, EdgeId) {
        let forward = self.add_edge_with_state(a, b, state);
        let backward = self.add_edge_with_state(b, a, state);
        (forward, backward)
    }

    fn insert_edge(
        &mut self,
        source: NodeId,
        target: NodeId,
        state: EdgeState,
        role: Option<EdgeRole>,
    ) -> EdgeId {
        let id = EdgeId(self.next_edge_id);
        self.next_edge_id += 1;
        self.edges.insert(
            id,
            Edge {
                id,
                source,
                target,
                state,
                role,
            },
        );
        self.outgoing.entry(source).or_default().push(id);
        self.incoming.entry(target).or_default().push(id);
        id
    }

    pub fn node(&self, id: NodeId) -> Option<&Node> {
        self.nodes.get(&id)
    }

    pub fn node_kind(&self, id: NodeId) -> Option<&NodeKind> {
        self.nodes.get(&id).map(|n| &n.kind)
    }

    pub fn edge(&self, id: EdgeId) -> Option<&Edge> {
        self.edges.get(&id)
    }

    pub fn edge_mut(&mut self, id: EdgeId) -> Option<&mut Edge> {
        self.edges.get_mut(&id)
    }

    pub fn outgoing_edges(&self, node: NodeId) -> &[EdgeId] {
        self.outgoing.get(&node).map_or(&[], |v| v.as_slice())
    }

    pub fn incoming_edges(&self, node: NodeId) -> &[EdgeId] {
        self.incoming.get(&node).map_or(&[], |v| v.as_slice())
    }

    pub fn node_count(&self) -> usize {
        self.nodes.len()
    }

    pub fn edge_count(&self) -> usize {
        self.edges.len()
    }

    pub fn node_ids(&self) -> impl Iterator<Item = NodeId> + '_ {
        self.nodes.keys().copied()
    }

    pub fn edge_ids(&self) -> impl Iterator<Item = EdgeId> + '_ {
        self.edges.keys().copied()
    }

    pub fn edges(&self) -> impl Iterator<Item = &Edge> {
        self.edges.values()
    }

    /// True when `edge` connects a node matching `src` to a node matching
    /// `dst`. Use with `matches!` against `NodeKind` variants when the
    /// caller cares about the specific source→target shape.
    pub fn edge_connects<P, Q>(&self, edge: &Edge, src: P, dst: Q) -> bool
    where
        P: FnOnce(&NodeKind) -> bool,
        Q: FnOnce(&NodeKind) -> bool,
    {
        self.node_kind(edge.source).is_some_and(src) && self.node_kind(edge.target).is_some_and(dst)
    }

    /// Find the verse context for a given atom: (verse-ref NodeId, sorted phrase NodeIds).
    /// Traverses: atom → VerseGist → VerseRef + all Phrases.
    /// Works for Phrase, VerseGist, and VerseRef atoms.
    pub fn verse_context(&self, atom: NodeId) -> Option<(NodeId, Vec<NodeId>)> {
        let verse_gist = match self.node_kind(atom)? {
            NodeKind::VerseGist { .. } => atom,
            NodeKind::Phrase { .. } => {
                self.find_neighbor(atom, |k| matches!(k, NodeKind::VerseGist { .. }))?
            }
            NodeKind::VerseRef { .. } => {
                self.find_neighbor(atom, |k| matches!(k, NodeKind::VerseGist { .. }))?
            }
            _ => return None,
        };

        let verse_ref =
            self.find_neighbor(verse_gist, |k| matches!(k, NodeKind::VerseRef { .. }))?;

        let mut phrases: Vec<(u16, NodeId)> = Vec::new();
        for &eid in self.outgoing_edges(verse_gist) {
            if let Some(edge) = self.edge(eid)
                && let Some(NodeKind::Phrase { position, .. }) = self.node_kind(edge.target)
            {
                phrases.push((*position, edge.target));
            }
        }
        for &eid in self.incoming_edges(verse_gist) {
            if let Some(edge) = self.edge(eid)
                && let Some(NodeKind::Phrase { position, .. }) = self.node_kind(edge.source)
                && !phrases.iter().any(|(_, id)| *id == edge.source)
            {
                phrases.push((*position, edge.source));
            }
        }
        phrases.sort_by_key(|(pos, _)| *pos);
        let phrase_ids: Vec<NodeId> = phrases.into_iter().map(|(_, id)| id).collect();

        Some((verse_ref, phrase_ids))
    }

    /// Walk `verse_ref → chapter_ref → book_ref` via the structural ref-chain
    /// edges. Returns the (chapter_ref, book_ref) pair, or None if either link
    /// is missing (e.g. graphs built before the chapter/book layers existed).
    /// Used by session re-drill / new-verse cards to assemble the full ref
    /// triple at render time.
    pub fn verse_ref_parents(&self, verse_ref: NodeId) -> Option<(NodeId, NodeId)> {
        let chapter_ref =
            self.find_neighbor(verse_ref, |k| matches!(k, NodeKind::ChapterRef { .. }))?;
        let book_ref =
            self.find_neighbor(chapter_ref, |k| matches!(k, NodeKind::BookRef { .. }))?;
        Some((chapter_ref, book_ref))
    }

    fn find_neighbor(&self, node: NodeId, pred: impl Fn(&NodeKind) -> bool) -> Option<NodeId> {
        for &eid in self.outgoing_edges(node) {
            if let Some(edge) = self.edge(eid)
                && let Some(kind) = self.node_kind(edge.target)
                && pred(kind)
            {
                return Some(edge.target);
            }
        }
        for &eid in self.incoming_edges(node) {
            if let Some(edge) = self.edge(eid)
                && let Some(kind) = self.node_kind(edge.source)
                && pred(kind)
            {
                return Some(edge.source);
            }
        }
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn add_nodes_and_edges() {
        let mut g = Graph::new();
        let v = g.add_node(NodeKind::VerseGist {
            chapter: 2,
            verse: 1,
        });
        let p1 = g.add_node(NodeKind::Phrase {
            text: "For God so loved".into(),
            verse_id: 0,
            position: 0,
        });
        let p2 = g.add_node(NodeKind::Phrase {
            text: "the world".into(),
            verse_id: 0,
            position: 1,
        });

        g.add_bi_edge(p1, v);
        g.add_bi_edge(p2, v);
        g.add_bi_edge(p1, p2);

        assert_eq!(g.node_count(), 3);
        assert_eq!(g.edge_count(), 6);
    }

    #[test]
    fn bidirectional_creates_two_directed_edges() {
        let mut g = Graph::new();
        let a = g.add_node(NodeKind::VerseGist {
            chapter: 1,
            verse: 1,
        });
        let b = g.add_node(NodeKind::VerseGist {
            chapter: 1,
            verse: 2,
        });

        let (fwd, bwd) = g.add_bi_edge(a, b);

        let fwd_edge = g.edge(fwd).unwrap();
        assert_eq!(fwd_edge.source, a);
        assert_eq!(fwd_edge.target, b);

        let bwd_edge = g.edge(bwd).unwrap();
        assert_eq!(bwd_edge.source, b);
        assert_eq!(bwd_edge.target, a);

        assert_eq!(g.outgoing_edges(a).len(), 1);
        assert_eq!(g.outgoing_edges(b).len(), 1);
        assert_eq!(g.incoming_edges(a).len(), 1);
        assert_eq!(g.incoming_edges(b).len(), 1);
    }

    #[test]
    fn unidirectional_edge() {
        let mut g = Graph::new();
        let v = g.add_node(NodeKind::VerseGist {
            chapter: 1,
            verse: 1,
        });
        let ch = g.add_node(NodeKind::ChapterGist { chapter: 1 });

        g.add_edge(v, ch);

        assert_eq!(g.outgoing_edges(v).len(), 1);
        assert_eq!(g.outgoing_edges(ch).len(), 0);
        assert_eq!(g.incoming_edges(ch).len(), 1);
        assert_eq!(g.incoming_edges(v).len(), 0);
    }

    #[test]
    fn every_edge_has_state() {
        let mut g = Graph::new();
        let v = g.add_node(NodeKind::VerseGist {
            chapter: 1,
            verse: 1,
        });
        let r = g.add_node(NodeKind::VerseRef {
            chapter: 1,
            verse: 1,
        });

        let eid = g.add_edge(v, r);
        let state = g.edge(eid).unwrap().state;
        assert_eq!(state.difficulty, 5.0);
    }

    #[test]
    fn role_is_optional() {
        let mut g = Graph::new();
        let ch = g.add_node(NodeKind::ChapterGist { chapter: 1 });
        let v = g.add_node(NodeKind::VerseGist {
            chapter: 1,
            verse: 1,
        });

        let plain = g.add_edge(v, ch);
        assert!(g.edge(plain).unwrap().role.is_none());

        let endpoint = g.add_edge_with_role(ch, v, EdgeRole::FirstChild, DEFAULT_EDGE_STATE);
        assert_eq!(g.edge(endpoint).unwrap().role, Some(EdgeRole::FirstChild));
    }
}
