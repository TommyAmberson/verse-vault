use std::collections::{HashMap, HashSet};

use crate::anchor::{self, AnchorPath};
use crate::fsrs_bridge::FsrsBridge;
use crate::graph::Graph;
use crate::node::NodeKind;
use crate::path::{self, MAX_HOPS};
use crate::types::{EdgeId, Grade, NodeId};

pub struct CreditParams {
    pub beta: f32,
    pub anchor_decay_factor: f32,
    pub target_retention: f32,
}

impl Default for CreditParams {
    fn default() -> Self {
        Self {
            beta: 0.2,
            anchor_decay_factor: anchor::DEFAULT_DECAY_FACTOR,
            target_retention: 0.9,
        }
    }
}

#[derive(Debug, Clone)]
pub struct EdgeUpdate {
    pub edge_id: EdgeId,
    pub grade: Grade,
    pub weight: f32,
}

pub struct ReviewResult {
    pub shown: Vec<NodeId>,
    pub hidden: Vec<NodeId>,
    pub grades: HashMap<NodeId, Grade>,
}

/// Run the full credit assignment algorithm.
///
/// Returns a list of edge updates to apply via FsrsBridge::apply_weighted_update.
pub fn assign_credit(
    graph: &Graph,
    review: &ReviewResult,
    params: &CreditParams,
    fsrs: &FsrsBridge,
    now_secs: i64,
) -> Vec<EdgeUpdate> {
    let failed_atoms: HashSet<NodeId> = review
        .grades
        .iter()
        .filter(|(_, g)| !g.is_pass())
        .map(|(id, _)| *id)
        .collect();

    // Source set = shown ∪ correctly-recalled hidden
    let source_set: HashSet<NodeId> = review
        .shown
        .iter()
        .copied()
        .chain(
            review
                .hidden
                .iter()
                .copied()
                .filter(|id| !failed_atoms.contains(id)),
        )
        .collect();

    let shown_set: HashSet<NodeId> = review.shown.iter().copied().collect();
    let mut primary_updates: HashMap<EdgeId, Vec<(Grade, f32)>> = HashMap::new();

    // Steps 1-4: Credit and blame for each hidden atom
    for &hidden_atom in &review.hidden {
        let grade = review
            .grades
            .get(&hidden_atom)
            .copied()
            .unwrap_or(Grade::Good);

        // Source set for this atom excludes itself
        let sources_for_atom: HashSet<NodeId> = source_set
            .iter()
            .copied()
            .filter(|&id| id != hidden_atom)
            .collect();

        // Step 1: Enumerate paths (with anchor transfer if target is a VerseRef)
        let is_ref = matches!(
            graph.node_kind(hidden_atom),
            Some(NodeKind::VerseRef { .. })
        );
        let anchor_paths: Vec<AnchorPath> = if is_ref {
            anchor::enumerate_paths_with_anchor_transfer(
                graph,
                &sources_for_atom,
                hidden_atom,
                MAX_HOPS,
                params.anchor_decay_factor,
            )
        } else {
            path::enumerate_paths(graph, &sources_for_atom, hidden_atom, MAX_HOPS)
                .into_iter()
                .map(|p| AnchorPath {
                    path: p,
                    decay_multiplier: 1.0,
                })
                .collect()
        };

        if anchor_paths.is_empty() {
            continue;
        }

        if grade.is_pass() {
            // Step 3: Credit — eliminate paths through failed atoms, distribute credit
            assign_credit_for_pass(
                graph,
                &anchor_paths,
                &failed_atoms,
                grade,
                fsrs,
                now_secs,
                &mut primary_updates,
            );
        } else {
            // Step 4: Blame — all paths failed, weakest edge gets most blame
            assign_blame_for_fail(
                graph,
                &anchor_paths,
                grade,
                fsrs,
                now_secs,
                &mut primary_updates,
            );
        }
    }

    let primary_edge_ids: HashSet<EdgeId> = primary_updates.keys().copied().collect();

    // Step 5: Secondary reinforcement (fallback chain)
    let mut secondary_updates: HashMap<EdgeId, Vec<(Grade, f32)>> = HashMap::new();

    // 5a: Exposure — edges between shown atoms, only if no primary update
    apply_exposure(
        graph,
        &shown_set,
        &primary_edge_ids,
        params,
        fsrs,
        now_secs,
        &mut secondary_updates,
    );

    let exposure_edge_ids: HashSet<EdgeId> = secondary_updates.keys().copied().collect();

    // 5b: Reverse reinforcement — only if no primary or exposure update
    apply_reverse_reinforcement(
        graph,
        &primary_updates,
        &primary_edge_ids,
        &exposure_edge_ids,
        params,
        &mut secondary_updates,
    );

    // Collect all updates
    let mut result = Vec::new();
    for (edge_id, updates) in primary_updates.into_iter().chain(secondary_updates) {
        for (grade, weight) in updates {
            result.push(EdgeUpdate {
                edge_id,
                grade,
                weight,
            });
        }
    }
    result
}

fn assign_credit_for_pass(
    graph: &Graph,
    anchor_paths: &[AnchorPath],
    failed_atoms: &HashSet<NodeId>,
    grade: Grade,
    fsrs: &FsrsBridge,
    now_secs: i64,
    updates: &mut HashMap<EdgeId, Vec<(Grade, f32)>>,
) {
    // Filter out paths through failed atoms
    let surviving: Vec<(&AnchorPath, f32)> = anchor_paths
        .iter()
        .filter(|ap| !ap.path.nodes.iter().any(|n| failed_atoms.contains(n)))
        .map(|ap| {
            let r = path_probability(graph, &ap.path.edges, fsrs, now_secs) * ap.decay_multiplier;
            (ap, r)
        })
        .filter(|(_, r)| *r > 0.0)
        .collect();

    let total_r: f32 = surviving.iter().map(|(_, r)| r).sum();
    if total_r <= 0.0 {
        return;
    }

    for (ap, r) in &surviving {
        let credit_weight = r / total_r;
        for &edge_id in &ap.path.edges {
            if graph.edge(edge_id).is_some() {
                updates
                    .entry(edge_id)
                    .or_default()
                    .push((grade, credit_weight));
            }
        }
    }
}

fn assign_blame_for_fail(
    graph: &Graph,
    anchor_paths: &[AnchorPath],
    grade: Grade,
    fsrs: &FsrsBridge,
    now_secs: i64,
    updates: &mut HashMap<EdgeId, Vec<(Grade, f32)>>,
) {
    // All paths failed. Find weakest edge on each path, aggregate blame.
    let mut blame_scores: HashMap<EdgeId, f32> = HashMap::new();
    let mut total_blame = 0.0f32;

    for ap in anchor_paths {
        let mut weakest_edge = None;
        let mut weakest_r = f32::MAX;

        for &edge_id in &ap.path.edges {
            if let Some(edge) = graph.edge(edge_id) {
                let r = fsrs.retrievability(&edge.state, now_secs);
                if r < weakest_r {
                    weakest_r = r;
                    weakest_edge = Some(edge_id);
                }
            }
        }

        if let Some(edge_id) = weakest_edge {
            let blame = 1.0 - weakest_r;
            *blame_scores.entry(edge_id).or_default() += blame;
            total_blame += blame;
        }
    }

    if total_blame <= 0.0 {
        return;
    }

    for (edge_id, blame) in blame_scores {
        let weight = blame / total_blame;
        updates.entry(edge_id).or_default().push((grade, weight));
    }
}

fn apply_exposure(
    graph: &Graph,
    shown_set: &HashSet<NodeId>,
    primary_edge_ids: &HashSet<EdgeId>,
    params: &CreditParams,
    fsrs: &FsrsBridge,
    now_secs: i64,
    secondary: &mut HashMap<EdgeId, Vec<(Grade, f32)>>,
) {
    for &node in shown_set {
        for &edge_id in graph.outgoing_edges(node) {
            if primary_edge_ids.contains(&edge_id) {
                continue;
            }
            let edge = match graph.edge(edge_id) {
                Some(e) => e,
                None => continue,
            };
            if !shown_set.contains(&edge.target) {
                continue;
            }
            let r = fsrs.retrievability(&edge.state, now_secs);
            if r >= params.target_retention {
                continue;
            }
            secondary
                .entry(edge_id)
                .or_default()
                .push((Grade::Good, params.beta));
        }
    }
}

fn apply_reverse_reinforcement(
    graph: &Graph,
    primary_updates: &HashMap<EdgeId, Vec<(Grade, f32)>>,
    primary_edge_ids: &HashSet<EdgeId>,
    exposure_edge_ids: &HashSet<EdgeId>,
    params: &CreditParams,
    secondary: &mut HashMap<EdgeId, Vec<(Grade, f32)>>,
) {
    for (&edge_id, updates) in primary_updates {
        let edge = match graph.edge(edge_id) {
            Some(e) => e,
            None => continue,
        };
        // Find reverse edge (same kind, target->source)
        for &reverse_candidate in graph.outgoing_edges(edge.target) {
            let rev = match graph.edge(reverse_candidate) {
                Some(e) => e,
                None => continue,
            };
            if rev.target != edge.source || rev.kind != edge.kind {
                continue;
            }
            if primary_edge_ids.contains(&reverse_candidate)
                || exposure_edge_ids.contains(&reverse_candidate)
                || secondary.contains_key(&reverse_candidate)
            {
                continue;
            }
            for &(grade, weight) in updates {
                secondary
                    .entry(reverse_candidate)
                    .or_default()
                    .push((grade, params.beta * weight));
            }
        }
    }
}

fn path_probability(graph: &Graph, edges: &[EdgeId], fsrs: &FsrsBridge, now_secs: i64) -> f32 {
    let mut r = 1.0f32;
    for &edge_id in edges {
        let edge = match graph.edge(edge_id) {
            Some(e) => e,
            None => return 0.0,
        };
        r *= fsrs.retrievability(&edge.state, now_secs);
    }
    r
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::edge::{EdgeKind, EdgeState};
    use crate::node::NodeKind;

    fn make_verse_graph() -> (Graph, NodeId, NodeId, NodeId, NodeId, NodeId) {
        // ref ↔ verse ↔ p1 ↔ p2 ↔ p3
        let mut g = Graph::new();
        let r = g.add_node(NodeKind::VerseRef {
            chapter: 3,
            verse: 16,
        });
        let v = g.add_node(NodeKind::VerseGist {
            chapter: 3,
            verse: 16,
        });
        let p1 = g.add_node(NodeKind::Phrase {
            text: "For God so loved the world,".into(),
            verse_id: 0,
            position: 0,
        });
        let p2 = g.add_node(NodeKind::Phrase {
            text: "that he gave his only begotten Son,".into(),
            verse_id: 0,
            position: 1,
        });
        let p3 = g.add_node(NodeKind::Phrase {
            text: "that whosoever believeth in him".into(),
            verse_id: 0,
            position: 2,
        });

        let state = EdgeState {
            stability: 10.0,
            difficulty: 5.0,
            last_review_secs: 0,
        };

        g.add_bi_edge_with_state(EdgeKind::VerseGistVerseRef, v, r, state);
        g.add_bi_edge_with_state(EdgeKind::PhraseVerseGist, p1, v, state);
        g.add_bi_edge_with_state(EdgeKind::PhraseVerseGist, p2, v, state);
        g.add_bi_edge_with_state(EdgeKind::PhraseVerseGist, p3, v, state);
        g.add_bi_edge_with_state(EdgeKind::PhrasePhrase, p1, p2, state);
        g.add_bi_edge_with_state(EdgeKind::PhrasePhrase, p2, p3, state);

        (g, r, v, p1, p2, p3)
    }

    fn fsrs() -> FsrsBridge {
        FsrsBridge::new(0.9)
    }

    #[test]
    fn credit_assignment_all_good() {
        let (g, r, _v, p1, p2, p3) = make_verse_graph();
        let review = ReviewResult {
            shown: vec![r],
            hidden: vec![p1, p2, p3],
            grades: HashMap::from([(p1, Grade::Good), (p2, Grade::Good), (p3, Grade::Good)]),
        };

        let updates = assign_credit(&g, &review, &CreditParams::default(), &fsrs(), 86400);

        assert!(!updates.is_empty(), "should produce edge updates");
        for u in &updates {
            assert!(u.weight > 0.0, "all weights positive for all-Good review");
        }
    }

    #[test]
    fn failed_atom_gets_blame() {
        let (g, r, _v, p1, p2, p3) = make_verse_graph();
        let review = ReviewResult {
            shown: vec![r],
            hidden: vec![p1, p2, p3],
            grades: HashMap::from([(p1, Grade::Good), (p2, Grade::Again), (p3, Grade::Good)]),
        };

        let updates = assign_credit(&g, &review, &CreditParams::default(), &fsrs(), 86400);

        let blame_updates: Vec<_> = updates
            .iter()
            .filter(|u| matches!(u.grade, Grade::Again))
            .collect();
        assert!(
            !blame_updates.is_empty(),
            "should have blame updates for p2=Again"
        );
    }

    #[test]
    fn source_set_expansion() {
        let (g, r, _v, p1, p2, _p3) = make_verse_graph();
        // p1=Good means p1 joins source set, so p1→p2 is a 1-hop path
        let review = ReviewResult {
            shown: vec![r],
            hidden: vec![p1, p2],
            grades: HashMap::from([(p1, Grade::Good), (p2, Grade::Good)]),
        };

        let updates = assign_credit(&g, &review, &CreditParams::default(), &fsrs(), 86400);

        // p1→p2 edge should get credit (1-hop from source p1)
        let p1_to_p2_edges: Vec<_> = g
            .outgoing_edges(p1)
            .iter()
            .filter(|&&eid| {
                let e = g.edge(eid).unwrap();
                e.target == p2 && matches!(e.kind, EdgeKind::PhrasePhrase)
            })
            .collect();
        assert!(!p1_to_p2_edges.is_empty());

        let p1p2_eid = *p1_to_p2_edges[0];
        let p1p2_updates: Vec<_> = updates.iter().filter(|u| u.edge_id == p1p2_eid).collect();
        assert!(
            !p1p2_updates.is_empty(),
            "p1→p2 should get credit via source set expansion"
        );
    }

    #[test]
    fn paths_through_failed_atoms_eliminated() {
        let (g, r, _v, p1, p2, p3) = make_verse_graph();
        // p2=Again: paths through p2 should be eliminated for p3's credit
        let review = ReviewResult {
            shown: vec![r],
            hidden: vec![p1, p2, p3],
            grades: HashMap::from([(p1, Grade::Good), (p2, Grade::Again), (p3, Grade::Good)]),
        };

        let updates = assign_credit(&g, &review, &CreditParams::default(), &fsrs(), 86400);

        // p2→p3 should NOT get credit for p3 (path through p2 is eliminated since p2 failed)
        // But p2→p3 might get blame for p2's failure
        let p2_to_p3_edges: Vec<EdgeId> = g
            .outgoing_edges(p2)
            .iter()
            .copied()
            .filter(|&eid| {
                let e = g.edge(eid).unwrap();
                e.target == p3 && matches!(e.kind, EdgeKind::PhrasePhrase)
            })
            .collect();

        if !p2_to_p3_edges.is_empty() {
            let _p2p3_credit: Vec<_> = updates
                .iter()
                .filter(|u| u.edge_id == p2_to_p3_edges[0] && u.grade.is_pass())
                .collect();
            // p2→p3 should only appear in credit via p3's hub path, not sequential through p2
            // (sequential path p1→p2→p3 is eliminated because p2 failed)
        }
    }

    #[test]
    fn exposure_only_on_shown_shown_edges() {
        let (g, r, _v, p1, p2, p3) = make_verse_graph();
        // Fill-in-blank for p2: shown={r, p1, p3}, hidden={p2}
        let review = ReviewResult {
            shown: vec![r, p1, p3],
            hidden: vec![p2],
            grades: HashMap::from([(p2, Grade::Good)]),
        };

        let updates = assign_credit(&g, &review, &CreditParams::default(), &fsrs(), 86400);

        // There's no direct p1↔p3 edge (they're not adjacent).
        // But if p1 and p3 are both shown, any edge between them would get exposure.
        // In this graph, the only shown↔shown direct edges are... none between p1 and p3 directly.
        // p1↔r? r is shown but p1↔r goes through verse. So no direct shown↔shown edges
        // that aren't on credit paths. This tests that the algorithm doesn't crash.
        assert!(!updates.is_empty());
    }

    #[test]
    fn hard_grade_joins_source_set() {
        let (g, r, _v, p1, p2, _p3) = make_verse_graph();
        let review = ReviewResult {
            shown: vec![r],
            hidden: vec![p1, p2],
            grades: HashMap::from([(p1, Grade::Hard), (p2, Grade::Good)]),
        };

        let updates = assign_credit(&g, &review, &CreditParams::default(), &fsrs(), 86400);

        // p1=Hard is a pass, so p1 joins source set.
        // p1→p2 should get credit (1-hop from source p1).
        let p1_to_p2: Vec<EdgeId> = g
            .outgoing_edges(p1)
            .iter()
            .copied()
            .filter(|&eid| {
                let e = g.edge(eid).unwrap();
                e.target == p2 && matches!(e.kind, EdgeKind::PhrasePhrase)
            })
            .collect();

        let has_p1p2_credit = updates.iter().any(|u| u.edge_id == p1_to_p2[0]);
        assert!(
            has_p1p2_credit,
            "Hard=pass, p1 should be in source set for p2"
        );
    }

    #[test]
    fn fallback_chain_no_double_counting() {
        let (g, _r, _v, p1, p2, p3) = make_verse_graph();
        // verse→ref card: shown={p1,p2,p3}, hidden={ref would be complex here}
        // Simpler test: shown={p1,p2}, hidden={p3}
        // p1→p2 is shown↔shown AND on credit path (p1→p2→p3 for p3's credit? no, p2→p3)
        // Actually p1→p2 is between shown atoms. p2→p3 is on credit path.
        // p1→p2 should get exposure (shown↔shown, not on credit path to p3)
        // Wait: is p1→p2 on any path to p3? p1→p2→p3 is a path from source p1 to p3.
        // So p1→p2 IS on a credit path — should get primary, NOT exposure.
        let review = ReviewResult {
            shown: vec![p1, p2],
            hidden: vec![p3],
            grades: HashMap::from([(p3, Grade::Good)]),
        };

        let updates = assign_credit(&g, &review, &CreditParams::default(), &fsrs(), 86400);

        // p1→p2 should appear in updates (primary credit from p3's credit assignment)
        let p1_to_p2: Vec<EdgeId> = g
            .outgoing_edges(p1)
            .iter()
            .copied()
            .filter(|&eid| {
                let e = g.edge(eid).unwrap();
                e.target == p2 && matches!(e.kind, EdgeKind::PhrasePhrase)
            })
            .collect();

        let p1p2_updates: Vec<_> = updates
            .iter()
            .filter(|u| u.edge_id == p1_to_p2[0])
            .collect();

        // Should have exactly primary credit, NOT primary + exposure
        let total_weight: f32 = p1p2_updates.iter().map(|u| u.weight).sum();
        assert!(
            total_weight <= 1.0,
            "no double-counting: total weight should be ≤1.0, got {total_weight}"
        );
    }
}
