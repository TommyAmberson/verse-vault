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
    /// The `MaterialConfig` the cards were built under. Retained on the
    /// `ReviewEngine` so the scheduler queue helpers can consult
    /// per-tier `new_scope` / `review_scope` at request time without
    /// requiring callers to thread it through every call.
    pub material_config: MaterialConfig,
}

/// Parse a raw tier list (as written in `VerseData.clubs`) into the
/// concrete `ClubTier` carried by VerseInClub / VerseClubBinding. The
/// quizzer's tier-subset rule (a Club-150 verse is implicitly also in
/// Club 300) is *not* expanded here: each verse is associated with one
/// most-specific tier, since the broader membership is trivially known
/// and the user shouldn't be asked the same "what club?" twice per verse.
///
/// Verses with no club tag are `Full`-tier — the catch-all for content
/// that's only quizzed at the full-curriculum level.
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
    if tiers.is_empty() {
        tiers.push(ClubTier::Full);
    }
    tiers
}

/// Allocate pseudo verse_ids and emit `ChapterClubList` cards. Pseudo
/// ids start one past the largest real verse_id so existing real-verse
/// `TestState`s keyed by `ElementId` are unaffected. The pseudo's
/// `VerseAtoms` carries the chapter's members so `Card::tests` can
/// expand without consulting the engine.
fn emit_chapter_club_list_cards(
    cards: &mut Vec<Card>,
    next_card_id: &mut u32,
    verse_atoms_by_id: &mut HashMap<u32, VerseAtoms>,
    verse_render_by_id: &mut HashMap<u32, VerseRender>,
    config: &MaterialConfig,
) {
    // Group included real verses by (book, chapter), tracking each
    // verse's most-specific tier so we can compute "tier T or below"
    // chapter membership.
    let mut by_chapter: HashMap<(String, u16), Vec<(u32, ClubTier)>> = HashMap::new();
    for (vid, atoms) in verse_atoms_by_id.iter() {
        let render = match verse_render_by_id.get(vid) {
            Some(r) => r,
            None => continue,
        };
        let tier = match atoms.clubs.first() {
            Some(t) => *t,
            None => continue,
        };
        by_chapter
            .entry((render.book.clone(), render.chapter))
            .or_default()
            .push((*vid, tier));
    }

    let mut next_pseudo_verse_id: u32 =
        verse_atoms_by_id.keys().copied().max().map_or(0, |m| m + 1);

    let mut chapter_keys: Vec<(String, u16)> = by_chapter.keys().cloned().collect();
    chapter_keys.sort();

    for chapter_key in &chapter_keys {
        let chapter_verses = &by_chapter[chapter_key];
        // Only Club150 + Club300 emit chapter-list cards; Full never does.
        for &card_tier in &[ClubTier::Club150, ClubTier::Club300] {
            if !config.chapter_list_scope.includes(card_tier) {
                continue;
            }
            // EXACT-tier membership: a Club300 chapter card lists only
            // 300-tagged verses, never 150-tagged ones. Grading the card
            // lifts the per-member VerseClubBinding for the card's tier
            // — including 150-tagged verses would reinforce their 150
            // memory, which the user explicitly doesn't want.
            let mut members: Vec<(u32, ClubTier)> = chapter_verses
                .iter()
                .filter(|(_, vt)| *vt == card_tier)
                .copied()
                .collect();
            members.sort_by_key(|(v, _)| *v);
            if members.is_empty() {
                continue;
            }

            let pseudo_id = next_pseudo_verse_id;
            next_pseudo_verse_id += 1;

            // Resolve each member's verse_id to a human verse number so
            // the client can render the back-of-card list without
            // exposing internal ids. `members` is already sorted by
            // verse_id (above) and verse numbers within a chapter
            // increase monotonically with verse_id, so the mapped
            // vec stays in ascending verse-number order.
            let member_numbers: Vec<u16> = members
                .iter()
                .filter_map(|(vid, _)| verse_render_by_id.get(vid).map(|r| r.verse))
                .collect();

            verse_atoms_by_id.insert(
                pseudo_id,
                VerseAtoms {
                    verse_id: pseudo_id,
                    phrase_count: 0,
                    phrase_ranges: Vec::new(),
                    headings: Vec::new(),
                    clubs: vec![card_tier],
                    ftv_word_count: None,
                    phrase_zero_word_count: 0,
                    chapter_members: members,
                    heading_members: Vec::new(),
                },
            );
            verse_render_by_id.insert(
                pseudo_id,
                VerseRender {
                    book: chapter_key.0.clone(),
                    chapter: chapter_key.1,
                    verse: 0, // sentinel: chapter-scoped, no specific verse
                    phrase_word_counts: Vec::new(),
                    annotations: Vec::new(),
                    ftv_word_count: None,
                    headings: Vec::new(),
                    clubs: vec![card_tier],
                    chapter_members: member_numbers,
                },
            );
            cards.push(Card {
                id: CardId(*next_card_id),
                kind: CardKind::ChapterClubList { tier: card_tier },
                verse_id: pseudo_id,
                state: CardState::New,
            });
            *next_card_id += 1;
        }
    }
}

/// Allocate pseudo verse_ids and emit one `HeadingPassage` card per
/// heading whose range covers at least one included real verse. The
/// pseudo's `VerseAtoms.heading_members` carries the member verse_ids
/// in ascending order so `Card::tests` can grade each member's
/// `VerseHeadingBinding`. Same pseudo-id contract as
/// `emit_chapter_club_list_cards`: ids start one past the current
/// max so real-verse TestStates aren't disturbed.
fn emit_heading_passage_cards(
    cards: &mut Vec<Card>,
    next_card_id: &mut u32,
    verse_atoms_by_id: &mut HashMap<u32, VerseAtoms>,
    verse_render_by_id: &mut HashMap<u32, VerseRender>,
    headings_data: &[HeadingData],
) {
    let mut next_pseudo_verse_id: u32 =
        verse_atoms_by_id.keys().copied().max().map_or(0, |m| m + 1);

    for (h_idx, heading) in headings_data.iter().enumerate() {
        let heading_idx = h_idx as u16;
        let mut members: Vec<u32> = verse_render_by_id
            .iter()
            .filter_map(|(vid, render)| {
                if render.book != heading.book {
                    return None;
                }
                // Sentinel verse=0 marks a pseudo verse (heading-passage
                // pseudos added by prior iterations of this loop, or
                // chapter-list pseudos if call order ever changes). They
                // aren't real verses; skip.
                if render.verse == 0 {
                    return None;
                }
                let in_range = if heading.start_chapter == heading.end_chapter {
                    render.chapter == heading.start_chapter
                        && render.verse >= heading.start_verse
                        && render.verse <= heading.end_verse
                } else if render.chapter == heading.start_chapter {
                    render.verse >= heading.start_verse
                } else if render.chapter == heading.end_chapter {
                    render.verse <= heading.end_verse
                } else {
                    render.chapter > heading.start_chapter && render.chapter < heading.end_chapter
                };
                in_range.then_some(*vid)
            })
            .collect();
        members.sort();
        if members.is_empty() {
            continue;
        }

        let pseudo_id = next_pseudo_verse_id;
        next_pseudo_verse_id += 1;

        verse_atoms_by_id.insert(
            pseudo_id,
            VerseAtoms {
                verse_id: pseudo_id,
                phrase_count: 0,
                phrase_ranges: Vec::new(),
                headings: vec![heading_idx],
                clubs: Vec::new(),
                ftv_word_count: None,
                phrase_zero_word_count: 0,
                chapter_members: Vec::new(),
                heading_members: members,
            },
        );
        verse_render_by_id.insert(
            pseudo_id,
            VerseRender {
                book: heading.book.clone(),
                chapter: heading.start_chapter,
                verse: 0, // sentinel: heading-scoped, no specific verse
                phrase_word_counts: Vec::new(),
                annotations: Vec::new(),
                ftv_word_count: None,
                headings: vec![HeadingRender {
                    heading_idx,
                    start_chapter: heading.start_chapter,
                    start_verse: heading.start_verse,
                    end_chapter: heading.end_chapter,
                    end_verse: heading.end_verse,
                }],
                clubs: Vec::new(),
                chapter_members: Vec::new(),
            },
        );
        cards.push(Card {
            id: CardId(*next_card_id),
            kind: CardKind::HeadingPassage { heading_idx },
            verse_id: pseudo_id,
            state: CardState::New,
        });
        *next_card_id += 1;
    }
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

/// Build cards and seeded test states from material data with the
/// "everything-on" config — every club enabled for both memorize and
/// review at 0.9 retention. Convenience wrapper around
/// [`build_with_config`] for callers (sim, tests, the WASM smoke harness)
/// that want a fully-open engine without specifying per-club shape.
///
/// Note: `MaterialConfig::default()` is the *new-user* default
/// (Club 150 only, retention 0.8). This wrapper specifically opens
/// every tier so test fixtures using `clubs: []` (which `parse_tiers`
/// resolves to `Full`) aren't silently paused.
pub fn build(data: &MaterialData, now_secs: i64) -> BuildResult {
    build_with_config(data, &MaterialConfig::all_clubs_enabled(0.9), now_secs)
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

        // Paused verses are skipped entirely; their test_states stay
        // in the DB and reconnect when the tier becomes Active or
        // Maintenance again.
        if config.verse_is_paused(&clubs) {
            continue;
        }

        verse_index.add_verse(
            verse_id,
            VerseElements {
                phrase_ranges: VerseAtoms::ranges_from_word_counts(&verse.phrase_word_counts),
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
        if config.heading_card {
            for &h_idx in &headings {
                push_card(
                    CardKind::VerseInHeading { heading_idx: h_idx },
                    &mut cards,
                    &mut next_card_id,
                );
            }
        }
        for &tier in &clubs {
            if config.club_card_scope.includes(tier) {
                push_card(
                    CardKind::VerseInClub { tier },
                    &mut cards,
                    &mut next_card_id,
                );
            }
        }

        push_card(CardKind::Recitation, &mut cards, &mut next_card_id);
        push_card(CardKind::Citation, &mut cards, &mut next_card_id);

        // Composite: Ftv. Eligibility: verse has phrases, the FTV
        // prompt is at least one word long, short enough overall, and
        // doesn't exceed phrase 0 length. `derive_structure` verified
        // the prefix invariant when emitting `ftv_word_count`, so we
        // trust it here. The single FTV card always tests the citation
        // triple on reveal — the no-citation variant was dropped
        // because Recitation already covers the recall-without-ref
        // case from the verse-text side.
        //
        // The two None-equivalent inputs:
        //   - `verse.ftv_word_count == None` (the JSON had `null` or
        //     omitted the key). The schema's "no Ftv card emitted"
        //     sentinel, covering both "pending audit" (init_deck /
        //     expand_deck just seeded the row; find_ftvs +
        //     apply_audit haven't run yet) and "ambiguous"
        //     (find_ftvs ran and found no unique opening prefix —
        //     apply_audit deliberately leaves the row at `null`,
        //     tools/apply_audit.py:154-156). The two states are
        //     indistinguishable at rest in the JSON; both correctly
        //     resolve to "no Ftv card" here.
        //   - `ftv_words == 0`. Should be impossible given the
        //     sentinel rule, but some shipped decks carry an explicit
        //     `"ftvWordCount": 0` (data/1-gepc.json's Ephesians 1:2 /
        //     Philippians 1:2 are the known offenders). Without the
        //     `> 0` floor, the builder emits a zero-word FTV card
        //     that schedules a prompt with no visible cue — same end
        //     state as `null` semantically, but the scheduler treats
        //     it as a real card. Reject. (The tools-side companion
        //     fix on this PR stops new `0` rows from being seeded;
        //     the existing offenders still need a data fix.)
        if config.ftv
            && let Some(ftv_words) = verse.ftv_word_count
            && ftv_words > 0
            && phrase_count > 0
            && (ftv_words as usize) <= FTV_MAX_WORDS
            && ftv_words <= phrase_zero_word_count
        {
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
                chapter_members: Vec::new(),
            },
        );

        verse_atoms_by_id.insert(
            verse_id,
            VerseAtoms {
                verse_id,
                phrase_count,
                phrase_ranges: VerseAtoms::ranges_from_word_counts(&verse.phrase_word_counts),
                headings,
                clubs,
                ftv_word_count: verse.ftv_word_count,
                phrase_zero_word_count,
                chapter_members: Vec::new(),
                heading_members: Vec::new(),
            },
        );
    }

    if config.heading_passage_card {
        emit_heading_passage_cards(
            &mut cards,
            &mut next_card_id,
            &mut verse_atoms_by_id,
            &mut verse_render_by_id,
            &data.headings,
        );
    }

    emit_chapter_club_list_cards(
        &mut cards,
        &mut next_card_id,
        &mut verse_atoms_by_id,
        &mut verse_render_by_id,
        config,
    );

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
        material_config: *config,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::element::ElementId;
    use crate::material_config::ChapterListScope;
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
        // club_card_scope defaults to Off, so VerseInClub cards need an
        // explicit opt-in for this test to exercise their emission.
        // heading_card likewise defaults off; flip it on so the
        // VerseInHeading assertion below exercises a real emission.
        let cfg = MaterialConfig {
            club_card_scope: crate::material_config::TierScope::All,
            heading_card: true,
            ..MaterialConfig::default()
        };
        let r = build_with_config(&m, &cfg, 0);

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
        // so one Ftv card emits — always with citation on the answer side.
        let ftv_cards: Vec<&Card> = r
            .cards
            .iter()
            .filter(|c| matches!(c.kind, CardKind::Ftv { .. }))
            .collect();
        assert_eq!(ftv_cards.len(), 1);
        assert!(matches!(
            ftv_cards[0].kind,
            CardKind::Ftv {
                with_citation: true
            }
        ));
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
            let atoms = r
                .verse_atoms_data
                .get(&card.verse_id)
                .expect("built verse_atoms_data should cover every card");
            for tk in card.tests(atoms) {
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
        // Real verses get ids 0 and 1. Chapter-list pseudo verse_ids are
        // allocated after real verses; we only care that 0 and 1 are
        // present here.
        let real_ids: HashSet<u32> = r
            .cards
            .iter()
            .filter(|c| !matches!(c.kind, CardKind::ChapterClubList { .. }))
            .map(|c| c.verse_id)
            .collect();
        assert_eq!(real_ids, HashSet::from([0u32, 1]));
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
        // Only the second verse counts. It gets verse_id 0 (skipping the
        // empty). Pseudo ids belong to the chapter-list cards and have
        // their own anchors.
        for c in &r.cards {
            if matches!(c.kind, CardKind::ChapterClubList { .. }) {
                continue;
            }
            assert_eq!(c.verse_id, 0);
        }
        assert_eq!(r.verse_render_data.get(&0).map(|v| v.verse), Some(2));
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
    fn builder_heading_card_off_emits_no_verse_in_heading_cards() {
        // Default already has heading_card=false, so this verifies the
        // default explicitly. The HeadingPassage card is the primary
        // heading-binding test; VerseInHeading is opt-in.
        let m = material_one_verse_with_heading_and_club();
        let r = build_with_config(&m, &MaterialConfig::default(), 0);
        assert!(
            !r.cards
                .iter()
                .any(|c| matches!(c.kind, CardKind::VerseInHeading { .. }))
        );
    }

    #[test]
    fn builder_emits_one_heading_passage_card_per_heading() {
        // Heading covers John 3:16–17. Both verses are included, so the
        // pseudo HeadingPassage card lists both as members. Default
        // config has heading_passage_card=true so this exercises the
        // out-of-the-box path.
        let json = r#"{
            "year": 4,
            "books": ["John"],
            "chapters": [{"book": "John", "number": 3, "start_verse": 16, "end_verse": 17}],
            "verses": [
                {"book": "John", "chapter": 3, "verse": 16, "phraseWordCounts": [2, 2], "annotations": [], "clubs": []},
                {"book": "John", "chapter": 3, "verse": 17, "phraseWordCounts": [2, 2], "annotations": [], "clubs": []}
            ],
            "headings": [{
                "book": "John",
                "startChapter": 3, "startVerse": 16,
                "endChapter": 3, "endVerse": 17
            }]
        }"#;
        let m: MaterialData = serde_json::from_str(json).unwrap();
        let r = build(&m, 0);

        let passage_cards: Vec<&Card> = r
            .cards
            .iter()
            .filter(|c| matches!(c.kind, CardKind::HeadingPassage { .. }))
            .collect();
        assert_eq!(passage_cards.len(), 1);
        let atoms = r.verse_atoms_data.get(&passage_cards[0].verse_id).unwrap();
        assert_eq!(atoms.heading_members, vec![0, 1]);

        // Member tests are seeded — verifies the propagation surface for
        // grading the card.
        for tk in passage_cards[0].tests(atoms) {
            assert!(
                r.tests.contains_key(&tk),
                "missing seeded TestState for {tk:?}"
            );
        }
    }

    #[test]
    fn builder_heading_passage_off_emits_no_heading_passage_cards() {
        let m = material_one_verse_with_heading_and_club();
        let config = MaterialConfig {
            heading_passage_card: false,
            ..MaterialConfig::default()
        };
        let r = build_with_config(&m, &config, 0);
        assert!(
            !r.cards
                .iter()
                .any(|c| matches!(c.kind, CardKind::HeadingPassage { .. }))
        );
    }

    #[test]
    fn builder_heading_card_on_emits_verse_in_heading_cards() {
        let m = material_one_verse_with_heading_and_club();
        let config = MaterialConfig {
            heading_card: true,
            ..MaterialConfig::default()
        };
        let r = build_with_config(&m, &config, 0);
        assert!(
            r.cards
                .iter()
                .any(|c| matches!(c.kind, CardKind::VerseInHeading { .. }))
        );
    }

    #[test]
    fn builder_ftv_off_emits_no_ftv_cards() {
        let m = material_one_verse_with_heading_and_club();
        let config = MaterialConfig {
            ftv: false,
            ..MaterialConfig::default()
        };
        let r = build_with_config(&m, &config, 0);
        assert!(
            !r.cards
                .iter()
                .any(|c| matches!(c.kind, CardKind::Ftv { .. }))
        );
    }

    fn config_with_club_cards_off() -> MaterialConfig {
        MaterialConfig {
            club_card_scope: crate::material_config::TierScope::Off,
            ..MaterialConfig::default()
        }
    }

    fn config_with_paused(tier: ClubTier) -> MaterialConfig {
        // Carve a hole in both scopes so this single tier ends up paused
        // while the others stay Active. For Club300, pick scopes that
        // include Club150 only; for Club150, both scopes Off (everything
        // paused — fine for that test). Bumps both scopes in lockstep
        // since pause requires neither covering the tier.
        let scope = match tier {
            ClubTier::Club150 => crate::material_config::TierScope::Off,
            ClubTier::Club300 => crate::material_config::TierScope::Up150,
            ClubTier::Full => crate::material_config::TierScope::Up300,
        };
        MaterialConfig::from_scopes(scope, scope)
    }

    #[test]
    fn builder_club_cards_off_emits_no_verse_in_club_cards() {
        let m = material_one_verse_with_heading_and_club();
        let r = build_with_config(&m, &config_with_club_cards_off(), 0);
        assert!(
            !r.cards
                .iter()
                .any(|c| matches!(c.kind, CardKind::VerseInClub { .. }))
        );
    }

    #[test]
    fn builder_always_on_cards_present_with_everything_off() {
        // Even with every toggleable knob off, the core mechanic cards
        // still emit: PhraseFill, VerseAtVerseRef, VerseInChapter,
        // VerseInBook, Recitation, Citation.
        let m = material_one_verse_with_heading_and_club();
        let config = MaterialConfig {
            heading_passage_card: false,
            ftv: false,
            ..config_with_club_cards_off()
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
                .any(|c| matches!(c.kind, CardKind::Recitation))
        );
        assert!(r.cards.iter().any(|c| matches!(c.kind, CardKind::Citation)));
        // With club_cards=false the standalone VerseInClub card is gone.
        // VerseInClub is the only card kind that grades VerseClubBinding,
        // so the binding test disappears with it — by design.
        assert!(
            !r.cards
                .iter()
                .any(|c| matches!(c.kind, CardKind::VerseInClub { .. }))
        );
    }

    #[test]
    fn builder_paused_club_drops_the_verse_entirely() {
        // Verse is in Club 150; pausing Club 150 must drop *all* of its
        // cards, not just VerseInClub.
        let m = material_one_verse_with_heading_and_club();
        let r = build_with_config(&m, &config_with_paused(ClubTier::Club150), 0);
        assert!(r.cards.is_empty(), "paused-club verse should emit nothing");
    }

    #[test]
    fn builder_emits_chapter_club_list_cards_with_exact_tier_membership() {
        // Chapter with one Club150 verse and one Club300 verse.
        let json = r#"{
            "year": 3,
            "books": ["John"],
            "chapters": [{"book": "John", "number": 3, "start_verse": 1, "end_verse": 2}],
            "verses": [
                {"book": "John", "chapter": 3, "verse": 1, "phraseWordCounts": [1], "annotations": [], "clubs": [150]},
                {"book": "John", "chapter": 3, "verse": 2, "phraseWordCounts": [1], "annotations": [], "clubs": [300]}
            ],
            "headings": []
        }"#;
        let m: MaterialData = serde_json::from_str(json).unwrap();
        // chapter_list_scope defaults to Up150 (per ChapterListScope::default),
        // so the Club300 chapter card needs an explicit Up300 to surface.
        // Use the test-friendly all-clubs-enabled config so the Club300
        // verse isn't filtered out by the new "Club 150 only" default.
        let cfg = MaterialConfig {
            chapter_list_scope: ChapterListScope::Up300,
            ..MaterialConfig::all_clubs_enabled(0.9)
        };
        let r = build_with_config(&m, &cfg, 0);
        let chapter_cards: Vec<&Card> = r
            .cards
            .iter()
            .filter(|c| matches!(c.kind, CardKind::ChapterClubList { .. }))
            .collect();
        // One chapter, two emitting tiers (Club150 + Club300, not Full)
        // → two chapter cards.
        assert_eq!(chapter_cards.len(), 2);

        let pick = |tier: ClubTier| -> &Card {
            chapter_cards
                .iter()
                .find(|c| matches!(c.kind, CardKind::ChapterClubList { tier: t } if t == tier))
                .copied()
                .unwrap()
        };

        // Exact-tier membership: the Club300 card lists *only* the
        // 300-tagged verse, never the 150-tagged one. Grading it
        // therefore lifts the 300 binding alone.
        let atoms_of = |c: &Card| r.verse_atoms_data.get(&c.verse_id).unwrap();
        let m150 = &atoms_of(pick(ClubTier::Club150)).chapter_members;
        let m300 = &atoms_of(pick(ClubTier::Club300)).chapter_members;
        assert_eq!(m150.len(), 1);
        assert_eq!(m150[0].1, ClubTier::Club150);
        assert_eq!(m300.len(), 1);
        assert_eq!(m300[0].1, ClubTier::Club300);
    }

    #[test]
    fn builder_skips_chapter_card_for_full_tier() {
        // A chapter of Full-only verses gets no chapter-list card —
        // listing every verse in a chapter isn't a meaningful test.
        let json = r#"{
            "year": 3,
            "books": ["John"],
            "chapters": [{"book": "John", "number": 3, "start_verse": 1, "end_verse": 1}],
            "verses": [
                {"book": "John", "chapter": 3, "verse": 1, "phraseWordCounts": [1], "annotations": [], "clubs": []}
            ],
            "headings": []
        }"#;
        let m: MaterialData = serde_json::from_str(json).unwrap();
        let r = build(&m, 0);
        assert!(
            !r.cards
                .iter()
                .any(|c| matches!(c.kind, CardKind::ChapterClubList { .. }))
        );
    }

    #[test]
    fn builder_paused_other_club_leaves_verse_alone() {
        // Verse is in Club 150; pausing Club 300 must not affect it.
        let m = material_one_verse_with_heading_and_club();
        let r = build_with_config(&m, &config_with_paused(ClubTier::Club300), 0);
        assert!(
            !r.cards.is_empty(),
            "non-matching pause should preserve cards"
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
