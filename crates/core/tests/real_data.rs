use std::fs;

use verse_vault_core::builder;
use verse_vault_core::card_types::CardTypesConfig;
use verse_vault_core::content::MaterialData;
use verse_vault_core::engine::ReviewEngine;
use verse_vault_core::node::NodeKind;

fn load_corinthians() -> Option<(MaterialData, CardTypesConfig)> {
    let workspace = env!("CARGO_MANIFEST_DIR");
    let json_path = format!("{workspace}/../../data/corinthians.json");
    let json_str = fs::read_to_string(&json_path).ok()?;
    let data = MaterialData::from_json(&json_str).ok()?;

    let toml_str = include_str!("../card_types.toml");
    let card_types = CardTypesConfig::from_toml(toml_str).ok()?;

    Some((data, card_types))
}

#[test]
fn build_graph_from_corinthians() {
    let (data, card_types) = match load_corinthians() {
        Some(d) => d,
        None => {
            eprintln!("Skipping: data/corinthians.json not found (run chunking pipeline first)");
            return;
        }
    };

    let verses_with_text = data.verses_with_text().count();
    println!("Verses with text: {verses_with_text}");

    let result = builder::build(&data, &card_types, 0);

    println!("Nodes: {}", result.graph.node_count());
    println!("Edges: {}", result.graph.edge_count());
    println!("Cards: {}", result.cards.len());
    println!("Verse atoms: {}", result.verse_atoms.len());

    // Verify reasonable counts
    assert!(result.graph.node_count() > 1000, "should have many nodes");
    assert!(result.graph.edge_count() > 3000, "should have many edges");
    assert!(result.cards.len() > 1000, "should have many cards");
    assert_eq!(result.verse_atoms.len(), verses_with_text);

    // Verify node types exist
    let phrase_count = result
        .graph
        .node_ids()
        .filter(|&id| matches!(result.graph.node_kind(id), Some(NodeKind::Phrase { .. })))
        .count();
    let ref_count = result
        .graph
        .node_ids()
        .filter(|&id| matches!(result.graph.node_kind(id), Some(NodeKind::Reference { .. })))
        .count();
    let ftv_count = result
        .graph
        .node_ids()
        .filter(|&id| matches!(result.graph.node_kind(id), Some(NodeKind::Ftv { .. })))
        .count();
    let heading_count = result
        .graph
        .node_ids()
        .filter(|&id| matches!(result.graph.node_kind(id), Some(NodeKind::Heading { .. })))
        .count();
    let club_count = result
        .graph
        .node_ids()
        .filter(|&id| matches!(result.graph.node_kind(id), Some(NodeKind::ClubEntry { .. })))
        .count();

    println!("Phrases: {phrase_count}");
    println!("References: {ref_count}");
    println!("FTV nodes: {ftv_count}");
    println!("Headings: {heading_count}");
    println!("Club entries: {club_count}");

    assert_eq!(ref_count, verses_with_text);
    assert!(
        phrase_count > verses_with_text,
        "should have more phrases than verses"
    );
    assert!(ftv_count > 0, "should have FTV nodes");
    assert!(heading_count > 0, "should have heading nodes");
    assert!(club_count > 0, "should have club entries");
}

#[test]
#[ignore] // slow: computes schedules for ~5,853 cards with path enumeration
fn engine_from_corinthians() {
    let (data, card_types) = match load_corinthians() {
        Some(d) => d,
        None => {
            eprintln!("Skipping: data/corinthians.json not found");
            return;
        }
    };

    let result = builder::build(&data, &card_types, 0);
    let engine = ReviewEngine::new(result.graph, result.cards, 0.9);

    println!("Schedules: {}", engine.schedules.len());

    // At t=0, nothing should be due (all edges just initialized)
    let due_now = engine.next_card(0);
    assert!(due_now.is_none(), "nothing due at t=0");

    // At t=30 days, cards should be due
    let day30 = 30 * 86400;
    let due_later = engine.next_card(day30);
    assert!(due_later.is_some(), "cards should be due at t=30d");
}
