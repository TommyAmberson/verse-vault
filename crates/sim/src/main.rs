//! Minimal HSRS-engine simulation loop.
//!
//! Loads the bundled `data/corinthians.json` fixture, builds a `ReviewEngine`,
//! then drives a fixed number of "ideal student" reviews — picking the next
//! due card and grading every test `Good`. Prints aggregate metrics so the
//! engine can be smoke-tested under real fixture data without hand-rolled
//! input.

use std::path::PathBuf;

use verse_vault_core::builder::build;
use verse_vault_core::content::MaterialData;
use verse_vault_core::engine::{ReviewEngine, UpdateKind};
use verse_vault_core::schedule::next_card;
use verse_vault_core::types::Grade;

mod metrics;

const DEFAULT_REVIEWS: usize = 100;
const SECONDS_PER_DAY: i64 = 86_400;

fn parse_reviews_arg() -> usize {
    let mut args = std::env::args().skip(1);
    while let Some(arg) = args.next() {
        if arg == "--reviews"
            && let Some(n) = args.next()
            && let Ok(parsed) = n.parse::<usize>()
        {
            return parsed;
        }
    }
    DEFAULT_REVIEWS
}

fn fixture_path() -> PathBuf {
    let mut p = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    p.push("../../data/corinthians.json");
    p
}

fn main() {
    let reviews = parse_reviews_arg();
    let path = fixture_path();
    let json = std::fs::read_to_string(&path).expect("corinthians fixture should exist");
    let material: MaterialData = serde_json::from_str(&json).expect("fixture parses");

    // Seed the build a year before "now" so initial retrievabilities have
    // decayed below the 0.9 target — otherwise `next_card` returns None.
    let build_time = SECONDS_PER_DAY * 365;
    let result = build(&material, 0);
    let total_cards = result.cards.len();
    let total_tests = result.tests.len();
    let mut engine = ReviewEngine::new(result, 0.9);

    let mut now = build_time;
    let mut completed = 0usize;
    let mut total_root = 0usize;
    let mut total_sub = 0usize;

    for _ in 0..reviews {
        // Step the clock forward each iteration to clear sibling cooldown.
        now += SECONDS_PER_DAY;
        let card_id = match next_card(&engine, now) {
            Some(id) => id,
            None => break,
        };
        let card = engine
            .card(card_id)
            .cloned()
            .expect("scheduler must point at an existing card");
        let atoms = engine.atoms_for(card.verse_id);
        if card.tests(&atoms).is_empty() {
            continue;
        }
        let outcome = engine.review(card_id, Grade::Good, now);
        for u in &outcome.updates {
            match u.kind {
                UpdateKind::Root => total_root += 1,
                UpdateKind::Sub => total_sub += 1,
            }
        }
        completed += 1;
    }

    println!(
        "verse-vault-sim: cards={total_cards} tests={total_tests} reviews_done={completed} \
         root_updates={total_root} sub_updates={total_sub}"
    );
}
