use std::collections::HashMap;

use crate::card::{Card, CardState};
use crate::card_types::{AtomRole, CardScope, CardTypeDef, CardTypesConfig, parse_role};
use crate::content::MaterialData;
use crate::edge::{EdgeRole, EdgeState};
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
    pub chapter_ref: NodeId,
    pub book_ref: NodeId,
    pub verse_gist: NodeId,
    pub phrases: Vec<NodeId>,
    pub ftv: Option<NodeId>,
    pub heading: Option<NodeId>,
    pub next_heading: Option<NodeId>,
    pub prev_heading: Option<NodeId>,
    /// `ClubGist` of the most-specific tier this verse belongs to: Club150
    /// if tagged 150 (which by the subset rule also lives in 300), else
    /// Club300 if tagged 300, else None for full-material-only verses.
    /// Resolves the `club_gist` role on verse-scope cards.
    pub most_specific_club_gist: Option<NodeId>,
}

/// Per-(book, chapter, tier) context for chapter-club-scoped card types.
/// Produced for every (chapter, tier) pair that has at least one member.
#[derive(Debug, serde::Serialize, serde::Deserialize)]
pub struct ChapterClubAtoms {
    pub club_gist: NodeId,
    pub book_ref: NodeId,
    pub chapter_ref: NodeId,
    /// VerseRef atoms for members of this chapter in this tier,
    /// sorted by verse number.
    pub verse_refs: Vec<NodeId>,
}

/// Per-heading context for heading-scoped card types. Produced for every
/// heading that covers at least one verse with text.
#[derive(Debug, serde::Serialize, serde::Deserialize)]
pub struct HeadingAtoms {
    pub heading: NodeId,
    /// VerseRef atoms for every verse inside the heading's range,
    /// sorted by (chapter, verse).
    pub verse_refs: Vec<NodeId>,
}

/// Build result from content data.
#[derive(serde::Serialize, serde::Deserialize)]
pub struct BuildResult {
    pub graph: Graph,
    pub cards: Vec<Card>,
    pub verse_atoms: Vec<VerseAtoms>,
}

// Internal aggregation types used while the builder stitches the club
// hierarchy together. Pulled out to keep function signatures readable.
type VerseClubMemberMap = HashMap<(ClubTier, String, u16, u16), NodeId>;
type VerseMembersByChapter = HashMap<(ClubTier, String, u16), Vec<(u16, NodeId)>>;
type VerseMembersByHeading = HashMap<(ClubTier, NodeId), Vec<((u16, u16), NodeId)>>;

/// Tier-subset rule: in the Anki export a verse tagged "150" is
/// implicitly a member of both club 150 and club 300. Expand a raw
/// tier list (as written in `VerseData.clubs`) to the full set of
/// tiers that should materialise VerseClubMember atoms.
fn expand_tiers(raw: &[u16]) -> Vec<ClubTier> {
    let mut tiers: Vec<ClubTier> = Vec::new();
    let mut push = |t: ClubTier| {
        if !tiers.contains(&t) {
            tiers.push(t);
        }
    };
    for &n in raw {
        match n {
            150 => {
                push(ClubTier::Club150);
                push(ClubTier::Club300);
            }
            300 => push(ClubTier::Club300),
            _ => {}
        }
    }
    tiers
}

/// Build a graph and card catalog from content data and card type definitions.
/// `now_secs` is used to set initial edge last_review to `now - 365 days`.
pub fn build(data: &MaterialData, card_types: &CardTypesConfig, now_secs: i64) -> BuildResult {
    let mut graph = Graph::new();
    let state = initial_state(now_secs);

    // --- Book layer ---
    let mut book_gists: HashMap<String, NodeId> = HashMap::new();
    let mut book_refs: HashMap<String, NodeId> = HashMap::new();
    for book in &data.books {
        let bg = graph.add_node(NodeKind::BookGist { book: book.clone() });
        let br = graph.add_node(NodeKind::BookRef { book: book.clone() });
        graph.add_bi_edge_with_state(bg, br, state);
        book_gists.insert(book.clone(), bg);
        book_refs.insert(book.clone(), br);
    }
    // Book-consecutive chain follows `data.books` order.
    for i in 1..data.books.len() {
        if let (Some(&prev), Some(&curr)) = (
            book_gists.get(&data.books[i - 1]),
            book_gists.get(&data.books[i]),
        ) {
            graph.add_bi_edge_with_state(prev, curr, state);
        }
    }

    // --- Chapter layer ---
    let mut chapter_gists: HashMap<(String, u16), NodeId> = HashMap::new();
    let mut chapter_refs: HashMap<(String, u16), NodeId> = HashMap::new();
    let mut chapters_by_book: HashMap<String, Vec<(u16, NodeId)>> = HashMap::new();

    for ch in &data.chapters {
        let gist = graph.add_node(NodeKind::ChapterGist { chapter: ch.number });
        let cref = graph.add_node(NodeKind::ChapterRef { chapter: ch.number });
        graph.add_bi_edge_with_state(gist, cref, state);

        // chapter_gist → book_gist (uni)
        if let Some(&bg) = book_gists.get(&ch.book) {
            graph.add_edge_with_state(gist, bg, state);
        }
        // chapter_ref → book_ref (uni)
        if let Some(&br) = book_refs.get(&ch.book) {
            graph.add_edge_with_state(cref, br, state);
        }

        chapter_gists.insert((ch.book.clone(), ch.number), gist);
        chapter_refs.insert((ch.book.clone(), ch.number), cref);
        chapters_by_book
            .entry(ch.book.clone())
            .or_default()
            .push((ch.number, gist));
    }

    // Chapter-consecutive chain and book→first/last chapter endpoints
    for (book, chapters) in &mut chapters_by_book {
        chapters.sort_by_key(|(num, _)| *num);
        for i in 1..chapters.len() {
            graph.add_bi_edge_with_state(chapters[i - 1].1, chapters[i].1, state);
        }
        if let Some(&bg) = book_gists.get(book)
            && let (Some(first), Some(last)) = (chapters.first(), chapters.last())
        {
            graph.add_edge_with_role(bg, first.1, EdgeRole::FirstChild, state);
            graph.add_edge_with_role(bg, last.1, EdgeRole::LastChild, state);
        }
    }

    // --- Heading nodes + chain ---
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
    // Heading ↔ heading chain (bidirectional, within-book only)
    for i in 1..heading_nodes.len() {
        let (prev_id, prev_h) = &heading_nodes[i - 1];
        let (curr_id, curr_h) = &heading_nodes[i];
        if prev_h.book == curr_h.book {
            graph.add_bi_edge_with_state(*prev_id, *curr_id, state);
        }
    }
    // Build heading lookup: (book, chapter, verse) -> heading node
    let heading_lookup = build_heading_lookup(&heading_nodes);

    // --- Verse layer ---
    let mut verse_atoms_list: Vec<VerseAtoms> = Vec::new();
    // Parallel to verse_atoms_list: most-specific club tier per verse, or
    // None for full-material-only verses. Resolved to a ClubGist NodeId
    // after `build_club_hierarchy` returns the per-tier gist map.
    let mut verse_most_specific_tier: Vec<Option<ClubTier>> = Vec::new();
    let mut prev_verse_gist: Option<NodeId> = None;
    let mut prev_verse_book: Option<String> = None;

    // Track verses per chapter for endpoint wiring after all verses exist.
    let mut verses_by_chapter: HashMap<(String, u16), Vec<(u16, NodeId)>> = HashMap::new();

    // Track per-verse club membership for club-hierarchy wiring later.
    let mut verse_club_members: VerseClubMemberMap = HashMap::new();
    let mut verse_members_by_chapter_tier: VerseMembersByChapter = HashMap::new();
    let mut verse_members_by_heading_tier: VerseMembersByHeading = HashMap::new();

    // Track VerseRef NodeIds for chapter-club and heading listing cards.
    // Parallel to verse_members_by_chapter_tier but stores verse_ref (the
    // displayed atom) rather than the VerseClubMember (internal atom).
    type VerseRefsByChapterTier = HashMap<(ClubTier, String, u16), Vec<(u16, NodeId)>>;
    type VerseRefsByHeading = HashMap<NodeId, Vec<((u16, u16), NodeId)>>;
    let mut verse_refs_by_chapter_tier: VerseRefsByChapterTier = HashMap::new();
    // (heading_id) -> list of ((chapter, verse), verse_ref) for verses in
    // that heading's range (regardless of club membership).
    let mut verse_refs_by_heading: VerseRefsByHeading = HashMap::new();

    for verse_data in data.verses_with_text() {
        let ref_node = graph.add_node(NodeKind::VerseRef {
            chapter: verse_data.chapter,
            verse: verse_data.verse,
        });
        let verse_gist = graph.add_node(NodeKind::VerseGist {
            chapter: verse_data.chapter,
            verse: verse_data.verse,
        });

        // verse gist ↔ verse ref (bi)
        graph.add_bi_edge_with_state(verse_gist, ref_node, state);

        // verse gist → chapter gist (uni)
        if let Some(&ch_gist) = chapter_gists.get(&(verse_data.book.clone(), verse_data.chapter)) {
            graph.add_edge_with_state(verse_gist, ch_gist, state);
        }
        // verse ref → chapter ref (uni)
        if let Some(&ch_ref) = chapter_refs.get(&(verse_data.book.clone(), verse_data.chapter)) {
            graph.add_edge_with_state(ref_node, ch_ref, state);
        }

        // Phrase nodes
        let mut phrase_nodes = Vec::new();
        for (pos, phrase_text) in verse_data.phrases.iter().enumerate() {
            let pid = graph.add_node(NodeKind::Phrase {
                text: phrase_text.clone(),
                verse_id: verse_data.verse as u32,
                position: pos as u16,
            });
            graph.add_bi_edge_with_state(pid, verse_gist, state);
            phrase_nodes.push(pid);
        }
        // Phrase ↔ phrase chain (bi)
        for i in 1..phrase_nodes.len() {
            graph.add_bi_edge_with_state(phrase_nodes[i - 1], phrase_nodes[i], state);
        }

        // FTV node (optional, ≤ FTV_MAX_WORDS)
        let ftv_node = if !verse_data.ftv.is_empty()
            && verse_data.ftv.split_whitespace().count() <= FTV_MAX_WORDS
            && !phrase_nodes.is_empty()
        {
            let ftv = graph.add_node(NodeKind::Ftv {
                text: verse_data.ftv.clone(),
            });
            graph.add_edge_with_state(ftv, phrase_nodes[0], state);
            graph.add_edge_with_state(ftv, verse_gist, state);
            Some(ftv)
        } else {
            None
        };

        // Chapter-consecutive verse ↔ verse (bi)
        if let Some(prev_gist) = prev_verse_gist
            && prev_verse_book.as_deref() == Some(&verse_data.book)
        {
            graph.add_bi_edge_with_state(prev_gist, verse_gist, state);
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
            graph.add_edge_with_state(verse_gist, hid, state);
        }

        // Club membership (verse layer). Tier expansion materialises both
        // 150 and 300 for verses tagged "150" per the Anki export.
        for tier in expand_tiers(&verse_data.clubs) {
            let member = graph.add_node(NodeKind::VerseClubMember {
                tier,
                chapter: verse_data.chapter,
                verse: verse_data.verse,
            });
            graph.add_bi_edge_with_state(ref_node, member, state);
            verse_club_members.insert(
                (
                    tier,
                    verse_data.book.clone(),
                    verse_data.chapter,
                    verse_data.verse,
                ),
                member,
            );
            verse_members_by_chapter_tier
                .entry((tier, verse_data.book.clone(), verse_data.chapter))
                .or_default()
                .push((verse_data.verse, member));
            verse_refs_by_chapter_tier
                .entry((tier, verse_data.book.clone(), verse_data.chapter))
                .or_default()
                .push((verse_data.verse, ref_node));
            if let Some(hid) = heading_node {
                verse_members_by_heading_tier
                    .entry((tier, hid))
                    .or_default()
                    .push(((verse_data.chapter, verse_data.verse), member));
            }
        }

        // Heading-scope tracking: every verse with a heading contributes
        // its verse_ref to the heading's card scope (independent of club
        // membership).
        if let Some(hid) = heading_node {
            verse_refs_by_heading
                .entry(hid)
                .or_default()
                .push(((verse_data.chapter, verse_data.verse), ref_node));
        }

        // Heading context for card generation (lookup adjacent headings)
        let heading_idx =
            heading_node.and_then(|hid| heading_nodes.iter().position(|(id, _)| *id == hid));
        let next_heading = heading_idx.and_then(|i| heading_nodes.get(i + 1).map(|(id, _)| *id));
        let prev_heading = heading_idx.and_then(|i| {
            i.checked_sub(1)
                .and_then(|j| heading_nodes.get(j))
                .map(|(id, _)| *id)
        });

        verses_by_chapter
            .entry((verse_data.book.clone(), verse_data.chapter))
            .or_default()
            .push((verse_data.verse, verse_gist));

        let chapter_ref = chapter_refs
            .get(&(verse_data.book.clone(), verse_data.chapter))
            .copied()
            .expect("chapter_ref was inserted during chapter layer");
        let book_ref = *book_refs
            .get(&verse_data.book)
            .expect("book_ref was inserted during book layer");

        // Most-specific tier this verse belongs to (filled in below once
        // ClubGist NodeIds are known). 150 wins over 300 because 150 ⊂ 300.
        let most_specific_tier =
            expand_tiers(&verse_data.clubs)
                .into_iter()
                .min_by_key(|t| match t {
                    ClubTier::Club150 => 0,
                    ClubTier::Club300 => 1,
                });

        verse_atoms_list.push(VerseAtoms {
            ref_node,
            chapter_ref,
            book_ref,
            verse_gist,
            phrases: phrase_nodes,
            ftv: ftv_node,
            heading: heading_node,
            next_heading,
            prev_heading,
            // Filled in after build_club_hierarchy — store the tier in
            // a parallel vec so we don't carry it on the public struct.
            most_specific_club_gist: None,
        });
        verse_most_specific_tier.push(most_specific_tier);
    }

    // Chapter → first/last verse endpoints (needs full verse map)
    for ((book, chapter_num), mut verses) in verses_by_chapter {
        verses.sort_by_key(|(num, _)| *num);
        if let Some(&ch_gist) = chapter_gists.get(&(book.clone(), chapter_num))
            && let (Some(first), Some(last)) = (verses.first(), verses.last())
        {
            graph.add_edge_with_role(ch_gist, first.1, EdgeRole::FirstChild, state);
            graph.add_edge_with_role(ch_gist, last.1, EdgeRole::LastChild, state);
        }
    }

    // Heading → first/last verse endpoints (by range, sorted by chapter/verse)
    for (hid, hdata) in &heading_nodes {
        let mut verses_in_range: Vec<((u16, u16), NodeId)> = Vec::new();
        // Look at verses in the chapter range; filter by the heading's start/end
        for atoms in &verse_atoms_list {
            if let Some(NodeKind::VerseGist { chapter, verse }) =
                graph.node_kind(atoms.verse_gist).cloned()
            {
                let in_range = verse_in_heading(chapter, verse, hdata);
                if in_range {
                    verses_in_range.push(((chapter, verse), atoms.verse_gist));
                }
            }
        }
        verses_in_range.sort_by_key(|(k, _)| *k);
        if let (Some(first), Some(last)) = (verses_in_range.first(), verses_in_range.last()) {
            graph.add_edge_with_role(*hid, first.1, EdgeRole::FirstChild, state);
            graph.add_edge_with_role(*hid, last.1, EdgeRole::LastChild, state);
        }
    }

    // --- Club hierarchy ---
    let club_gists = build_club_hierarchy(
        &mut graph,
        state,
        &verse_club_members,
        &verse_members_by_chapter_tier,
        &verse_members_by_heading_tier,
        &chapter_refs,
        &heading_nodes,
    );

    // Resolve each verse's most-specific ClubGist NodeId now that the
    // gist map exists.
    for (atoms, tier) in verse_atoms_list
        .iter_mut()
        .zip(verse_most_specific_tier.iter())
    {
        atoms.most_specific_club_gist = tier.and_then(|t| club_gists.get(&t).copied());
    }

    // --- Chapter-club atom bundles ---
    let mut chapter_club_atoms_list: Vec<ChapterClubAtoms> = Vec::new();
    for ((tier, book, chapter), verse_refs) in &verse_refs_by_chapter_tier {
        let mut sorted = verse_refs.clone();
        sorted.sort_by_key(|(v, _)| *v);
        let (Some(&club_gist), Some(&book_ref), Some(&chapter_ref)) = (
            club_gists.get(tier),
            book_refs.get(book),
            chapter_refs.get(&(book.clone(), *chapter)),
        ) else {
            continue;
        };
        chapter_club_atoms_list.push(ChapterClubAtoms {
            club_gist,
            book_ref,
            chapter_ref,
            verse_refs: sorted.into_iter().map(|(_, vref)| vref).collect(),
        });
    }

    // --- Heading atom bundles ---
    let mut heading_atoms_list: Vec<HeadingAtoms> = Vec::new();
    for (hid, entries) in &verse_refs_by_heading {
        let mut sorted = entries.clone();
        sorted.sort_by_key(|(k, _)| *k);
        heading_atoms_list.push(HeadingAtoms {
            heading: *hid,
            verse_refs: sorted.into_iter().map(|(_, vref)| vref).collect(),
        });
    }

    // --- Cards ---
    let cards = generate_cards(
        card_types,
        &verse_atoms_list,
        &chapter_club_atoms_list,
        &heading_atoms_list,
    );

    BuildResult {
        graph,
        cards,
        verse_atoms: verse_atoms_list,
    }
}

fn verse_in_heading(chapter: u16, verse: u16, h: &crate::content::HeadingData) -> bool {
    if chapter < h.start_chapter || chapter > h.end_chapter {
        return false;
    }
    if chapter == h.start_chapter && verse < h.start_verse {
        return false;
    }
    if chapter == h.end_chapter && verse > h.end_verse {
        return false;
    }
    true
}

#[allow(clippy::too_many_arguments)]
fn build_club_hierarchy(
    graph: &mut Graph,
    state: EdgeState,
    verse_club_members: &VerseClubMemberMap,
    verse_members_by_chapter_tier: &VerseMembersByChapter,
    verse_members_by_heading_tier: &VerseMembersByHeading,
    chapter_refs: &HashMap<(String, u16), NodeId>,
    heading_nodes: &[(NodeId, &crate::content::HeadingData)],
) -> HashMap<ClubTier, NodeId> {
    // Set of tiers that actually appear in the material.
    let mut tiers: Vec<ClubTier> = Vec::new();
    for (tier, _, _, _) in verse_club_members.keys() {
        if !tiers.contains(tier) {
            tiers.push(*tier);
        }
    }
    tiers.sort_by_key(|t| match t {
        ClubTier::Club150 => 0,
        ClubTier::Club300 => 1,
    });

    // ClubGist per tier.
    let mut club_gists: HashMap<ClubTier, NodeId> = HashMap::new();
    for &tier in &tiers {
        let cg = graph.add_node(NodeKind::ClubGist { tier });
        club_gists.insert(tier, cg);
    }

    // Per-chapter club member atoms + per-heading club member atoms, plus
    // all downward/upward edges. Also collects sorted lists for later
    // per-tier endpoint wiring.
    let mut chapter_cm_by_tier: HashMap<ClubTier, Vec<(String, u16, NodeId)>> = HashMap::new();
    let mut heading_cm_by_tier: HashMap<ClubTier, Vec<(usize, NodeId)>> = HashMap::new();

    // Chapter club members
    for ((tier, book, chapter), members) in verse_members_by_chapter_tier {
        let cref = match chapter_refs.get(&(book.clone(), *chapter)) {
            Some(&r) => r,
            None => continue,
        };
        let ccm = graph.add_node(NodeKind::ChapterClubMember {
            tier: *tier,
            chapter: *chapter,
        });
        graph.add_bi_edge_with_state(cref, ccm, state);
        if let Some(&cg) = club_gists.get(tier) {
            graph.add_edge_with_state(ccm, cg, state);
        }

        let mut sorted = members.clone();
        sorted.sort_by_key(|(v, _)| *v);
        if let (Some(first), Some(last)) = (sorted.first(), sorted.last()) {
            graph.add_edge_with_role(ccm, first.1, EdgeRole::FirstChild, state);
            graph.add_edge_with_role(ccm, last.1, EdgeRole::LastChild, state);
        }
        // Upward verse_cm → chapter_cm
        for (_, vcm) in &sorted {
            graph.add_edge_with_state(*vcm, ccm, state);
        }

        chapter_cm_by_tier
            .entry(*tier)
            .or_default()
            .push((book.clone(), *chapter, ccm));
    }

    // Chapter club-member chain (bi, within tier, global chapter order
    // across books mirrors `data.books` order via chapter_refs insertion).
    for (tier, chapters) in chapter_cm_by_tier.iter_mut() {
        chapters.sort_by(|a, b| a.0.cmp(&b.0).then_with(|| a.1.cmp(&b.1)));
        for i in 1..chapters.len() {
            graph.add_bi_edge_with_state(chapters[i - 1].2, chapters[i].2, state);
        }
        // Club gist → first/last chapter_cm endpoints
        if let Some(&cg) = club_gists.get(tier)
            && let (Some(first), Some(last)) = (chapters.first(), chapters.last())
        {
            graph.add_edge_with_role(cg, first.2, EdgeRole::FirstChild, state);
            graph.add_edge_with_role(cg, last.2, EdgeRole::LastChild, state);
        }
    }

    // Heading club members
    let heading_index: HashMap<NodeId, usize> = heading_nodes
        .iter()
        .enumerate()
        .map(|(i, (id, _))| (*id, i))
        .collect();

    for ((tier, hid), members) in verse_members_by_heading_tier {
        let hdata = match heading_nodes.iter().find(|(id, _)| id == hid) {
            Some((_, h)) => *h,
            None => continue,
        };
        let hcm = graph.add_node(NodeKind::HeadingClubMember {
            tier: *tier,
            start_chapter: hdata.start_chapter,
            start_verse: hdata.start_verse,
        });
        graph.add_bi_edge_with_state(*hid, hcm, state);
        if let Some(&cg) = club_gists.get(tier) {
            graph.add_edge_with_state(hcm, cg, state);
        }

        let mut sorted = members.clone();
        sorted.sort_by_key(|(k, _)| *k);
        if let (Some(first), Some(last)) = (sorted.first(), sorted.last()) {
            graph.add_edge_with_role(hcm, first.1, EdgeRole::FirstChild, state);
            graph.add_edge_with_role(hcm, last.1, EdgeRole::LastChild, state);
        }
        // Upward verse_cm → heading_cm
        for (_, vcm) in &sorted {
            graph.add_edge_with_state(*vcm, hcm, state);
        }

        if let Some(&idx) = heading_index.get(hid) {
            heading_cm_by_tier
                .entry(*tier)
                .or_default()
                .push((idx, hcm));
        }
    }

    // Heading club-member chain (bi, within tier, sorted by heading_nodes order)
    for (tier, headings) in heading_cm_by_tier.iter_mut() {
        headings.sort_by_key(|(idx, _)| *idx);
        for i in 1..headings.len() {
            graph.add_bi_edge_with_state(headings[i - 1].1, headings[i].1, state);
        }
        if let Some(&cg) = club_gists.get(tier)
            && let (Some(first), Some(last)) = (headings.first(), headings.last())
        {
            graph.add_edge_with_role(cg, first.1, EdgeRole::FirstChild, state);
            graph.add_edge_with_role(cg, last.1, EdgeRole::LastChild, state);
        }
    }

    // --- Verse-member chain (bi, within tier) + ClubGist verse endpoints ---
    type VerseMembersByTier = HashMap<ClubTier, Vec<((String, u16, u16), NodeId)>>;
    let mut verse_members_by_tier: VerseMembersByTier = HashMap::new();
    for ((tier, book, chapter, verse), vcm) in verse_club_members {
        verse_members_by_tier
            .entry(*tier)
            .or_default()
            .push(((book.clone(), *chapter, *verse), *vcm));
    }
    for (tier, verses) in verse_members_by_tier.iter_mut() {
        verses.sort_by(|a, b| a.0.cmp(&b.0));
        for i in 1..verses.len() {
            graph.add_bi_edge_with_state(verses[i - 1].1, verses[i].1, state);
        }
        // verse_cm → club_gist
        if let Some(&cg) = club_gists.get(tier) {
            for (_, vcm) in verses.iter() {
                graph.add_edge_with_state(*vcm, cg, state);
            }
            if let (Some(first), Some(last)) = (verses.first(), verses.last()) {
                graph.add_edge_with_role(cg, first.1, EdgeRole::FirstChild, state);
                graph.add_edge_with_role(cg, last.1, EdgeRole::LastChild, state);
            }
        }
    }

    club_gists
}

fn build_heading_lookup(
    heading_nodes: &[(NodeId, &crate::content::HeadingData)],
) -> HashMap<(String, u16, u16), NodeId> {
    let mut lookup = HashMap::new();
    for (hid, h) in heading_nodes {
        if h.start_chapter == h.end_chapter {
            for v in h.start_verse..=h.end_verse {
                lookup.insert((h.book.clone(), h.start_chapter, v), *hid);
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
                    lookup.insert((h.book.clone(), ch, v), *hid);
                }
            }
        }
    }
    lookup
}

fn generate_cards(
    card_types: &CardTypesConfig,
    verse_atoms: &[VerseAtoms],
    chapter_club_atoms: &[ChapterClubAtoms],
    heading_atoms: &[HeadingAtoms],
) -> Vec<Card> {
    let mut cards = Vec::new();
    let mut next_id = 0u32;

    for card_type in &card_types.card_types {
        match card_type.scope {
            CardScope::Verse => {
                generate_verse_cards(card_type, verse_atoms, &mut cards, &mut next_id);
            }
            CardScope::ChapterClub => {
                generate_chapter_club_cards(
                    card_type,
                    chapter_club_atoms,
                    &mut cards,
                    &mut next_id,
                );
            }
            CardScope::Heading => {
                generate_heading_cards(card_type, heading_atoms, &mut cards, &mut next_id);
            }
        }
    }

    cards
}

fn generate_verse_cards(
    card_type: &CardTypeDef,
    verse_atoms: &[VerseAtoms],
    cards: &mut Vec<Card>,
    next_id: &mut u32,
) {
    for atoms in verse_atoms {
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
                for (idx, _) in atoms.phrases.iter().enumerate() {
                    if let Some(card) = resolve_card(card_type, atoms, Some(idx), next_id) {
                        cards.push(card);
                    }
                }
            }
        } else if let Some(card) = resolve_card(card_type, atoms, None, next_id) {
            cards.push(card);
        }
    }
}

fn generate_chapter_club_cards(
    card_type: &CardTypeDef,
    chapter_club_atoms: &[ChapterClubAtoms],
    cards: &mut Vec<Card>,
    next_id: &mut u32,
) {
    for atoms in chapter_club_atoms {
        if atoms.verse_refs.is_empty() {
            continue;
        }
        let shown = resolve_chapter_club_roles(&card_type.show, atoms);
        let hidden = resolve_chapter_club_roles(&card_type.hide, atoms);
        let (Some(shown), Some(hidden)) = (shown, hidden) else {
            continue;
        };
        if shown.is_empty() || hidden.is_empty() {
            continue;
        }
        let id = CardId(*next_id);
        *next_id += 1;
        cards.push(Card {
            id,
            shown,
            hidden,
            state: CardState::New,
        });
    }
}

fn generate_heading_cards(
    card_type: &CardTypeDef,
    heading_atoms: &[HeadingAtoms],
    cards: &mut Vec<Card>,
    next_id: &mut u32,
) {
    for atoms in heading_atoms {
        if atoms.verse_refs.is_empty() {
            continue;
        }
        let shown = resolve_heading_roles(&card_type.show, atoms);
        let hidden = resolve_heading_roles(&card_type.hide, atoms);
        let (Some(shown), Some(hidden)) = (shown, hidden) else {
            continue;
        };
        if shown.is_empty() || hidden.is_empty() {
            continue;
        }
        let id = CardId(*next_id);
        *next_id += 1;
        cards.push(Card {
            id,
            shown,
            hidden,
            state: CardState::New,
        });
    }
}

fn resolve_chapter_club_roles(roles: &[String], atoms: &ChapterClubAtoms) -> Option<Vec<NodeId>> {
    let mut nodes = Vec::new();
    for role_str in roles {
        match parse_role(role_str)? {
            AtomRole::ClubGist => nodes.push(atoms.club_gist),
            AtomRole::BookRef => nodes.push(atoms.book_ref),
            AtomRole::ChapterRef => nodes.push(atoms.chapter_ref),
            AtomRole::ChapterClubVerseRefs => nodes.extend_from_slice(&atoms.verse_refs),
            // Roles outside the chapter-club scope aren't resolvable here.
            _ => return None,
        }
    }
    Some(nodes)
}

fn resolve_heading_roles(roles: &[String], atoms: &HeadingAtoms) -> Option<Vec<NodeId>> {
    let mut nodes = Vec::new();
    for role_str in roles {
        match parse_role(role_str)? {
            AtomRole::Heading => nodes.push(atoms.heading),
            AtomRole::HeadingVerseRefs => nodes.extend_from_slice(&atoms.verse_refs),
            _ => return None,
        }
    }
    Some(nodes)
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
            // `ref` expands to the full book/chapter/verse triple so every
            // reference-bearing card carries the three atoms that grade
            // independently (see card-coupling design in docs/graph.md).
            AtomRole::Ref => {
                nodes.push(atoms.book_ref);
                nodes.push(atoms.chapter_ref);
                nodes.push(atoms.ref_node);
            }
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
                // These need chapter-level context, handled separately.
            }
            // Verse-scope resolution for roles that name a single parent
            // atom of the verse: book_ref, chapter_ref, and the
            // most-specific club_gist (if the verse is in any tier).
            AtomRole::BookRef => nodes.push(atoms.book_ref),
            AtomRole::ChapterRef => nodes.push(atoms.chapter_ref),
            AtomRole::ClubGist => {
                // Skip the card entirely for full-material-only verses.
                nodes.push(atoms.most_specific_club_gist?);
            }
            // Genuine cross-scope roles that don't map to a single verse-
            // scoped answer.
            AtomRole::ChapterClubVerseRefs | AtomRole::HeadingVerseRefs => {
                return None;
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
                    "clubs": [150]
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

        // The new topology adds book + chapter endpoints + club hierarchy,
        // so the graph is much denser than before.
        assert!(
            result.graph.node_count() > 20,
            "should have many nodes: {}",
            result.graph.node_count()
        );
        assert!(
            result.graph.edge_count() > 40,
            "should have many edges: {}",
            result.graph.edge_count()
        );
    }

    #[test]
    fn generates_cards_from_types() {
        let data = test_data();
        let card_types = test_card_types();
        let result = build(&data, &card_types, 0);
        assert!(result.cards.len() >= 10, "cards: {}", result.cards.len());

        // Full-recitation: shown = [book_ref, chapter_ref, verse_ref] (3)
        // and hidden = all phrases (2 in test data).
        let atoms0 = &result.verse_atoms[0];
        let full_recit = result.cards.iter().find(|c| {
            c.shown == vec![atoms0.book_ref, atoms0.chapter_ref, atoms0.ref_node]
                && c.hidden == atoms0.phrases
        });
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
    fn tier_subset_rule_expands_150_to_300() {
        let data = test_data();
        let card_types = test_card_types();
        let result = build(&data, &card_types, 0);
        // Verse 1 has clubs=[150] but should get BOTH Club150 and Club300 members.
        let club_members: Vec<_> = result
            .graph
            .node_ids()
            .filter_map(|id| match result.graph.node_kind(id) {
                Some(NodeKind::VerseClubMember {
                    tier,
                    chapter,
                    verse,
                }) => Some((*tier, *chapter, *verse)),
                _ => None,
            })
            .collect();
        let verse1_150 = club_members
            .iter()
            .any(|(t, c, v)| *t == ClubTier::Club150 && *c == 1 && *v == 1);
        let verse1_300 = club_members
            .iter()
            .any(|(t, c, v)| *t == ClubTier::Club300 && *c == 1 && *v == 1);
        let verse2_150 = club_members
            .iter()
            .any(|(t, c, v)| *t == ClubTier::Club150 && *c == 1 && *v == 2);
        let verse2_300 = club_members
            .iter()
            .any(|(t, c, v)| *t == ClubTier::Club300 && *c == 1 && *v == 2);
        assert!(verse1_150, "verse 1 should be a Club150 member");
        assert!(
            verse1_300,
            "verse 1 should ALSO be a Club300 member (subset rule)"
        );
        assert!(
            !verse2_150,
            "verse 2 clubs=[300] should NOT be a Club150 member"
        );
        assert!(verse2_300, "verse 2 should be a Club300 member");
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
        assert_eq!(ftv_nodes.len(), 2, "should have 2 FTV nodes");
    }

    #[test]
    fn heading_edges_created() {
        let data = test_data();
        let card_types = test_card_types();
        let result = build(&data, &card_types, 0);
        let heading_edges: Vec<_> = result
            .graph
            .edge_ids()
            .filter(|&id| {
                result.graph.edge(id).is_some_and(|e| {
                    result.graph.edge_connects(
                        e,
                        |k| matches!(k, NodeKind::VerseGist { .. }),
                        |k| matches!(k, NodeKind::Heading { .. }),
                    )
                })
            })
            .collect();
        assert_eq!(heading_edges.len(), 3);
    }

    #[test]
    fn book_layer_wired() {
        let data = test_data();
        let card_types = test_card_types();
        let result = build(&data, &card_types, 0);
        let book_gists: Vec<_> = result
            .graph
            .node_ids()
            .filter(|&id| matches!(result.graph.node_kind(id), Some(NodeKind::BookGist { .. })))
            .collect();
        let book_refs: Vec<_> = result
            .graph
            .node_ids()
            .filter(|&id| matches!(result.graph.node_kind(id), Some(NodeKind::BookRef { .. })))
            .collect();
        assert_eq!(book_gists.len(), 1, "one BookGist for 1 Corinthians");
        assert_eq!(book_refs.len(), 1, "one BookRef for 1 Corinthians");
    }

    #[test]
    fn chapter_endpoints_wired() {
        let data = test_data();
        let card_types = test_card_types();
        let result = build(&data, &card_types, 0);
        let first_count = result
            .graph
            .edge_ids()
            .filter(|&id| {
                result.graph.edge(id).is_some_and(|e| {
                    e.role == Some(EdgeRole::FirstChild)
                        && result.graph.edge_connects(
                            e,
                            |k| matches!(k, NodeKind::ChapterGist { .. }),
                            |k| matches!(k, NodeKind::VerseGist { .. }),
                        )
                })
            })
            .count();
        let last_count = result
            .graph
            .edge_ids()
            .filter(|&id| {
                result.graph.edge(id).is_some_and(|e| {
                    e.role == Some(EdgeRole::LastChild)
                        && result.graph.edge_connects(
                            e,
                            |k| matches!(k, NodeKind::ChapterGist { .. }),
                            |k| matches!(k, NodeKind::VerseGist { .. }),
                        )
                })
            })
            .count();
        assert_eq!(first_count, 1);
        assert_eq!(last_count, 1);
    }

    #[test]
    fn chapter_club_member_per_tier_per_chapter() {
        let data = test_data();
        let card_types = test_card_types();
        let result = build(&data, &card_types, 0);
        let ccm_tiers: Vec<_> = result
            .graph
            .node_ids()
            .filter_map(|id| match result.graph.node_kind(id) {
                Some(NodeKind::ChapterClubMember { tier, chapter }) => Some((*tier, *chapter)),
                _ => None,
            })
            .collect();
        // Chapter 1 has 150 + 300 presence (verse 1 is 150 → expanded to both; verse 2 is 300).
        assert!(ccm_tiers.contains(&(ClubTier::Club150, 1)));
        assert!(ccm_tiers.contains(&(ClubTier::Club300, 1)));
        assert_eq!(ccm_tiers.len(), 2);
    }

    #[test]
    fn verse_to_club_picks_most_specific_tier() {
        let data = test_data();
        let card_types = test_card_types();
        let result = build(&data, &card_types, 0);

        // Test data: verse 1 tagged 150 (→ both 150 and 300; most specific
        // = 150), verse 2 tagged 300 only (most specific = 300), verse 3
        // untagged (no card).
        let club_gist_150 = result
            .graph
            .node_ids()
            .find(|&id| {
                matches!(
                    result.graph.node_kind(id),
                    Some(NodeKind::ClubGist {
                        tier: ClubTier::Club150
                    })
                )
            })
            .unwrap();
        let club_gist_300 = result
            .graph
            .node_ids()
            .find(|&id| {
                matches!(
                    result.graph.node_kind(id),
                    Some(NodeKind::ClubGist {
                        tier: ClubTier::Club300
                    })
                )
            })
            .unwrap();

        let verse_to_club_cards: Vec<_> = result
            .cards
            .iter()
            .filter(|c| {
                c.hidden.len() == 1
                    && (c.hidden[0] == club_gist_150 || c.hidden[0] == club_gist_300)
            })
            .collect();
        assert_eq!(
            verse_to_club_cards.len(),
            2,
            "verse_to_club should be generated only for verses 1 and 2"
        );

        let v1 = &result.verse_atoms[0];
        let v2 = &result.verse_atoms[1];
        let v1_card = verse_to_club_cards
            .iter()
            .find(|c| c.shown.contains(&v1.ref_node))
            .expect("verse 1 card");
        let v2_card = verse_to_club_cards
            .iter()
            .find(|c| c.shown.contains(&v2.ref_node))
            .expect("verse 2 card");
        assert_eq!(v1_card.hidden, vec![club_gist_150], "verse 1 → Club150");
        assert_eq!(v2_card.hidden, vec![club_gist_300], "verse 2 → Club300");
    }

    #[test]
    fn club_chapter_listing_cards_generated() {
        let data = test_data();
        let card_types = test_card_types();
        let result = build(&data, &card_types, 0);

        // Test data: chapter 1 has verse 1 tagged 150 (→ both 150 and 300)
        // and verse 2 tagged 300. So we expect TWO listing cards:
        // - Club150 / chapter 1 with 1 verse (verse 1).
        // - Club300 / chapter 1 with 2 verses (verse 1 + verse 2).
        let book_ref = result
            .graph
            .node_ids()
            .find(|&id| matches!(result.graph.node_kind(id), Some(NodeKind::BookRef { .. })))
            .unwrap();
        let chapter_ref = result
            .graph
            .node_ids()
            .find(|&id| {
                matches!(
                    result.graph.node_kind(id),
                    Some(NodeKind::ChapterRef { .. })
                )
            })
            .unwrap();

        let listing_cards: Vec<_> = result
            .cards
            .iter()
            .filter(|c| c.shown.len() == 3 && c.shown[1] == book_ref && c.shown[2] == chapter_ref)
            .collect();
        assert_eq!(
            listing_cards.len(),
            2,
            "expected 2 listing cards (Club150 + Club300), got {}",
            listing_cards.len()
        );

        let card_150 = listing_cards
            .iter()
            .find(|c| {
                matches!(
                    result.graph.node_kind(c.shown[0]),
                    Some(NodeKind::ClubGist {
                        tier: ClubTier::Club150
                    })
                )
            })
            .expect("should have a Club150 listing card");
        assert_eq!(card_150.hidden.len(), 1, "Club150 ch 1: just verse 1");

        let card_300 = listing_cards
            .iter()
            .find(|c| {
                matches!(
                    result.graph.node_kind(c.shown[0]),
                    Some(NodeKind::ClubGist {
                        tier: ClubTier::Club300
                    })
                )
            })
            .expect("should have a Club300 listing card");
        assert_eq!(card_300.hidden.len(), 2, "Club300 ch 1: verses 1 and 2");
    }

    #[test]
    fn verses_to_heading_card_generated() {
        let data = test_data();
        let card_types = test_card_types();
        let result = build(&data, &card_types, 0);

        // Test data has one heading ("Greeting") covering verses 1-3.
        // The card hides that heading and shows all three verse refs.
        let heading = result
            .graph
            .node_ids()
            .find(|&id| matches!(result.graph.node_kind(id), Some(NodeKind::Heading { .. })))
            .unwrap();

        // verses_to_heading hides the heading and shows the full range of
        // verse refs. Distinguish from verse_to_heading (which also hides
        // the heading but shows [book_ref, chapter_ref, verse_ref]) by
        // requiring every shown atom to be a VerseRef.
        let card = result
            .cards
            .iter()
            .find(|c| {
                c.hidden == vec![heading]
                    && c.shown.iter().all(|&n| {
                        matches!(result.graph.node_kind(n), Some(NodeKind::VerseRef { .. }))
                    })
            })
            .expect("verses_to_heading card should exist");
        assert_eq!(card.shown.len(), 3, "three verses in the heading range");
    }
}
