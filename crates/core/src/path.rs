use std::collections::HashSet;

use crate::graph::Graph;
use crate::types::{EdgeId, NodeId};

#[derive(Debug, Clone)]
pub struct Path {
    pub edges: Vec<EdgeId>,
    pub nodes: Vec<NodeId>,
}

impl Path {
    pub fn hop_count(&self) -> usize {
        self.edges.len()
    }
}

pub const MAX_HOPS: usize = 5;

/// Enumerate all paths from any node in `sources` to `target`,
/// up to `max_hops` edges, without revisiting nodes.
/// Follows directed edges only (outgoing adjacency).
pub fn enumerate_paths(
    graph: &Graph,
    sources: &HashSet<NodeId>,
    target: NodeId,
    max_hops: usize,
) -> Vec<Path> {
    let mut results = Vec::new();

    for &source in sources {
        if source == target {
            continue;
        }
        let mut visited = HashSet::new();
        visited.insert(source);
        let path = Path {
            edges: Vec::new(),
            nodes: vec![source],
        };
        dfs(graph, &mut visited, path, target, max_hops, &mut results);
    }

    results
}

fn dfs(
    graph: &Graph,
    visited: &mut HashSet<NodeId>,
    current_path: Path,
    target: NodeId,
    max_hops: usize,
    results: &mut Vec<Path>,
) {
    if current_path.hop_count() >= max_hops {
        return;
    }

    let current_node = *current_path.nodes.last().unwrap();

    for &edge_id in graph.outgoing_edges(current_node) {
        let edge = graph.edge(edge_id).unwrap();
        let next_node = edge.target;

        if visited.contains(&next_node) && next_node != target {
            continue;
        }
        if next_node != target && visited.contains(&next_node) {
            continue;
        }

        let mut new_path = current_path.clone();
        new_path.edges.push(edge_id);
        new_path.nodes.push(next_node);

        if next_node == target {
            results.push(new_path);
        } else {
            visited.insert(next_node);
            dfs(graph, visited, new_path, target, max_hops, results);
            visited.remove(&next_node);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::node::NodeKind;

    fn make_chain_graph() -> (Graph, NodeId, NodeId, NodeId) {
        // a -> b -> c
        let mut g = Graph::new();
        let a = g.add_node(NodeKind::VerseGist {
            chapter: 1,
            verse: 1,
        });
        let b = g.add_node(NodeKind::VerseGist {
            chapter: 1,
            verse: 2,
        });
        let c = g.add_node(NodeKind::VerseGist {
            chapter: 1,
            verse: 3,
        });
        g.add_edge(a, b);
        g.add_edge(b, c);
        (g, a, b, c)
    }

    #[test]
    fn finds_direct_path() {
        let (g, a, b, _c) = make_chain_graph();
        let sources = HashSet::from([a]);
        let paths = enumerate_paths(&g, &sources, b, MAX_HOPS);
        assert_eq!(paths.len(), 1);
        assert_eq!(paths[0].hop_count(), 1);
    }

    #[test]
    fn finds_two_hop_path() {
        let (g, a, _b, c) = make_chain_graph();
        let sources = HashSet::from([a]);
        let paths = enumerate_paths(&g, &sources, c, MAX_HOPS);
        assert_eq!(paths.len(), 1);
        assert_eq!(paths[0].hop_count(), 2);
    }

    #[test]
    fn respects_directionality() {
        let (g, _a, _b, c) = make_chain_graph();
        // c has no outgoing edges to a or b
        let sources = HashSet::from([c]);
        let a = NodeId(0);
        let paths = enumerate_paths(&g, &sources, a, MAX_HOPS);
        assert!(paths.is_empty(), "no path from c to a in a->b->c graph");
    }

    #[test]
    fn respects_hop_limit() {
        let mut g = Graph::new();
        let mut nodes = Vec::new();
        for i in 0..7 {
            nodes.push(g.add_node(NodeKind::VerseGist {
                chapter: 1,
                verse: i,
            }));
        }
        for i in 0..6 {
            g.add_edge(nodes[i], nodes[i + 1]);
        }

        let sources = HashSet::from([nodes[0]]);
        let paths_5 = enumerate_paths(&g, &sources, nodes[5], 5);
        assert_eq!(paths_5.len(), 1);

        let paths_6 = enumerate_paths(&g, &sources, nodes[6], 5);
        assert!(paths_6.is_empty(), "6-hop path should exceed limit");
    }

    #[test]
    fn no_node_revisits() {
        // a -> b -> c -> a (cycle). Should NOT find a path from a to a.
        let mut g = Graph::new();
        let a = g.add_node(NodeKind::VerseGist {
            chapter: 1,
            verse: 1,
        });
        let b = g.add_node(NodeKind::VerseGist {
            chapter: 1,
            verse: 2,
        });
        let c = g.add_node(NodeKind::VerseGist {
            chapter: 1,
            verse: 3,
        });
        g.add_edge(a, b);
        g.add_edge(b, c);
        g.add_edge(c, a);

        // Source = a, target = a: skip self
        let sources = HashSet::from([a]);
        let paths = enumerate_paths(&g, &sources, a, MAX_HOPS);
        assert!(paths.is_empty(), "should not find cycle paths");
    }

    #[test]
    fn multiple_sources() {
        let (g, a, _b, c) = make_chain_graph();
        // Both a and b are sources, target is c
        let b = NodeId(1);
        let sources = HashSet::from([a, b]);
        let paths = enumerate_paths(&g, &sources, c, MAX_HOPS);
        assert_eq!(paths.len(), 2, "should find a->b->c and b->c");
    }

    #[test]
    fn finds_parallel_paths() {
        // a -> b -> d, a -> c -> d
        let mut g = Graph::new();
        let a = g.add_node(NodeKind::VerseGist {
            chapter: 1,
            verse: 1,
        });
        let b = g.add_node(NodeKind::VerseGist {
            chapter: 1,
            verse: 2,
        });
        let c = g.add_node(NodeKind::VerseGist {
            chapter: 1,
            verse: 3,
        });
        let d = g.add_node(NodeKind::VerseGist {
            chapter: 1,
            verse: 4,
        });
        g.add_edge(a, b);
        g.add_edge(a, c);
        g.add_edge(b, d);
        g.add_edge(c, d);

        let sources = HashSet::from([a]);
        let paths = enumerate_paths(&g, &sources, d, MAX_HOPS);
        assert_eq!(paths.len(), 2, "should find a->b->d and a->c->d");
    }

    #[test]
    fn source_equals_target_yields_nothing() {
        let (g, a, _b, _c) = make_chain_graph();
        let sources = HashSet::from([a]);
        let paths = enumerate_paths(&g, &sources, a, MAX_HOPS);
        assert!(paths.is_empty());
    }
}
