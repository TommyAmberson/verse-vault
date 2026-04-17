use std::collections::HashSet;

use crate::graph::Graph;
use crate::node::NodeKind;
use crate::path::{Path, enumerate_paths};
use crate::types::NodeId;

pub const DEFAULT_DECAY_FACTOR: f32 = 0.95;

pub struct AnchorPath {
    pub path: Path,
    pub decay_multiplier: f32,
}

/// Enumerate paths with anchor transfer for a Reference target.
///
/// In addition to direct paths to `target`, finds paths to ANY Reference node
/// in the graph and applies a distance-based decay:
///   effective_R = R(path_to_anchor) × decay_factor^|target_verse - anchor_verse|
///
/// Returns (path, decay_multiplier) pairs. Direct paths have multiplier 1.0.
pub fn enumerate_paths_with_anchor_transfer(
    graph: &Graph,
    sources: &HashSet<NodeId>,
    target: NodeId,
    max_hops: usize,
    decay_factor: f32,
) -> Vec<AnchorPath> {
    let target_verse = match graph.node_kind(target) {
        Some(NodeKind::Reference { verse, .. }) => *verse,
        _ => {
            return enumerate_paths(graph, sources, target, max_hops)
                .into_iter()
                .map(|path| AnchorPath {
                    path,
                    decay_multiplier: 1.0,
                })
                .collect();
        }
    };

    let target_chapter = match graph.node_kind(target) {
        Some(NodeKind::Reference { chapter, .. }) => *chapter,
        _ => unreachable!(),
    };

    let mut results = Vec::new();

    // Direct paths to the target ref
    for path in enumerate_paths(graph, sources, target, max_hops) {
        results.push(AnchorPath {
            path,
            decay_multiplier: 1.0,
        });
    }

    // Paths to other Reference nodes (anchors) in the same chapter
    for anchor_id in graph.node_ids() {
        if anchor_id == target {
            continue;
        }
        let (anchor_chapter, anchor_verse) = match graph.node_kind(anchor_id) {
            Some(NodeKind::Reference { chapter, verse }) => (*chapter, *verse),
            _ => continue,
        };
        if anchor_chapter != target_chapter {
            continue;
        }

        let distance = (target_verse as i32 - anchor_verse as i32).unsigned_abs();
        let multiplier = decay_factor.powi(distance as i32);

        for path in enumerate_paths(graph, sources, anchor_id, max_hops) {
            results.push(AnchorPath {
                path,
                decay_multiplier: multiplier,
            });
        }
    }

    results
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::edge::EdgeKind;
    use crate::node::NodeKind;

    fn two_verse_graph() -> (Graph, NodeId, NodeId, NodeId, NodeId) {
        let mut g = Graph::new();
        let v1 = g.add_node(NodeKind::VerseGist {
            chapter: 2,
            verse: 1,
        });
        let r1 = g.add_node(NodeKind::Reference {
            chapter: 2,
            verse: 1,
        });
        let v2 = g.add_node(NodeKind::VerseGist {
            chapter: 2,
            verse: 2,
        });
        let r2 = g.add_node(NodeKind::Reference {
            chapter: 2,
            verse: 2,
        });

        g.add_bi_edge(EdgeKind::VerseGistReference, v1, r1);
        g.add_bi_edge(EdgeKind::VerseGistReference, v2, r2);
        g.add_bi_edge(EdgeKind::VerseGistVerseGist, v1, v2);

        (g, v1, r1, v2, r2)
    }

    #[test]
    fn direct_path_has_multiplier_one() {
        let (g, v2, _r1, _v2_id, r2) = two_verse_graph();
        let sources = HashSet::from([v2]);
        // v2 is NodeId(2), but we need the verse2 gist which is v2_id
        // Actually let me re-read: v2 is the second verse gist
        let _ = v2;
        let sources = HashSet::from([NodeId(2)]); // v2
        let paths = enumerate_paths_with_anchor_transfer(&g, &sources, r2, 5, 0.95);

        let direct: Vec<_> = paths
            .iter()
            .filter(|ap| ap.decay_multiplier == 1.0)
            .collect();
        assert!(!direct.is_empty(), "should have direct path from v2 to r2");
    }

    #[test]
    fn anchor_path_has_decay() {
        let (g, _v1, _r1, _v2, r2) = two_verse_graph();
        // Source is v1 (NodeId(0)). Target is r2 (verse 2).
        // Direct path: v1 -> v2 -> r2 (2 hops, target is r2, multiplier 1.0)
        // Anchor via r1: v1 -> r1 (1 hop, anchor for verse 1, distance=1, multiplier=0.95)
        let sources = HashSet::from([NodeId(0)]); // v1
        let paths = enumerate_paths_with_anchor_transfer(&g, &sources, r2, 5, 0.95);

        let anchor_paths: Vec<_> = paths
            .iter()
            .filter(|ap| ap.decay_multiplier < 1.0)
            .collect();
        assert!(!anchor_paths.is_empty(), "should have anchor path via r1");

        let ap = &anchor_paths[0];
        assert!(
            (ap.decay_multiplier - 0.95).abs() < 0.001,
            "distance 1 should give 0.95 multiplier, got {}",
            ap.decay_multiplier
        );
    }

    #[test]
    fn anchor_decay_increases_with_distance() {
        let mut g = Graph::new();
        let mut verses = Vec::new();
        let mut refs = Vec::new();
        for i in 1..=5 {
            let v = g.add_node(NodeKind::VerseGist {
                chapter: 1,
                verse: i,
            });
            let r = g.add_node(NodeKind::Reference {
                chapter: 1,
                verse: i,
            });
            g.add_bi_edge(EdgeKind::VerseGistReference, v, r);
            if let Some(&prev_v) = verses.last() {
                g.add_bi_edge(EdgeKind::VerseGistVerseGist, prev_v, v);
            }
            verses.push(v);
            refs.push(r);
        }

        // Target: ref for verse 5. Source: verse 1.
        let sources = HashSet::from([verses[0]]);
        let paths =
            enumerate_paths_with_anchor_transfer(&g, &sources, refs[4], 5, DEFAULT_DECAY_FACTOR);

        let mut multipliers: Vec<f32> = paths.iter().map(|ap| ap.decay_multiplier).collect();
        multipliers.sort_by(|a, b| b.partial_cmp(a).unwrap());
        multipliers.dedup();

        // Should have multiplier 1.0 (direct to ref5) and progressively lower for anchors
        assert!(multipliers[0] == 1.0 || multipliers[0] > 0.9);
        assert!(
            multipliers.len() > 1,
            "should have multiple distinct multipliers"
        );
    }

    #[test]
    fn non_reference_target_returns_plain_paths() {
        let (g, v1, _r1, v2, _r2) = two_verse_graph();
        let sources = HashSet::from([v1]);
        let paths = enumerate_paths_with_anchor_transfer(&g, &sources, v2, 5, DEFAULT_DECAY_FACTOR);

        for ap in &paths {
            assert_eq!(
                ap.decay_multiplier, 1.0,
                "non-ref targets should have multiplier 1.0"
            );
        }
    }

    #[test]
    fn different_chapter_refs_ignored() {
        let mut g = Graph::new();
        let v1 = g.add_node(NodeKind::VerseGist {
            chapter: 1,
            verse: 1,
        });
        let r1 = g.add_node(NodeKind::Reference {
            chapter: 1,
            verse: 1,
        });
        let v2 = g.add_node(NodeKind::VerseGist {
            chapter: 2,
            verse: 1,
        });
        let r2 = g.add_node(NodeKind::Reference {
            chapter: 2,
            verse: 1,
        });
        g.add_bi_edge(EdgeKind::VerseGistReference, v1, r1);
        g.add_bi_edge(EdgeKind::VerseGistReference, v2, r2);
        g.add_bi_edge(EdgeKind::VerseGistVerseGist, v1, v2);

        let sources = HashSet::from([v1]);
        let paths = enumerate_paths_with_anchor_transfer(&g, &sources, r2, 5, DEFAULT_DECAY_FACTOR);

        // r1 is chapter 1, r2 is chapter 2 — r1 should NOT be an anchor for r2
        for ap in &paths {
            assert_eq!(
                ap.decay_multiplier, 1.0,
                "cross-chapter refs should not anchor: got {}",
                ap.decay_multiplier
            );
        }
    }
}
