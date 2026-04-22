use std::collections::HashMap;

use crate::card::{Card, CardState};
use crate::card_types::{AtomRole, CardTypeDef, CardTypesConfig, parse_role};
use crate::content::MaterialData;
use crate::edge::{EdgeKind, EdgeState};
use crate::graph::Graph;
use crate::node::{ClubTier, NodeKind};
use crate::types::{CardId, NodeId};

const INITIAL_STABILITY: f32 = 1.0;
const INITIAL_DIFFICULTY: f32 = 5.0;
const INITIAL_AGE_DAYS: i64 = 365;
const FTV_MAX_WORDS: usize = 5;
/// Upper bound on verses per chapter (Psalm 119 has 176).
const MAX_VERSES_PER_CHAPTER: u16 = 200;

fn initial_state(now_secs: i64) -> EdgeState {
    EdgeState {
        stability: INITIAL_STABILITY,
        difficulty: INITIAL_DIFFICULTY,
        last_review_secs: now_secs - INITIAL_AGE_DAYS * 86400,
    }
}

/// Per-verse atom references for card generation.
#[derive(Debug, serde::Serialize, serde::Deserialize)]
pub struct VerseAtoms {
    pub ref_node: NodeId,
    pub verse_gist: NodeId,
    pub phrases: Vec<NodeId>,
    pub ftv: Option<NodeId>,
    pub heading: Option<NodeId>,
    pub next_heading: Option<NodeId>,
    pub prev_heading: Option<NodeId>,
}

/// Build result from content data.
#[derive(serde::Serialize, serde::Deserialize)]
pub struct BuildResult {
    pub graph: Graph,
    pub cards: Vec<Card>,
    pub verse_atoms: Vec<VerseAtoms>,
}

/// Build a graph and card catalog from content data and card type definitions.
/// `now_secs` is used to set initial edge last_review to `now - 365 days`.
pub fn build(data: &MaterialData, card_types: &CardTypesConfig, now_secs: i64) -> BuildResult {
    let mut graph = Graph::new();
    let state = initial_state(now_secs);

    // Chapter gist + ref nodes
    let mut chapter_gists: HashMap<(String, u16), NodeId> = HashMap::new();

    for ch in &data.chapters {
        let gist = graph.add_node(NodeKind::ChapterGist { chapter: ch.number });
        let cref = graph.add_node(NodeKind::ChapterRef { chapter: ch.number });
        graph.add_bi_edge_with_state(EdgeKind::ChapterGistChapterRef, gist, cref, state);
        chapter_gists.insert((ch.book.clone(), ch.number), gist);
    }

    // Heading nodes
    let mut heading_nodes: Vec<(NodeId, &crate::content::HeadingData)> = Vec::new();
    for h in &data.headings {
        let hid = graph.add_node(NodeKind::Heading {
            text: h.text.clone(),
            start_chapter: h.start_chapter,
            start_verse: h.start_verse,
            end_chapter: h.end_chapter,
            end_verse: h.end_verse,
        });
        heading_nodes.push((hid, h));
    }

    // Heading ↔ heading chain (bidirectional)
    for i in 1..heading_nodes.len() {
        let (prev_id, prev_h) = &heading_nodes[i - 1];
        let (curr_id, curr_h) = &heading_nodes[i];
        // Only chain headings within the same book
        if prev_h.book == curr_h.book {
            graph.add_bi_edge_with_state(EdgeKind::HeadingHeading, *prev_id, *curr_id, state);
        }
    }

    // Build heading lookup: (book, chapter, verse) -> heading node
    let heading_lookup = build_heading_lookup(&heading_nodes);

    // Verse nodes
    let mut verse_atoms_list: Vec<VerseAtoms> = Vec::new();
    let mut prev_verse_gist: Option<NodeId> = None;
    let mut prev_verse_book: Option<String> = None;

    // Club entry tracking
    let mut club150_entries: Vec<(NodeId, String, u16)> = Vec::new(); // (entry_id, book, verse)
    let mut club300_entries: Vec<(NodeId, String, u16)> = Vec::new();

    for verse_data in data.verses_with_text() {
        let ref_node = graph.add_node(NodeKind::VerseRef {
            chapter: verse_data.chapter,
            verse: verse_data.verse,
        });
        let verse_gist = graph.add_node(NodeKind::VerseGist {
            chapter: verse_data.chapter,
            verse: verse_data.verse,
        });

        // verse gist ↔ reference (bi)
        graph.add_bi_edge_with_state(EdgeKind::VerseGistVerseRef, verse_gist, ref_node, state);

        // verse gist → chapter gist (uni)
        if let Some(&ch_gist) = chapter_gists.get(&(verse_data.book.clone(), verse_data.chapter)) {
            graph.add_edge_with_state(
                EdgeKind::VerseGistChapterGist,
                verse_gist,
                ch_gist,
                Some(state),
            );
        }

        // Phrase nodes
        let mut phrase_nodes = Vec::new();
        for (pos, phrase_text) in verse_data.phrases.iter().enumerate() {
            let pid = graph.add_node(NodeKind::Phrase {
                text: phrase_text.clone(),
                verse_id: verse_data.verse as u32,
                position: pos as u16,
            });
            // phrase ↔ verse gist (bi)
            graph.add_bi_edge_with_state(EdgeKind::PhraseVerseGist, pid, verse_gist, state);
            phrase_nodes.push(pid);
        }

        // Phrase ↔ phrase chain (bi)
        for i in 1..phrase_nodes.len() {
            graph.add_bi_edge_with_state(
                EdgeKind::PhrasePhrase,
                phrase_nodes[i - 1],
                phrase_nodes[i],
                state,
            );
        }

        // FTV node (optional, ≤ 5 words)
        let ftv_node = if !verse_data.ftv.is_empty()
            && verse_data.ftv.split_whitespace().count() <= FTV_MAX_WORDS
            && !phrase_nodes.is_empty()
        {
            let ftv = graph.add_node(NodeKind::Ftv {
                text: verse_data.ftv.clone(),
            });
            // ftv → first phrase (uni)
            graph.add_edge_with_state(EdgeKind::FtvPhrase, ftv, phrase_nodes[0], Some(state));
            // ftv → verse gist (uni)
            graph.add_edge_with_state(EdgeKind::FtvVerseGist, ftv, verse_gist, Some(state));
            Some(ftv)
        } else {
            None
        };

        // Chapter-consecutive verse ↔ verse (bi)
        if let Some(prev_gist) = prev_verse_gist
            && prev_verse_book.as_deref() == Some(&verse_data.book)
        {
            graph.add_bi_edge_with_state(
                EdgeKind::VerseGistVerseGist,
                prev_gist,
                verse_gist,
                state,
            );
        }
        prev_verse_gist = Some(verse_gist);
        prev_verse_book = Some(verse_data.book.clone());

        // Heading association (verse gist → heading, uni)
        let heading_node = heading_lookup
            .get(&(
                verse_data.book.clone(),
                verse_data.chapter,
                verse_data.verse,
            ))
            .copied();
        if let Some(hid) = heading_node {
            graph.add_edge_with_state(EdgeKind::VerseGistHeading, verse_gist, hid, Some(state));
        }

        // Club entries
        for &club in &verse_data.clubs {
            let tier = match club {
                150 => ClubTier::Club150,
                300 => ClubTier::Club300,
                _ => continue,
            };
            let entry = graph.add_node(NodeKind::VerseClubMember {
                tier,
                chapter: verse_data.chapter,
                verse: verse_data.verse,
            });
            // ref ↔ club entry (bi)
            graph.add_bi_edge_with_state(EdgeKind::VerseRefVerseClubMember, ref_node, entry, state);

            match tier {
                ClubTier::Club150 => {
                    club150_entries.push((entry, verse_data.book.clone(), verse_data.verse));
                }
                ClubTier::Club300 => {
                    club300_entries.push((entry, verse_data.book.clone(), verse_data.verse));
                }
            }
        }

        // Find adjacent headings for card generation
        let heading_idx =
            heading_node.and_then(|hid| heading_nodes.iter().position(|(id, _)| *id == hid));
        let next_heading = heading_idx.and_then(|i| heading_nodes.get(i + 1).map(|(id, _)| *id));
        let prev_heading = heading_idx.and_then(|i| {
            i.checked_sub(1)
                .and_then(|j| heading_nodes.get(j))
                .map(|(id, _)| *id)
        });

        verse_atoms_list.push(VerseAtoms {
            ref_node,
            verse_gist,
            phrases: phrase_nodes,
            ftv: ftv_node,
            heading: heading_node,
            next_heading,
            prev_heading,
        });
    }

    // Club entry chains (uni)
    chain_club_entries(&mut graph, &club150_entries, state);
    chain_club_entries(&mut graph, &club300_entries, state);

    // Generate cards from card type definitions
    let cards = generate_cards(card_types, &verse_atoms_list);

    BuildResult {
        graph,
        cards,
        verse_atoms: verse_atoms_list,
    }
}

fn chain_club_entries(graph: &mut Graph, entries: &[(NodeId, String, u16)], state: EdgeState) {
    // Group by book, then chain within each book
    let mut by_book: HashMap<&str, Vec<(NodeId, u16)>> = HashMap::new();
    for (id, book, verse) in entries {
        by_book
            .entry(book.as_str())
            .or_default()
            .push((*id, *verse));
    }
    for (_, mut verses) in by_book {
        verses.sort_by_key(|(_, v)| *v);
        for i in 1..verses.len() {
            graph.add_edge_with_state(
                EdgeKind::VerseClubMemberVerseClubMember,
                verses[i - 1].0,
                verses[i].0,
                Some(state),
            );
        }
    }
}

fn build_heading_lookup(
    heading_nodes: &[(NodeId, &crate::content::HeadingData)],
) -> HashMap<(String, u16, u16), NodeId> {
    let mut lookup = HashMap::new();
    for (hid, h) in heading_nodes {
        // Map every verse in the heading's range to this heading
        if h.start_chapter == h.end_chapter {
            for v in h.start_verse..=h.end_verse {
                lookup.insert((h.book.clone(), h.start_chapter, v), *hid);
            }
        } else {
            // Cross-chapter heading: map all chapters in range
            for ch in h.start_chapter..=h.end_chapter {
                let start_v = if ch == h.start_chapter {
                    h.start_verse
                } else {
                    1
                };
                let end_v = if ch == h.end_chapter {
                    h.end_verse
                } else {
                    MAX_VERSES_PER_CHAPTER
                };
                for v in start_v..=end_v {
                    lookup.insert((h.book.clone(), ch, v), *hid);
                }
            }
        }
    }
    lookup
}

fn generate_cards(card_types: &CardTypesConfig, verse_atoms: &[VerseAtoms]) -> Vec<Card> {
    let mut cards = Vec::new();
    let mut next_id = 0u32;

    for atoms in verse_atoms {
        for card_type in &card_types.card_types {
            // Check requires
            if let Some(req) = &card_type.requires {
                let has_it = match req.as_str() {
                    "ftv" => atoms.ftv.is_some(),
                    "heading" => atoms.heading.is_some(),
                    "next_heading" => atoms.next_heading.is_some(),
                    "prev_heading" => atoms.prev_heading.is_some(),
                    _ => true,
                };
                if !has_it {
                    continue;
                }
            }

            if let Some(iterate) = &card_type.iterate {
                if iterate == "phrases" {
                    // Generate one card per phrase
                    for (idx, _) in atoms.phrases.iter().enumerate() {
                        if let Some(card) = resolve_card(card_type, atoms, Some(idx), &mut next_id)
                        {
                            cards.push(card);
                        }
                    }
                }
            } else if let Some(card) = resolve_card(card_type, atoms, None, &mut next_id) {
                cards.push(card);
            }
        }
    }

    cards
}

fn resolve_card(
    card_type: &CardTypeDef,
    atoms: &VerseAtoms,
    iterate_idx: Option<usize>,
    next_id: &mut u32,
) -> Option<Card> {
    let shown = resolve_roles(&card_type.show, atoms, iterate_idx)?;
    let hidden = resolve_roles(&card_type.hide, atoms, iterate_idx)?;

    if shown.is_empty() || hidden.is_empty() {
        return None;
    }

    let id = CardId(*next_id);
    *next_id += 1;
    Some(Card {
        id,
        shown,
        hidden,
        state: CardState::New,
    })
}

fn resolve_roles(
    roles: &[String],
    atoms: &VerseAtoms,
    iterate_idx: Option<usize>,
) -> Option<Vec<NodeId>> {
    let mut nodes = Vec::new();

    for role_str in roles {
        match parse_role(role_str)? {
            AtomRole::Ref => nodes.push(atoms.ref_node),
            AtomRole::Phrases => nodes.extend_from_slice(&atoms.phrases),
            AtomRole::FirstPhrase => {
                nodes.push(*atoms.phrases.first()?);
            }
            AtomRole::RemainingPhrases => {
                if atoms.phrases.len() > 1 {
                    nodes.extend_from_slice(&atoms.phrases[1..]);
                }
            }
            AtomRole::Current => {
                let idx = iterate_idx?;
                nodes.push(*atoms.phrases.get(idx)?);
            }
            AtomRole::PhrasesExceptCurrent => {
                let idx = iterate_idx?;
                for (i, &p) in atoms.phrases.iter().enumerate() {
                    if i != idx {
                        nodes.push(p);
                    }
                }
            }
            AtomRole::Ftv => nodes.push(atoms.ftv?),
            AtomRole::Heading => nodes.push(atoms.heading?),
            AtomRole::NextHeading => nodes.push(atoms.next_heading?),
            AtomRole::PrevHeading => nodes.push(atoms.prev_heading?),
            AtomRole::ChapterGist | AtomRole::ClubRefs => {
                // These need chapter-level context, handled separately
            }
        }
    }

    Some(nodes)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_data() -> MaterialData {
        serde_json::from_str(
            r#"{
            "year": 3,
            "books": ["1 Corinthians"],
            "chapters": [{"book": "1 Corinthians", "number": 1, "start_verse": 1, "end_verse": 3}],
            "verses": [
                {
                    "book": "1 Corinthians", "chapter": 1, "verse": 1,
                    "text": "Paul called to be an apostle",
                    "phrases": ["Paul called", "to be an apostle"],
                    "ftv": "Paul called",
                    "clubs": [150, 300]
                },
                {
                    "book": "1 Corinthians", "chapter": 1, "verse": 2,
                    "text": "To the church of God",
                    "phrases": ["To the church", "of God"],
                    "ftv": "To the",
                    "clubs": [300]
                },
                {
                    "book": "1 Corinthians", "chapter": 1, "verse": 3,
                    "text": "Grace to you and peace",
                    "phrases": ["Grace to you", "and peace"],
                    "ftv": "",
                    "clubs": []
                }
            ],
            "headings": [
                {
                    "text": "Greeting",
                    "book": "1 Corinthians",
                    "start_chapter": 1, "start_verse": 1,
                    "end_chapter": 1, "end_verse": 3
                }
            ]
        }"#,
        )
        .unwrap()
    }

    fn test_card_types() -> CardTypesConfig {
        CardTypesConfig::from_toml(include_str!("../card_types.toml")).unwrap()
    }

    #[test]
    fn builds_graph_from_content() {
        let data = test_data();
        let card_types = test_card_types();
        let result = build(&data, &card_types, 0);

        // 3 verses × (ref + gist + 2 phrases) + chapter gist + chapter ref + heading + FTV nodes + club entries
        assert!(
            result.graph.node_count() > 15,
            "should have many nodes: {}",
            result.graph.node_count()
        );
        assert!(
            result.graph.edge_count() > 20,
            "should have many edges: {}",
            result.graph.edge_count()
        );
    }

    #[test]
    fn generates_cards_from_types() {
        let data = test_data();
        let card_types = test_card_types();
        let result = build(&data, &card_types, 0);

        // Each verse with 2 phrases should get: full_recitation, 2x fill_in_blank,
        // first_phrase_to_rest, verse_to_ref = 5 cards. Plus FTV, heading cards.
        assert!(
            result.cards.len() >= 10,
            "should generate cards: {}",
            result.cards.len()
        );

        // Verify a full_recitation card exists
        let full_recit = result
            .cards
            .iter()
            .find(|c| c.shown.len() == 1 && c.hidden.len() == 2);
        assert!(full_recit.is_some(), "should have a full recitation card");
    }

    #[test]
    fn verse_context_works_on_built_graph() {
        let data = test_data();
        let card_types = test_card_types();
        let result = build(&data, &card_types, 0);

        let atoms = &result.verse_atoms[0];
        let (ref_id, phrases) = result.graph.verse_context(atoms.phrases[0]).unwrap();
        assert_eq!(ref_id, atoms.ref_node);
        assert_eq!(phrases.len(), 2);
    }

    #[test]
    fn club_entries_created() {
        let data = test_data();
        let card_types = test_card_types();
        let result = build(&data, &card_types, 0);

        // Verse 1 is in club 150 and 300
        let club_nodes: Vec<_> = result
            .graph
            .node_ids()
            .filter(|&id| {
                matches!(
                    result.graph.node_kind(id),
                    Some(NodeKind::VerseClubMember { .. })
                )
            })
            .collect();
        assert!(
            club_nodes.len() >= 3,
            "should have club entries: {}",
            club_nodes.len()
        );
    }

    #[test]
    fn ftv_nodes_created() {
        let data = test_data();
        let card_types = test_card_types();
        let result = build(&data, &card_types, 0);

        let ftv_nodes: Vec<_> = result
            .graph
            .node_ids()
            .filter(|&id| matches!(result.graph.node_kind(id), Some(NodeKind::Ftv { .. })))
            .collect();
        // Verse 1 and 2 have FTV (≤5 words), verse 3 has empty FTV
        assert_eq!(ftv_nodes.len(), 2, "should have 2 FTV nodes");
    }

    #[test]
    fn heading_edges_created() {
        let data = test_data();
        let card_types = test_card_types();
        let result = build(&data, &card_types, 0);

        // All 3 verses should have verse_gist → heading edges
        let heading_edges: Vec<_> = result
            .graph
            .edge_ids()
            .filter(|&id| {
                result
                    .graph
                    .edge(id)
                    .is_some_and(|e| matches!(e.kind, EdgeKind::VerseGistHeading))
            })
            .collect();
        assert_eq!(
            heading_edges.len(),
            3,
            "all 3 verses should link to heading"
        );
    }
}
