use std::collections::HashMap;

use crate::edge::{Edge, EdgeKind, EdgeState};
use crate::node::{Node, NodeKind};
use crate::types::{EdgeId, NodeId};

#[derive(Default)]
pub struct Graph {
    nodes: HashMap<NodeId, Node>,
    edges: HashMap<EdgeId, Edge>,
    outgoing: HashMap<NodeId, Vec<EdgeId>>,
    incoming: HashMap<NodeId, Vec<EdgeId>>,
    next_node_id: u32,
    next_edge_id: u32,
}

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

    pub fn add_edge(&mut self, kind: EdgeKind, source: NodeId, target: NodeId) -> EdgeId {
        let state = if kind.is_learnable() {
            Some(EdgeState {
                stability: 0.0,
                difficulty: 5.0,
                last_review_secs: 0,
            })
        } else {
            None
        };
        self.add_edge_with_state(kind, source, target, state)
    }

    pub fn add_edge_with_state(
        &mut self,
        kind: EdgeKind,
        source: NodeId,
        target: NodeId,
        state: Option<EdgeState>,
    ) -> EdgeId {
        let id = EdgeId(self.next_edge_id);
        self.next_edge_id += 1;
        self.edges.insert(
            id,
            Edge {
                id,
                kind,
                source,
                target,
                state,
            },
        );
        self.outgoing.entry(source).or_default().push(id);
        self.incoming.entry(target).or_default().push(id);
        id
    }

    /// Add a bidirectional edge pair (two directed edges with independent state).
    pub fn add_bi_edge(&mut self, kind: EdgeKind, a: NodeId, b: NodeId) -> (EdgeId, EdgeId) {
        let forward = self.add_edge(kind, a, b);
        let backward = self.add_edge(kind, b, a);
        (forward, backward)
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

        g.add_bi_edge(EdgeKind::PhraseVerseGist, p1, v);
        g.add_bi_edge(EdgeKind::PhraseVerseGist, p2, v);
        g.add_bi_edge(EdgeKind::PhrasePhrase, p1, p2);

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

        let (fwd, bwd) = g.add_bi_edge(EdgeKind::VerseGistVerseGist, a, b);

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

        g.add_edge(EdgeKind::VerseGistChapterGist, v, ch);

        assert_eq!(g.outgoing_edges(v).len(), 1);
        assert_eq!(g.outgoing_edges(ch).len(), 0);
        assert_eq!(g.incoming_edges(ch).len(), 1);
        assert_eq!(g.incoming_edges(v).len(), 0);
    }

    #[test]
    fn structural_edge_has_no_state() {
        let mut g = Graph::new();
        let ch = g.add_node(NodeKind::ChapterGist { chapter: 1 });
        let club = g.add_node(NodeKind::ClubEntry {
            tier: crate::node::ClubTier::Club150,
            chapter: 1,
            verse: 1,
        });

        let eid = g.add_edge(EdgeKind::ChapterGistClubEntry, ch, club);
        assert!(g.edge(eid).unwrap().state.is_none());
    }

    #[test]
    fn learnable_edge_has_state() {
        let mut g = Graph::new();
        let v = g.add_node(NodeKind::VerseGist {
            chapter: 1,
            verse: 1,
        });
        let r = g.add_node(NodeKind::Reference {
            chapter: 1,
            verse: 1,
        });

        let eid = g.add_edge(EdgeKind::VerseGistReference, v, r);
        let state = g.edge(eid).unwrap().state.unwrap();
        assert_eq!(state.difficulty, 5.0);
    }
}
