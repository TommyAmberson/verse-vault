use std::collections::{HashMap, HashSet};

use crate::card::{Card, CardKind, CardState, VerseAtoms};
use crate::content::{HeadingData, MaterialData};
use crate::element::ClubTier;
use crate::material_config::MaterialConfig;
use crate::render::{HeadingRender, VerseRender};
use crate::test_kind::TestKey;
use crate::test_state::TestState;
use crate::types::CardId;
use crate::verse_index::{VerseElements, VerseIndex};

/// Maximum FTV word count. Beyond this an FTV is too long to be a useful prompt.
const FTV_MAX_WORDS: usize = 5;
/// Upper bound on verses per chapter (Psalm 119 has 176). Used by the heading
/// lookup when a heading spans multiple chapters.
const MAX_VERSES_PER_CHAPTER: u16 = 200;

/// Build result from content data.
#[derive(Debug, Default)]
pub struct BuildResult {
    pub verse_index: VerseIndex,
    pub cards: Vec<Card>,
    pub tests: HashMap<TestKey, TestState>,
    /// Per-verse atom data (phrase_count + ftv + phrase_zero_text). The
    /// engine consumes this so it can rebuild a `VerseAtoms` for any verse
    /// at review/scheduling time without re-deriving from the source
    /// `MaterialData`.
    pub verse_atoms_data: HashMap<u32, VerseAtoms>,
    /// Per-verse rendering data (book / chapter / verse number, full text,
    /// phrase strings, ftv, heading labels, club tiers). Retained so
    /// frontends can render any card without re-parsing the source
    /// `MaterialData`.
    pub verse_render_data: HashMap<u32, VerseRender>,
}

/// Parse a raw tier list (as written in `VerseData.clubs`) into the
/// concrete `ClubTier` carried by VerseInClub / VerseClubBinding. The
/// quizzer's tier-subset rule (a Club-150 verse is implicitly also in
/// Club 300) is *not* expanded here: each verse is associated with one
/// most-specific tier, since the broader membership is trivially known
/// and the user shouldn't be asked the same "what club?" twice per verse.
fn parse_tiers(raw: &[u16]) -> Vec<ClubTier> {
    let mut tiers: Vec<ClubTier> = Vec::new();
    for &n in raw {
        let t = match n {
            150 => ClubTier::Club150,
            300 => ClubTier::Club300,
            _ => continue,
        };
        if !tiers.contains(&t) {
            tiers.push(t);
        }
    }
    tiers
}

/// `(book, chapter, verse) -> heading_idx` for the first heading whose range
/// covers that verse. Mirrors the legacy builder's lookup semantics.
fn build_heading_lookup(headings: &[HeadingData]) -> HashMap<(String, u16, u16), u16> {
    let mut lookup: HashMap<(String, u16, u16), u16> = HashMap::new();
    for (idx, h) in headings.iter().enumerate() {
        let idx = idx as u16;
        if h.start_chapter == h.end_chapter {
            for v in h.start_verse..=h.end_verse {
                lookup
                    .entry((h.book.clone(), h.start_chapter, v))
                    .or_insert(idx);
            }
        } else {
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
                    lookup.entry((h.book.clone(), ch, v)).or_insert(idx);
                }
            }
        }
    }
    lookup
}

/// Build cards and seeded test states from material data, with the default
/// (everything-on) `MaterialConfig`. Convenience wrapper around
/// [`build_with_config`] for callers (sim, tests) that don't filter.
pub fn build(data: &MaterialData, now_secs: i64) -> BuildResult {
    build_with_config(data, &MaterialConfig::default(), now_secs)
}

/// Build cards and seeded test states from material data.
///
/// Verses are assigned `verse_id`s in `data.verses_with_content()` order
/// starting at 0. `now_secs` is used to seed `TestState::new_unseen` for every
/// test reachable from any emitted card.
///
/// `config` controls which card kinds the builder emits. See
/// [`MaterialConfig`] for the toggles and the always-on cards that ignore
/// it.
pub fn build_with_config(
    data: &MaterialData,
    config: &MaterialConfig,
    now_secs: i64,
) -> BuildResult {
    let heading_lookup = build_heading_lookup(&data.headings);

    let mut verse_index = VerseIndex::new();
    let mut cards: Vec<Card> = Vec::new();
    let mut next_card_id: u32 = 0;
    // Per-verse VerseAtoms so we can compute `card.tests(...)` after all cards
    // are emitted and feed them into the test-state seed map.
    let mut verse_atoms_by_id: HashMap<u32, VerseAtoms> = HashMap::new();
    let mut verse_render_by_id: HashMap<u32, VerseRender> = HashMap::new();

    for (verse_id_usize, verse) in data.verses_with_content().enumerate() {
        let verse_id = verse_id_usize as u32;
        let phrase_count = verse.phrase_word_counts.len() as u16;
        let phrases: Vec<u16> = (0..phrase_count).collect();
        let phrase_zero_word_count = verse.phrase_word_counts.first().copied().unwrap_or(0);

        let heading_idx = heading_lookup
            .get(&(verse.book.clone(), verse.chapter, verse.verse))
            .copied();
        let headings: Vec<u16> = heading_idx.into_iter().collect();

        let clubs = parse_tiers(&verse.clubs);

        verse_index.add_verse(
            verse_id,
            VerseElements {
                phrases: phrases.clone(),
                headings: headings.clone(),
                clubs: clubs.clone(),
            },
        );

        // ---- Emit cards ----
        let push_card = |kind: CardKind, cards: &mut Vec<Card>, next: &mut u32| {
            cards.push(Card {
                id: CardId(*next),
                kind,
                verse_id,
                state: CardState::New,
            });
            *next += 1;
        };

        // Atomic: PhraseFill (one per phrase).
        for &p in &phrases {
            push_card(
                CardKind::PhraseFill { position: p },
                &mut cards,
                &mut next_card_id,
            );
        }

        // Atomic: per-verse bindings
        push_card(CardKind::VerseAtVerseRef, &mut cards, &mut next_card_id);
        push_card(CardKind::VerseInChapter, &mut cards, &mut next_card_id);
        push_card(CardKind::VerseInBook, &mut cards, &mut next_card_id);
        if config.headings {
            for &h_idx in &headings {
                push_card(
                    CardKind::VerseInHeading { heading_idx: h_idx },
                    &mut cards,
                    &mut next_card_id,
                );
            }
        }
        for &tier in &clubs {
            push_card(
                CardKind::VerseInClub { tier },
                &mut cards,
                &mut next_card_id,
            );
        }

        // Composite: Recitation (always — core mechanic).
        push_card(CardKind::Recitation, &mut cards, &mut next_card_id);
        if config.citation {
            push_card(CardKind::Citation, &mut cards, &mut next_card_id);
        }

        // Composite: Ftv (with and without citation). Eligibility:
        // verse has phrases, FTV is short enough, FTV doesn't exceed
        // phrase 0 length. derive_structure verified the prefix invariant
        // when emitting ftv_word_count, so we trust it here.
        if config.ftv
            && let Some(ftv_words) = verse.ftv_word_count
            && phrase_count > 0
            && (ftv_words as usize) <= FTV_MAX_WORDS
            && ftv_words <= phrase_zero_word_count
        {
            push_card(
                CardKind::Ftv {
                    with_citation: false,
                },
                &mut cards,
                &mut next_card_id,
            );
            push_card(
                CardKind::Ftv {
                    with_citation: true,
                },
                &mut cards,
                &mut next_card_id,
            );
        }

        let heading_renders: Vec<HeadingRender> = headings
            .iter()
            .filter_map(|&h_idx| {
                data.headings.get(h_idx as usize).map(|h| HeadingRender {
                    heading_idx: h_idx,
                    start_chapter: h.start_chapter,
                    start_verse: h.start_verse,
                    end_chapter: h.end_chapter,
                    end_verse: h.end_verse,
                })
            })
            .collect();

        verse_render_by_id.insert(
            verse_id,
            VerseRender {
                book: verse.book.clone(),
                chapter: verse.chapter,
                verse: verse.verse,
                phrase_word_counts: verse.phrase_word_counts.clone(),
                annotations: verse.annotations.clone(),
                ftv_word_count: verse.ftv_word_count,
                headings: heading_renders,
                clubs: clubs.clone(),
            },
        );

        verse_atoms_by_id.insert(
            verse_id,
            VerseAtoms {
                verse_id,
                phrase_count,
                headings,
                clubs,
                ftv_word_count: verse.ftv_word_count,
                phrase_zero_word_count,
            },
        );
    }

    // Seed `TestState::new_unseen` for every TestKey reachable from any card.
    let mut tests: HashMap<TestKey, TestState> = HashMap::new();
    let mut seen: HashSet<TestKey> = HashSet::new();
    for card in &cards {
        let atoms = match verse_atoms_by_id.get(&card.verse_id) {
            Some(a) => a,
            None => continue,
        };
        for tk in card.tests(atoms) {
            if seen.insert(tk) {
                tests.insert(tk, TestState::new_unseen(now_secs));
            }
        }
    }

    BuildResult {
        verse_index,
        cards,
        tests,
        verse_atoms_data: verse_atoms_by_id,
        verse_render_data: verse_render_by_id,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::element::ElementId;
    use crate::test_kind::TestKind;

    fn material_one_verse_simple() -> MaterialData {
        serde_json::from_str(
            r#"{
                "year": 3,
                "books": ["John"],
                "chapters": [{"book": "John", "number": 3, "start_verse": 16, "end_verse": 16}],
                "verses": [
                    {
                        "book": "John", "chapter": 3, "verse": 16,
                        "phraseWordCounts": [2, 2, 2, 3],
                        "annotations": [],
                        "ftvWordCount": null,
                        "clubs": []
                    }
                ],
                "headings": []
            }"#,
        )
        .unwrap()
    }

    fn material_one_verse_with_heading_and_club() -> MaterialData {
        serde_json::from_str(
            r#"{
                "year": 3,
                "books": ["John"],
                "chapters": [{"book": "John", "number": 3, "start_verse": 16, "end_verse": 16}],
                "verses": [
                    {
                        "book": "John", "chapter": 3, "verse": 16,
                        "phraseWordCounts": [2, 2, 2, 3],
                        "annotations": [],
                        "ftvWordCount": 2,
                        "clubs": [150]
                    }
                ],
                "headings": [{
                    "book": "John",
                    "startChapter": 3, "startVerse": 16,
                    "endChapter": 3, "endVerse": 17
                }]
            }"#,
        )
        .unwrap()
    }

    #[test]
    fn build_result_default() {
        let r = BuildResult::default();
        assert!(r.cards.is_empty());
        assert!(r.tests.is_empty());
    }

    #[test]
    fn builder_one_verse_populates_elements() {
        let m = material_one_verse_simple();
        let r = build(&m, 0);
        assert_eq!(r.verse_index.phrases_of(0).len(), 4);
        let bindings = r.verse_index.bindings_of(0);
        assert!(
            bindings
                .iter()
                .any(|e| matches!(e, ElementId::VerseRefPosition { .. }))
        );
        assert!(
            bindings
                .iter()
                .any(|e| matches!(e, ElementId::VerseChapterBinding { .. }))
        );
        assert!(
            bindings
                .iter()
                .any(|e| matches!(e, ElementId::VerseBookBinding { .. }))
        );
    }

    #[test]
    fn builder_emits_atomic_cards() {
        let m = material_one_verse_with_heading_and_club();
        let r = build(&m, 0);

        let phrase_fill = r
            .cards
            .iter()
            .filter(|c| matches!(c.kind, CardKind::PhraseFill { .. }))
            .count();
        assert_eq!(phrase_fill, 4);

        assert!(
            r.cards
                .iter()
                .any(|c| matches!(c.kind, CardKind::VerseAtVerseRef))
        );
        assert!(
            r.cards
                .iter()
                .any(|c| matches!(c.kind, CardKind::VerseInChapter))
        );
        assert!(
            r.cards
                .iter()
                .any(|c| matches!(c.kind, CardKind::VerseInBook))
        );
        assert!(
            r.cards
                .iter()
                .any(|c| matches!(c.kind, CardKind::VerseInHeading { .. }))
        );
        assert!(
            r.cards
                .iter()
                .any(|c| matches!(c.kind, CardKind::VerseInClub { .. }))
        );
        // One VerseInClub card per verse, carrying the most-specific tier.
        // The Club-150-implies-Club-300 subset rule is intentionally not
        // expanded — the broader membership is trivially known.
        let club_cards: Vec<&Card> = r
            .cards
            .iter()
            .filter(|c| matches!(c.kind, CardKind::VerseInClub { .. }))
            .collect();
        assert_eq!(club_cards.len(), 1);
        assert!(matches!(
            club_cards[0].kind,
            CardKind::VerseInClub {
                tier: ClubTier::Club150
            }
        ));
    }

    #[test]
    fn builder_emits_composite_cards() {
        let m = material_one_verse_with_heading_and_club();
        let r = build(&m, 0);
        assert!(
            r.cards
                .iter()
                .any(|c| matches!(c.kind, CardKind::Recitation))
        );
        assert!(r.cards.iter().any(|c| matches!(c.kind, CardKind::Citation)));
        // FTV "For God" is a strict prefix of phrase zero "For God" (equal),
        // so both Ftv variants are emitted.
        let ftv_cards = r
            .cards
            .iter()
            .filter(|c| matches!(c.kind, CardKind::Ftv { .. }))
            .count();
        assert_eq!(ftv_cards, 2);
    }

    #[test]
    fn builder_skips_ftv_when_word_count_absent() {
        // ftvWordCount = null → no FTV cards. derive_structure emits null
        // when the prefix invariant is violated upstream, so the builder
        // can trust the structural data without re-checking strings.
        let json = r#"{
            "year": 3,
            "books": ["John"],
            "chapters": [{"book": "John", "number": 3, "start_verse": 16, "end_verse": 16}],
            "verses": [{
                "book": "John", "chapter": 3, "verse": 16,
                "phraseWordCounts": [2, 2],
                "annotations": [],
                "ftvWordCount": null,
                "clubs": []
            }],
            "headings": []
        }"#;
        let m: MaterialData = serde_json::from_str(json).unwrap();
        let r = build(&m, 0);
        let ftv_cards = r
            .cards
            .iter()
            .filter(|c| matches!(c.kind, CardKind::Ftv { .. }))
            .count();
        assert_eq!(ftv_cards, 0);
    }

    #[test]
    fn builder_skips_ftv_when_too_long() {
        // ftvWordCount 6 exceeds FTV_MAX_WORDS=5. The builder enforces
        // the length cap even when the structural data says the prefix
        // invariant holds.
        let json = r#"{
            "year": 3,
            "books": ["John"],
            "chapters": [{"book": "John", "number": 3, "start_verse": 16, "end_verse": 16}],
            "verses": [{
                "book": "John", "chapter": 3, "verse": 16,
                "phraseWordCounts": [6, 1],
                "annotations": [],
                "ftvWordCount": 6,
                "clubs": []
            }],
            "headings": []
        }"#;
        let m: MaterialData = serde_json::from_str(json).unwrap();
        let r = build(&m, 0);
        let ftv_cards = r
            .cards
            .iter()
            .filter(|c| matches!(c.kind, CardKind::Ftv { .. }))
            .count();
        assert_eq!(ftv_cards, 0);
    }

    #[test]
    fn builder_seeds_test_states() {
        let m = material_one_verse_with_heading_and_club();
        let now = 86400 * 365;
        let r = build(&m, now);
        // every test referenced by some card should have a seeded TestState.
        for card in &r.cards {
            let phrases = r.verse_index.phrases_of(card.verse_id);
            let phrase_count = phrases.len() as u16;
            let bindings = r.verse_index.bindings_of(card.verse_id);
            let headings: Vec<u16> = bindings
                .iter()
                .filter_map(|e| match e {
                    ElementId::VerseHeadingBinding { heading_idx, .. } => Some(*heading_idx),
                    _ => None,
                })
                .collect();
            let clubs: Vec<ClubTier> = bindings
                .iter()
                .filter_map(|e| match e {
                    ElementId::VerseClubBinding { tier, .. } => Some(*tier),
                    _ => None,
                })
                .collect();
            let atoms = VerseAtoms {
                verse_id: card.verse_id,
                phrase_count,
                headings,
                clubs,
                ftv_word_count: None,
                phrase_zero_word_count: 0,
            };
            for tk in card.tests(&atoms) {
                assert!(
                    r.tests.contains_key(&tk),
                    "missing seeded TestState for {tk:?}"
                );
            }
        }
        // Every seeded state has the expected `last_seen` from `now_secs`.
        for state in r.tests.values() {
            assert!(state.last_seen_secs <= now);
        }
    }

    #[test]
    fn builder_assigns_sequential_verse_ids() {
        let json = r#"{
            "year": 3,
            "books": ["John"],
            "chapters": [
                {"book": "John", "number": 3, "start_verse": 1, "end_verse": 2}
            ],
            "verses": [
                {"book": "John", "chapter": 3, "verse": 1, "phraseWordCounts": [1], "annotations": [], "clubs": []},
                {"book": "John", "chapter": 3, "verse": 2, "phraseWordCounts": [1], "annotations": [], "clubs": []}
            ],
            "headings": []
        }"#;
        let m: MaterialData = serde_json::from_str(json).unwrap();
        let r = build(&m, 0);
        let ids: HashSet<u32> = r.cards.iter().map(|c| c.verse_id).collect();
        assert!(ids.contains(&0));
        assert!(ids.contains(&1));
        assert!(!ids.contains(&2));
    }

    #[test]
    fn builder_skips_text_empty_verses() {
        let json = r#"{
            "year": 3,
            "books": ["John"],
            "chapters": [{"book": "John", "number": 3, "start_verse": 1, "end_verse": 2}],
            "verses": [
                {"book": "John", "chapter": 3, "verse": 1, "phraseWordCounts": [], "annotations": [], "clubs": []},
                {"book": "John", "chapter": 3, "verse": 2, "phraseWordCounts": [1], "annotations": [], "clubs": []}
            ],
            "headings": []
        }"#;
        let m: MaterialData = serde_json::from_str(json).unwrap();
        let r = build(&m, 0);
        // Only the second verse counts. It gets verse_id 0 (skipping the empty).
        assert!(r.cards.iter().all(|c| c.verse_id == 0));
        assert_eq!(r.verse_render_data.get(&0).map(|v| v.verse), Some(2),);
    }

    #[test]
    fn builder_default_config_matches_legacy_build() {
        // build_with_config(default) and the legacy build() must be
        // identical card sets — the wrapper is the only difference.
        let m = material_one_verse_with_heading_and_club();
        let a = build(&m, 0);
        let b = build_with_config(&m, &MaterialConfig::default(), 0);
        assert_eq!(a.cards.len(), b.cards.len());
        assert_eq!(a.tests.len(), b.tests.len());
    }

    #[test]
    fn builder_headings_off_emits_no_heading_cards() {
        let m = material_one_verse_with_heading_and_club();
        let config = MaterialConfig {
            headings: false,
            ftv: true,
            citation: true,
        };
        let r = build_with_config(&m, &config, 0);
        assert!(
            !r.cards
                .iter()
                .any(|c| matches!(c.kind, CardKind::VerseInHeading { .. }))
        );
    }

    #[test]
    fn builder_ftv_off_emits_no_ftv_cards() {
        let m = material_one_verse_with_heading_and_club();
        let config = MaterialConfig {
            headings: true,
            ftv: false,
            citation: true,
        };
        let r = build_with_config(&m, &config, 0);
        assert!(
            !r.cards
                .iter()
                .any(|c| matches!(c.kind, CardKind::Ftv { .. }))
        );
    }

    #[test]
    fn builder_citation_off_emits_no_citation_cards() {
        let m = material_one_verse_with_heading_and_club();
        let config = MaterialConfig {
            headings: true,
            ftv: true,
            citation: false,
        };
        let r = build_with_config(&m, &config, 0);
        assert!(!r.cards.iter().any(|c| matches!(c.kind, CardKind::Citation)));
    }

    #[test]
    fn builder_always_on_cards_present_with_everything_off() {
        // Even with every toggle off, the core mechanic cards still emit:
        // PhraseFill, VerseAtVerseRef, VerseInChapter, VerseInBook,
        // VerseInClub, Recitation. (VerseInClub is filtered downstream by
        // per-club status, not at build time.)
        let m = material_one_verse_with_heading_and_club();
        let config = MaterialConfig {
            headings: false,
            ftv: false,
            citation: false,
        };
        let r = build_with_config(&m, &config, 0);
        assert!(
            r.cards
                .iter()
                .any(|c| matches!(c.kind, CardKind::PhraseFill { .. }))
        );
        assert!(
            r.cards
                .iter()
                .any(|c| matches!(c.kind, CardKind::VerseAtVerseRef))
        );
        assert!(
            r.cards
                .iter()
                .any(|c| matches!(c.kind, CardKind::VerseInChapter))
        );
        assert!(
            r.cards
                .iter()
                .any(|c| matches!(c.kind, CardKind::VerseInBook))
        );
        assert!(
            r.cards
                .iter()
                .any(|c| matches!(c.kind, CardKind::VerseInClub { .. }))
        );
        assert!(
            r.cards
                .iter()
                .any(|c| matches!(c.kind, CardKind::Recitation))
        );
    }

    #[test]
    fn builder_test_kinds_cover_expected_set() {
        let m = material_one_verse_with_heading_and_club();
        let r = build(&m, 0);
        let kinds: HashSet<TestKind> = r.tests.keys().map(|k| k.kind).collect();
        assert!(kinds.contains(&TestKind::PhraseFromContext));
        assert!(kinds.contains(&TestKind::VerseRefPosition));
        assert!(kinds.contains(&TestKind::VerseChapter));
        assert!(kinds.contains(&TestKind::VerseBook));
        assert!(kinds.contains(&TestKind::VerseHeading));
        assert!(kinds.contains(&TestKind::VerseClub));
    }
}
