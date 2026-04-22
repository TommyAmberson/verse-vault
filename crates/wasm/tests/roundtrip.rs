//! Verifies the JSON shape used for WASM boundary loading.
//! Run with: cargo test -p verse-vault-wasm

use verse_vault_core::card::{Card, CardState};
use verse_vault_core::edge::EdgeKind;
use verse_vault_core::graph::Graph;
use verse_vault_core::node::NodeKind;
use verse_vault_core::types::{CardId, NodeId};

#[test]
fn print_graph_json_shape() {
    let mut g = Graph::new();
    let r = g.add_node(NodeKind::VerseRef {
        chapter: 3,
        verse: 16,
    });
    let v = g.add_node(NodeKind::VerseGist {
        chapter: 3,
        verse: 16,
    });
    g.add_bi_edge(EdgeKind::VerseGistVerseRef, v, r);

    let graph_json = serde_json::to_string_pretty(&g).unwrap();
    println!("Graph JSON:\n{graph_json}");

    let card = Card {
        id: CardId(0),
        shown: vec![r],
        hidden: vec![v],
        state: CardState::New,
    };
    let card_json = serde_json::to_string_pretty(&card).unwrap();
    println!("Card JSON:\n{card_json}");

    let id = NodeId(42);
    println!("NodeId JSON: {}", serde_json::to_string(&id).unwrap());

    // Roundtrip the graph
    let parsed: Graph = serde_json::from_str(&graph_json).unwrap();
    assert_eq!(parsed.node_count(), 2);
}
