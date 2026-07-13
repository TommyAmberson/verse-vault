use std::collections::{HashMap, HashSet};

use serde::{Deserialize, Serialize};

use crate::card::{Card, CardKind, CardState};
use crate::element::ClubTier;
use crate::engine::{ReviewEngine, is_bulk_graduable};
use crate::material_config::{CatchUp, MoveToNextGate};
use crate::schedule_data::{Schedule, VerseRef};
use crate::types::CardId;

/// Whether a card tests the **content of one verse** — its text,
/// its phrase progression, its first words, its citation, or
/// verse-text recall from the reference. Meta-location cards,
/// multi-verse pseudos, and `Reading` return false.
///
/// Only verse-side aggregations apply this filter; card-side
/// metrics still count every card the user actually reviews. With
/// this filter, each verse lives in exactly one stability bucket
/// (the bucket of its worst content card), so verse columns sum to
/// the total memorised-verse count regardless of meta-card drift.
fn is_verse_content_card(kind: &CardKind) -> bool {
    matches!(
        kind,
        CardKind::PhraseFill { .. }
            | CardKind::VerseAtVerseRef
            | CardKind::Recitation
            | CardKind::Citation
            | CardKind::Ftv { .. }
    )
}

/// Five-bucket SRS-style histogram of card or test stability, in days.
/// Bucket boundaries mirror the API's existing SQL stats query so the
/// dashboard's stage tiles read in the same units the per-year breakdown
/// uses: weak < 1d, learning < 7d, familiar < 30d, strong < 90d,
/// mastered ≥ 90d.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StabilityHistogram {
    pub weak: u32,
    pub learning: u32,
    pub familiar: u32,
    pub strong: u32,
    pub mastered: u32,
}

impl StabilityHistogram {
    fn bump(&mut self, stability_days: f32) {
        if stability_days < 1.0 {
            self.weak += 1;
        } else if stability_days < 7.0 {
            self.learning += 1;
        } else if stability_days < 30.0 {
            self.familiar += 1;
        } else if stability_days < 90.0 {
            self.strong += 1;
        } else {
            self.mastered += 1;
        }
    }
}

impl ReviewEngine {
    /// True when any test this card grades was touched (directly or via
    /// propagation) within `schedule_params.sibling_cooldown_secs`.
    /// Used to suppress reviews of overlapping cards inside one session.
    pub fn is_in_cooldown(&self, card_id: CardId, now_secs: i64) -> bool {
        let card = match self.card(card_id) {
            Some(c) => c,
            None => return false,
        };
        let atoms = self.atoms_for(card.verse_id);
        let cd = self.schedule_params.sibling_cooldown_secs;
        card.tests(&atoms).iter().any(|tk| {
            self.tests
                .get(tk)
                .is_some_and(|s| now_secs - s.last_seen_secs < cd)
        })
    }

    /// The minimum predicted retrievability across this card's tests, at
    /// `now_secs`. The card is "due" when this falls below the scheduler's
    /// target retention. Returns None if the card has no tests with state.
    pub fn card_min_r(&self, card: &Card, now_secs: i64) -> Option<f32> {
        let atoms = self.atoms_for(card.verse_id);
        let r_values: Vec<f32> = card
            .tests(&atoms)
            .into_iter()
            .filter_map(|tk| {
                self.tests
                    .get(&tk)
                    .map(|s| self.fsrs.retrievability_of(s, now_secs))
            })
            .collect();
        r_values
            .into_iter()
            .min_by(|a, b| a.partial_cmp(b).unwrap())
    }
}

/// Pick the next due card, ordered by **descending retrievability** of the
/// card's weakest test. Cards at or above `schedule_params.target_retention`
/// are skipped (not yet due); cards in sibling cooldown are skipped. Returns
/// `None` when no card is both due and out of cooldown.
///
/// High-R-first matches the FSRS-author recommendation for capacity-limited
/// sessions: well-known-but-due cards clear cheaply and bank their gains,
/// while at-risk cards left for later get re-scheduled by FSRS regardless.
/// Sims report ~1–5pp retention edge over ascending-R for non-finishers and
/// no difference for users who finish their queue.
///
/// See `docs/scheduling.md` for the full per-test FSRS scheduling story.
pub fn next_card(engine: &ReviewEngine, now_secs: i64) -> Option<CardId> {
    engine
        .cards
        .iter()
        .filter(|c| matches!(c.state, CardState::Active))
        .filter(|c| !engine.is_in_cooldown(c.id, now_secs))
        .filter_map(|c| Some((c, engine.card_min_r(c, now_secs)?)))
        .filter(|(c, r)| *r < engine.target_r_for_verse(c.verse_id))
        .max_by(|(_, a), (_, b)| a.partial_cmp(b).unwrap())
        .map(|(c, _)| c.id)
}

/// Bucket every active card by its **weakest test's stability** —
/// the same min-aggregation `card_min_r` uses to decide due-ness.
/// A card with mixed-stability tests belongs to the bucket of its
/// weakest test (the bucket of its review urgency, not its best
/// memory), so the histogram answers "how many cards am I about to
/// re-learn" rather than "how many tests have I ever drilled".
///
/// Cards with no test state yet (no graded tests) are skipped; they
/// belong to the memorize queue, not the review distribution.
pub fn card_stability_histogram(engine: &ReviewEngine) -> StabilityHistogram {
    let mut hist = StabilityHistogram::default();
    for card in &engine.cards {
        if !matches!(card.state, CardState::Active) {
            continue;
        }
        let atoms = engine.atoms_for(card.verse_id);
        let min_stability = card
            .tests(&atoms)
            .into_iter()
            .filter_map(|tk| engine.tests.get(&tk))
            .map(|s| s.stability)
            .reduce(f32::min);
        if let Some(s) = min_stability {
            hist.bump(s);
        }
    }
    hist
}

/// Count distinct verses with at least one `New` verse-content
/// card — the memorize-queue's verse footprint. Only the cards
/// that test the verse's own content count toward the verse
/// footprint; see [`is_verse_content_card`].
pub fn new_verse_count(engine: &ReviewEngine) -> u32 {
    let mut seen: HashSet<u32> = HashSet::new();
    for card in &engine.cards {
        if !matches!(card.state, CardState::New) {
            continue;
        }
        if !is_verse_content_card(&card.kind) {
            continue;
        }
        if seen.contains(&card.verse_id) {
            continue;
        }
        if !engine.verse_active_for_memorize(card.verse_id) {
            continue;
        }
        seen.insert(card.verse_id);
    }
    seen.len() as u32
}

/// Count distinct verses with at least one due card — the
/// review-queue's verse footprint. Mirrors `due_review_count`'s
/// eligibility (active + below-target, ignoring cooldown) and
/// applies the same verse-content filter as `new_verse_count`.
pub fn due_verse_count(engine: &ReviewEngine, now_secs: i64) -> u32 {
    let mut seen: HashSet<u32> = HashSet::new();
    for card in &engine.cards {
        if !matches!(card.state, CardState::Active) {
            continue;
        }
        if !is_verse_content_card(&card.kind) {
            continue;
        }
        let target = engine.target_r_for_verse(card.verse_id);
        if let Some(r) = engine.card_min_r(card, now_secs)
            && r < target
        {
            seen.insert(card.verse_id);
        }
    }
    seen.len() as u32
}

/// Map each verse to its weakest verse-content card's test stability.
/// Shared work shape behind `verse_stability_histogram` and
/// `learned_verse_count`; both derive their result from this map.
fn verse_min_stability_map(engine: &ReviewEngine) -> HashMap<u32, f32> {
    let mut min_by_verse: HashMap<u32, f32> = HashMap::new();
    for card in &engine.cards {
        if !matches!(card.state, CardState::Active) {
            continue;
        }
        if !is_verse_content_card(&card.kind) {
            continue;
        }
        let atoms = engine.atoms_for(card.verse_id);
        for tk in card.tests(&atoms) {
            if let Some(state) = engine.tests.get(&tk) {
                min_by_verse
                    .entry(card.verse_id)
                    .and_modify(|m| *m = m.min(state.stability))
                    .or_insert(state.stability);
            }
        }
    }
    min_by_verse
}

/// Bucket distinct verses by their **weakest verse-content card's
/// test stability**. Each verse lives in exactly one bucket, so the
/// sum of `weak..mastered` equals the total memorised-verse count.
pub fn verse_stability_histogram(engine: &ReviewEngine) -> StabilityHistogram {
    let mut hist = StabilityHistogram::default();
    for &stability in verse_min_stability_map(engine).values() {
        hist.bump(stability);
    }
    hist
}

/// Count distinct verses whose weakest verse-content card's test
/// stability is at or above `threshold_days`. Sums to
/// `verse_stability_histogram`'s `familiar + strong + mastered` at
/// the default 7-day cutoff.
pub fn learned_verse_count(engine: &ReviewEngine, threshold_days: f32) -> u32 {
    verse_min_stability_map(engine)
        .values()
        .filter(|&&s| s >= threshold_days)
        .count() as u32
}

/// Count active cards whose minimum-test retrievability is below
/// `target_retention` at `now_secs` — the "reviews waiting" queue
/// the user sees as actionable.
///
/// Mirrors `next_card`'s eligibility (active + below-target) but
/// drops the sibling-cooldown filter: cooldown is a session-only
/// suppression heuristic, and a UI surfacing this number between
/// sessions shouldn't have it wobble in the seconds after a review.
/// The count is what FSRS would *eventually* serve, not what
/// `next_card` would surface in this exact moment.
pub fn due_review_count(engine: &ReviewEngine, now_secs: i64) -> u32 {
    engine
        .cards
        .iter()
        .filter(|c| matches!(c.state, CardState::Active))
        .filter_map(|c| Some((c, engine.card_min_r(c, now_secs)?)))
        .filter(|(c, r)| *r < engine.target_r_for_verse(c.verse_id))
        .count() as u32
}

/// Pick the next card from the memorize queue: any `New` card. Returns one
/// canonical card per call; the caller is expected to walk the per-verse
/// progression client-side (see [`crate::session::Session::new_verse_progression`])
/// and then graduate the verse via [`ReviewEngine::graduate_verse`].
///
/// Cooldown and FSRS due time don't apply — `New` cards have never been
/// reviewed. Ties broken by `CardId` (insertion order), which means the
/// memorize queue surfaces cards in the same order the builder emitted
/// them (early verses first).
pub fn next_memorize_card(engine: &ReviewEngine, now_secs: i64) -> Option<CardId> {
    // Thin wrapper around the two-phase batch; the existing single-card
    // surface is preserved for callers (the wasm `next_memorize_card`
    // binding, schedule tests) that don't have or need a schedule.
    next_memorize_batch(engine, None, now_secs, 1)
        .first()
        .copied()
}

/// Build the next `batch_size` memorize cards, in spec-defined order:
///
/// 1. **Phase 1** — across enabled clubs whose `catch_up` is
///    `CalendarCascade` AND whose cross-club gate is open, take all
///    un-memorized verses in *this week's* calendar row, sorted by
///    canonical (deck/verse_id) order. Phase 1 ignores `batch_size`
///    (soft cap overflow allowed per the spec).
/// 2. **Phase 2** — across all eligible clubs (Sequential pools + the
///    backlog/lookahead of CalendarCascade pools), take un-memorized
///    verses in canonical order until the batch is filled.
///
/// Returns one anchor `CardId` per chosen verse — `Recitation` if the
/// verse emits one, otherwise the first un-graduated bulk-graduable
/// card for that verse (typically `PhraseFill { 0 }`).
///
/// Passing `schedule = None` is equivalent to all-`Sequential`: Phase 1
/// contributes nothing, Phase 2 collects every eligible un-memorized
/// verse in canonical order.
pub fn next_memorize_batch(
    engine: &ReviewEngine,
    schedule: Option<&Schedule>,
    now_secs: i64,
    batch_size: u8,
) -> Vec<CardId> {
    let eligible = compute_eligible_clubs(engine, schedule, now_secs);
    if eligible.is_empty() {
        return Vec::new();
    }

    let unmemorized = unmemorized_verses_by_tier(engine, &eligible);
    let mut picked: Vec<u32> = Vec::new();
    let mut seen: HashSet<u32> = HashSet::new();

    // Phase 1: CalendarCascade clubs' this-week primary. Only runs when
    // a schedule is supplied AND at least one eligible club is on
    // CalendarCascade — the (book, chapter, verse) → verse_id lookup is
    // an O(verses) HashMap with owned String keys, so building it
    // unconditionally would burn one full allocation on every memorize
    // click for the common Sequential-only path.
    let mut any_cascade = false;
    for &club in &eligible {
        if engine.material_config.catch_up_for(club) == CatchUp::CalendarCascade {
            any_cascade = true;
            break;
        }
    }
    if any_cascade
        && let Some(sched) = schedule
        && let Some(week_idx) = sched.current_week_index(now_secs)
    {
        let lookup = build_verse_lookup(engine);
        let mut phase1: Vec<u32> = Vec::new();
        for &club in &eligible {
            if engine.material_config.catch_up_for(club) != CatchUp::CalendarCascade {
                continue;
            }
            let unmem_for_club = unmemorized.get(&club).map(Vec::as_slice).unwrap_or(&[]);
            for vref in sched.week_verse_refs(week_idx, club) {
                let Some(&vid) = lookup.get(&vref) else {
                    continue;
                };
                if unmem_for_club.binary_search(&vid).is_ok() && seen.insert(vid) {
                    phase1.push(vid);
                }
            }
        }
        phase1.sort_unstable();
        picked.extend(phase1);
    }

    // Phase 2: everything else eligible, in canonical (verse_id) order,
    // capped at remaining batch_size.
    let remaining = (batch_size as usize).saturating_sub(picked.len());
    if remaining > 0 {
        let mut phase2: Vec<u32> = Vec::new();
        for &club in &eligible {
            let Some(verses) = unmemorized.get(&club) else {
                continue;
            };
            for &vid in verses {
                if seen.insert(vid) {
                    phase2.push(vid);
                }
            }
        }
        phase2.sort_unstable();
        picked.extend(phase2.into_iter().take(remaining));
    }

    picked
        .into_iter()
        .filter_map(|vid| anchor_card_for_verse(engine, vid))
        .collect()
}

/// Anchor card for a verse: Recitation if the deck emitted one, else the
/// first un-graduated bulk-graduable card (typically `PhraseFill { 0 }`).
/// Returns `None` when the verse has no un-graduated content cards at
/// all — caller should treat that as "verse is fully memorized."
///
/// Shared helper so `next_memorize_batch` and the wasm `memorize_session`
/// verse-anchor pick converge.
pub fn anchor_card_for_verse(engine: &ReviewEngine, verse_id: u32) -> Option<CardId> {
    let recitation = engine
        .cards
        .iter()
        .find(|c| c.verse_id == verse_id && matches!(c.kind, CardKind::Recitation));
    if let Some(card) = recitation
        && matches!(card.state, CardState::New)
    {
        return Some(card.id);
    }
    engine
        .cards
        .iter()
        .find(|c| {
            c.verse_id == verse_id
                && matches!(c.state, CardState::New)
                && is_bulk_graduable(&c.kind)
        })
        .map(|c| c.id)
}

/// Apply the per-pair cross-club gates and return the enabled clubs in
/// priority order [Club150, Club300, Full] that actually contribute to
/// the memorize fill at `now_secs`.
///
/// The highest-priority *enabled* club is always eligible (no gate above
/// it). For subsequent enabled clubs, look up the gate from the most-
/// recent enabled higher club and evaluate it. A skip-club layout
/// (e.g. Club 150 enabled, Club 300 disabled, Full enabled) uses
/// `move_to_next.p300_to_full` against Club 150's position — adjacent-
/// pair gates don't compose across skips, by design.
fn compute_eligible_clubs(
    engine: &ReviewEngine,
    schedule: Option<&Schedule>,
    now_secs: i64,
) -> Vec<ClubTier> {
    let config = &engine.material_config;
    let mut result: Vec<ClubTier> = Vec::new();
    let mut prev_eligible: Option<ClubTier> = None;
    for club in [ClubTier::Club150, ClubTier::Club300, ClubTier::Full] {
        if !config.memorize_enabled_for(club) {
            continue;
        }
        let gate_open = match prev_eligible {
            None => true,
            Some(higher) => {
                // `gate_to(Club150)` is the only `None` case — that branch
                // is structurally unreachable here because Club150 always
                // hits the `prev_eligible: None` arm above. Any future
                // tier added between Club150 and Club300 would need a
                // gate entry in `MaterialConfig`; the expect catches the
                // omission instead of silently falling through to
                // `Always`.
                let gate = config
                    .gate_to(club)
                    .expect("gate_to is Some for every non-top tier");
                gate_is_open(engine, schedule, higher, gate, now_secs)
            }
        };
        if gate_open {
            result.push(club);
            prev_eligible = Some(club);
        }
    }
    result
}

/// Is the cross-club gate `gate` open, given that `higher` is the most-
/// recent enabled club above the candidate?
fn gate_is_open(
    engine: &ReviewEngine,
    schedule: Option<&Schedule>,
    higher: ClubTier,
    gate: MoveToNextGate,
    now_secs: i64,
) -> bool {
    match gate {
        MoveToNextGate::Always => true,
        MoveToNextGate::FullyMemorized => {
            let (memorized, total) = tier_memorize_progress(engine, higher);
            total > 0 && memorized == total
        }
        MoveToNextGate::AfterMajorCheckpoint => {
            let Some(sched) = schedule else {
                return false;
            };
            let needed = sched.cumulative_count_through_last_meet(higher, now_secs);
            if needed == 0 {
                // No meet has passed yet.
                return false;
            }
            tier_memorize_progress(engine, higher).0 >= needed
        }
        MoveToNextGate::AfterMinorCheckpoint => {
            let Some(sched) = schedule else {
                return false;
            };
            let needed = sched.cumulative_count_through_current_week(higher, now_secs);
            if needed == 0 {
                return false;
            }
            tier_memorize_progress(engine, higher).0 >= needed
        }
        MoveToNextGate::CaughtUp => {
            let Some(sched) = schedule else {
                // No schedule = no calendar position to compare against;
                // treat as "always caught up" so the next club isn't
                // permanently gated out.
                return true;
            };
            let needed = sched.cumulative_count_through_previous_week(higher, now_secs);
            tier_memorize_progress(engine, higher).0 >= needed
        }
    }
}

/// Map of (book, chapter, verse) → verse_id, sourced from the engine's
/// per-verse render data. Built once per `next_memorize_batch` call.
fn build_verse_lookup(engine: &ReviewEngine) -> HashMap<VerseRef, u32> {
    let mut map: HashMap<VerseRef, u32> = HashMap::new();
    for (&vid, render) in engine.verse_render_data.iter() {
        map.insert((render.book.clone(), render.chapter, render.verse), vid);
    }
    map
}

/// For each `tier` in `eligible`, the sorted-ascending list of verse_ids
/// with that tier whose bulk-graduable cards include at least one `New`
/// — i.e. verses the user hasn't yet graduated.
fn unmemorized_verses_by_tier(
    engine: &ReviewEngine,
    eligible: &[ClubTier],
) -> HashMap<ClubTier, Vec<u32>> {
    let tier_set: HashSet<ClubTier> = eligible.iter().copied().collect();
    let mut grouped: HashMap<ClubTier, Vec<u32>> = HashMap::new();
    let mut seen: HashSet<u32> = HashSet::new();
    for card in &engine.cards {
        if !matches!(card.state, CardState::New) || !is_bulk_graduable(&card.kind) {
            continue;
        }
        if !seen.insert(card.verse_id) {
            continue;
        }
        let Some(elements) = engine.verse_index.elements_of(card.verse_id) else {
            continue;
        };
        let Some(&tier) = elements.clubs.first() else {
            continue;
        };
        if !tier_set.contains(&tier) {
            continue;
        }
        grouped.entry(tier).or_default().push(card.verse_id);
    }
    // verse_ids are assigned in deck order, so the per-tier vectors are
    // already ascending — but the card scan can reach them out-of-order
    // (e.g. Recitation cards land after their PhraseFills, both sharing
    // the same verse_id). Sort for canonical-order safety.
    for v in grouped.values_mut() {
        v.sort_unstable();
        v.dedup();
    }
    grouped
}

/// `(memorized, total)` count of verses with `tier` as their most-specific
/// tier in this engine. `memorized` = verses with no `New` bulk-graduable
/// cards left.
fn tier_memorize_progress(engine: &ReviewEngine, tier: ClubTier) -> (usize, usize) {
    // One pass over `engine.cards` building per-verse "has any New bulk-
    // graduable card" — the HashMap key already dedupes verse_ids, so an
    // extra HashSet for tracking would be redundant. The second walk is
    // over the HashMap (not the cards), so it stays O(verses) regardless
    // of how many cards each verse has.
    let mut has_new: HashMap<u32, bool> = HashMap::new();
    for card in &engine.cards {
        if !is_bulk_graduable(&card.kind) {
            continue;
        }
        let entry = has_new.entry(card.verse_id).or_insert(false);
        if matches!(card.state, CardState::New) {
            *entry = true;
        }
    }
    let mut memorized = 0;
    let mut total = 0;
    for (&vid, &any_new) in &has_new {
        let Some(elements) = engine.verse_index.elements_of(vid) else {
            continue;
        };
        if elements.clubs.first().copied() != Some(tier) {
            continue;
        }
        total += 1;
        if !any_new {
            memorized += 1;
        }
    }
    (memorized, total)
}

/// Count of `New` cards eligible for the memorize queue — every
/// `New` card whose verse's tier is currently `Active`. Drives the
/// "N to memorize" nudge in the web UI nav and the dashboard.
pub fn new_card_count(engine: &ReviewEngine) -> u32 {
    engine
        .cards
        .iter()
        .filter(|c| matches!(c.state, CardState::New))
        .filter(|c| engine.verse_active_for_memorize(c.verse_id))
        .count() as u32
}

/// Pick a card from the relearning priority lane: any `Active` card that has
/// at least one test with `pending_relearn = true` whose FSRS-computed due
/// time has elapsed. Bypasses the sibling cooldown — a freshly-lapsed card
/// is exactly what we want the user re-drilling, even if another card in the
/// session just touched a shared test.
///
/// Returns `None` when no lane card is due. Ties broken by earliest due time
/// (the lapse a learner has been kept waiting longest gets cleared first).
pub fn next_relearn_card(engine: &ReviewEngine, now_secs: i64) -> Option<CardId> {
    engine
        .cards
        .iter()
        .filter(|c| matches!(c.state, CardState::Active))
        .filter_map(|c| {
            let target = engine.target_r_for_verse(c.verse_id);
            let atoms = engine.atoms_for(c.verse_id);
            let earliest_due = c
                .tests(&atoms)
                .into_iter()
                .filter_map(|tk| {
                    let state = engine.tests.get(&tk)?;
                    if !state.pending_relearn {
                        return None;
                    }
                    let due = engine.fsrs.due_at(state, target);
                    (due <= now_secs).then_some(due)
                })
                .min()?;
            Some((c.id, earliest_due))
        })
        .min_by_key(|(_, due)| *due)
        .map(|(id, _)| id)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::card::CardKind;
    use crate::content::MaterialData;
    use crate::types::Grade;

    fn sample_material_one_verse() -> MaterialData {
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
                        "clubs": []
                    }
                ],
                "headings": []
            }"#,
        )
        .unwrap()
    }

    fn sample_material_two_verses() -> MaterialData {
        serde_json::from_str(
            r#"{
                "year": 3,
                "books": ["John"],
                "chapters": [
                    {"book": "John", "number": 3, "start_verse": 16, "end_verse": 17}
                ],
                "verses": [
                    {
                        "book": "John", "chapter": 3, "verse": 16,
                        "phraseWordCounts": [2, 2],
                        "annotations": [],
                        "ftvWordCount": null,
                        "clubs": []
                    },
                    {
                        "book": "John", "chapter": 3, "verse": 17,
                        "phraseWordCounts": [2, 3],
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

    fn sample_material_mixed_tiers() -> MaterialData {
        // Verse 16 → Club150; verse 17 → Club300. Lets a config with
        // 150 Active + 300 Maintenance carve the memorize queue cleanly
        // along verse_id.
        serde_json::from_str(
            r#"{
                "year": 3,
                "books": ["John"],
                "chapters": [
                    {"book": "John", "number": 3, "start_verse": 16, "end_verse": 17}
                ],
                "verses": [
                    {
                        "book": "John", "chapter": 3, "verse": 16,
                        "phraseWordCounts": [2, 2], "annotations": [],
                        "ftvWordCount": null, "clubs": [150]
                    },
                    {
                        "book": "John", "chapter": 3, "verse": 17,
                        "phraseWordCounts": [2, 3], "annotations": [],
                        "ftvWordCount": null, "clubs": [300]
                    }
                ],
                "headings": []
            }"#,
        )
        .unwrap()
    }

    fn config_150_active_300_maintenance() -> crate::material_config::MaterialConfig {
        crate::material_config::MaterialConfig::from_scopes(
            crate::material_config::TierScope::Up150,
            crate::material_config::TierScope::Up300,
        )
    }

    #[test]
    fn next_memorize_card_skips_maintenance_tier_verses() {
        // Verse 17 (Club300) is Maintenance; the helper must hand
        // back a card anchored to verse 16 (Club150 → Active).
        let m = sample_material_mixed_tiers();
        let r = crate::builder::build_with_config(&m, &config_150_active_300_maintenance(), 0);
        let engine = ReviewEngine::new(r, 0.9);
        let card_id = next_memorize_card(&engine, 0).expect("a card should be due");
        assert_eq!(engine.card(card_id).unwrap().verse_id, 0);
    }

    #[test]
    fn new_card_count_excludes_maintenance_tier_verses() {
        let m = sample_material_mixed_tiers();
        let r_all_active = crate::builder::build_with_config(
            &m,
            // Use the test-friendly all-clubs-enabled config so the
            // baseline really is "everything Active" — the new-user
            // default is Club 150 only, which would silently match the
            // Club300-Maintenance count below.
            &crate::material_config::MaterialConfig::all_clubs_enabled(0.9),
            0,
        );
        let engine_all = ReviewEngine::new(r_all_active, 0.9);
        let total_when_all_active = new_card_count(&engine_all);

        let r_mixed =
            crate::builder::build_with_config(&m, &config_150_active_300_maintenance(), 0);
        let engine_mixed = ReviewEngine::new(r_mixed, 0.9);
        let count_with_300_maintenance = new_card_count(&engine_mixed);

        assert!(
            count_with_300_maintenance < total_when_all_active,
            "expected fewer memorize cards when Club300 is in Maintenance: \
             all-active={total_when_all_active}, mixed={count_with_300_maintenance}",
        );
        for c in &engine_mixed.cards {
            if !matches!(c.state, CardState::New) {
                continue;
            }
            if !engine_mixed.verse_active_for_memorize(c.verse_id) {
                continue;
            }
            let elements = engine_mixed.verse_index.elements_of(c.verse_id);
            let tier = elements.and_then(|e| e.clubs.first().copied());
            assert!(
                tier.is_none() || tier == Some(crate::element::ClubTier::Club150),
                "card {c:?} should be Club150 or pseudo, got tier {tier:?}",
            );
        }
    }

    #[test]
    fn new_verse_count_excludes_maintenance_tier_verses() {
        let m = sample_material_mixed_tiers();
        let r = crate::builder::build_with_config(&m, &config_150_active_300_maintenance(), 0);
        let engine = ReviewEngine::new(r, 0.9);
        // Two verses exist; only Club150 (verse_id 0) should count.
        assert_eq!(new_verse_count(&engine), 1);
    }

    #[test]
    fn card_stability_histogram_stays_unfiltered_across_tiers() {
        let m = sample_material_mixed_tiers();
        let r = crate::builder::build_with_config(&m, &config_150_active_300_maintenance(), 0);
        let mut engine = ReviewEngine::new(r, 0.9);
        engine.graduate_all();
        let h = card_stability_histogram(&engine);
        let total = h.weak + h.learning + h.familiar + h.strong + h.mastered;
        assert_eq!(total as usize, engine.cards.len());
    }

    #[test]
    fn next_card_returns_some_when_seeded_unseen_advanced_a_year() {
        let m = sample_material_two_verses();
        // build at t=0; seeds last_base = -365 days. At now_secs = 0, the
        // forgetting curve has had 365 days to decay, so retrievability is
        // far below the 0.9 target and `next_card` should return Some.
        let r = crate::builder::build(&m, 0);
        let mut engine = ReviewEngine::new(r, 0.9);
        engine.graduate_all();
        let now = 86400 * 365 + 86400 * 60;
        let pick = next_card(&engine, now);
        assert!(pick.is_some());
    }

    #[test]
    fn next_card_skips_new_cards() {
        let m = sample_material_two_verses();
        let r = crate::builder::build(&m, 0);
        let engine = ReviewEngine::new(r, 0.9);
        // No graduation: every card is `New`. `next_card` is a review-only
        // function, so it must return None.
        assert!(next_card(&engine, 86400 * 400).is_none());
    }

    #[test]
    fn next_memorize_card_returns_new_card() {
        let m = sample_material_two_verses();
        let r = crate::builder::build(&m, 0);
        let engine = ReviewEngine::new(r, 0.9);
        assert!(next_memorize_card(&engine, 0).is_some());
    }

    #[test]
    fn graduate_verse_flips_state_and_unblocks_review() {
        let m = sample_material_one_verse();
        let r = crate::builder::build(&m, 0);
        let mut engine = ReviewEngine::new(r, 0.9);
        let count = engine.graduate_verse(0);
        assert!(count > 0);
        // Idempotent.
        assert_eq!(engine.graduate_verse(0), 0);
        // graduate_verse flips the unconditional set. Conditional kinds
        // (here: Ftv) still need explicit graduate_card. Once everything
        // is flipped /memorize empties and /review sees the cards.
        let conditional_ids: Vec<crate::types::CardId> = engine
            .cards
            .iter()
            .filter(|c| matches!(c.state, CardState::New))
            .map(|c| c.id)
            .collect();
        for id in conditional_ids {
            engine.graduate_card(id);
        }
        assert!(next_memorize_card(&engine, 0).is_none());
        assert!(next_card(&engine, 86400 * 400).is_some());
    }

    #[test]
    fn graduate_verse_skips_conditional_kinds_and_pseudos() {
        // Two-verse Club150 chapter with a heading covering both, plus
        // FTVs and the conditional meta-location toggles enabled. The
        // builder emits Ftv, VerseInHeading, VerseInClub, plus the
        // multi-verse pseudos HeadingPassage and ChapterClubList.
        // graduate_verse must leave every conditional / pseudo card
        // `New` — they're standalone session items now.
        let m: MaterialData = serde_json::from_str(
            r#"{
                "year": 3,
                "books": ["John"],
                "chapters": [
                    {"book": "John", "number": 3, "start_verse": 16, "end_verse": 17}
                ],
                "verses": [
                    {"book": "John", "chapter": 3, "verse": 16, "phraseWordCounts": [2, 2], "annotations": [], "ftvWordCount": 2, "clubs": [150]},
                    {"book": "John", "chapter": 3, "verse": 17, "phraseWordCounts": [2, 3], "annotations": [], "ftvWordCount": 2, "clubs": [150]}
                ],
                "headings": [{
                    "book": "John",
                    "startChapter": 3, "startVerse": 16,
                    "endChapter": 3, "endVerse": 17
                }]
            }"#,
        )
        .unwrap();
        let config = crate::material_config::MaterialConfig {
            heading_card: true,
            club_card_scope: crate::material_config::TierScope::All,
            ..crate::material_config::MaterialConfig::default()
        };
        let r = crate::builder::build_with_config(&m, &config, 0);
        let mut engine = ReviewEngine::new(r, 0.9);

        let conditional_ids: Vec<(crate::types::CardId, CardKind)> = engine
            .cards
            .iter()
            .filter(|c| {
                matches!(
                    c.kind,
                    CardKind::Ftv { .. }
                        | CardKind::VerseInHeading { .. }
                        | CardKind::VerseInClub { .. }
                        | CardKind::HeadingPassage { .. }
                        | CardKind::ChapterClubList { .. }
                )
            })
            .map(|c| (c.id, c.kind))
            .collect();
        assert!(
            !conditional_ids.is_empty(),
            "expected at least one conditional/pseudo card in this fixture"
        );

        // Graduate both real verses; every conditional / pseudo card
        // stays `New`.
        engine.graduate_verse(0);
        engine.graduate_verse(1);
        for (id, kind) in &conditional_ids {
            assert!(
                matches!(engine.card(*id).unwrap().state, CardState::New),
                "{kind:?} ({id:?}) should still be New after graduate_verse"
            );
        }

        // graduate_card flips each one. Idempotent on a second call.
        for (id, _) in &conditional_ids {
            assert!(engine.graduate_card(*id));
            assert!(!engine.graduate_card(*id));
            assert!(matches!(engine.card(*id).unwrap().state, CardState::Active));
        }
    }

    #[test]
    fn graduate_card_returns_false_for_unknown_id() {
        let m = sample_material_one_verse();
        let r = crate::builder::build(&m, 0);
        let mut engine = ReviewEngine::new(r, 0.9);
        assert!(!engine.graduate_card(crate::types::CardId(u32::MAX)));
    }

    #[test]
    fn recitation_cools_down_phrasefill_via_shared_test() {
        let m = sample_material_one_verse();
        let r = crate::builder::build(&m, 0);
        let mut engine = ReviewEngine::new(r, 0.9);
        let now = 86400 * 365;
        let recit_id = engine
            .cards
            .iter()
            .find(|c| matches!(c.kind, CardKind::Recitation))
            .unwrap()
            .id;
        engine.review(recit_id, Grade::Good, now);

        let pf_id = engine
            .cards
            .iter()
            .find(|c| matches!(c.kind, CardKind::PhraseFill { .. }))
            .unwrap()
            .id;
        // Recitation and PhraseFill now share the same PhraseFromContext
        // test per phrase, so reviewing Recitation puts every PhraseFill on
        // cooldown — we don't want the user drilling the same phrase twice
        // back-to-back.
        assert!(engine.is_in_cooldown(pf_id, now + 60));
    }

    #[test]
    fn relearn_lane_empty_before_pending_relearn_due_elapsed() {
        // Grade Again at t=now; the FSRS post-failure interval is ~6h, so the
        // lane should not surface the card until that interval elapses.
        let m = sample_material_one_verse();
        let r = crate::builder::build(&m, 0);
        let mut engine = ReviewEngine::new(r, 0.9);
        engine.graduate_all();
        let now = 86400 * 365;
        let card_id = engine
            .cards
            .iter()
            .find(|c| matches!(c.kind, CardKind::PhraseFill { .. }))
            .unwrap()
            .id;
        engine.review(card_id, Grade::Again, now);
        // 1 minute later — well before the 6h FSRS sub-day interval.
        assert!(next_relearn_card(&engine, now + 60).is_none());
    }

    #[test]
    fn relearn_lane_surfaces_card_once_fsrs_due_time_elapses() {
        let m = sample_material_one_verse();
        let r = crate::builder::build(&m, 0);
        let mut engine = ReviewEngine::new(r, 0.9);
        engine.graduate_all();
        let now = 86400 * 365;
        let card_id = engine
            .cards
            .iter()
            .find(|c| matches!(c.kind, CardKind::PhraseFill { .. }))
            .unwrap()
            .id;
        engine.review(card_id, Grade::Again, now);
        // A day later — well past the 6h post-failure interval.
        assert_eq!(next_relearn_card(&engine, now + 86400), Some(card_id));
    }

    #[test]
    fn relearn_lane_skips_new_cards() {
        // A New card's pending_relearn flag should not surface in the lane:
        // the lane is review-only.
        let m = sample_material_one_verse();
        let r = crate::builder::build(&m, 0);
        let mut engine = ReviewEngine::new(r, 0.9);
        let now = 86400 * 365;
        let card_id = engine
            .cards
            .iter()
            .find(|c| matches!(c.kind, CardKind::PhraseFill { .. }))
            .unwrap()
            .id;
        // No graduation: card stays New. Forcibly set pending_relearn anyway.
        let key = engine.card(card_id).unwrap().tests(&engine.atoms_for(0))[0];
        engine.tests.get_mut(&key).unwrap().pending_relearn = true;
        engine.tests.get_mut(&key).unwrap().stability = 0.25;
        engine.tests.get_mut(&key).unwrap().last_base_secs = now - 86400;
        assert!(next_relearn_card(&engine, now).is_none());
    }

    #[test]
    fn relearn_lane_bypasses_sibling_cooldown() {
        // Lapse a card, wait past the FSRS sub-day due time, then re-touch
        // one of its shared tests so the cooldown filter would mask it. The
        // lane must still surface it — defeating that mask is the lane's
        // only job.
        let m = sample_material_one_verse();
        let r = crate::builder::build(&m, 0);
        let mut engine = ReviewEngine::new(r, 0.9);
        engine.graduate_all();
        let now = 86400 * 365;
        let pf_id = engine
            .cards
            .iter()
            .find(|c| matches!(c.kind, CardKind::PhraseFill { .. }))
            .unwrap()
            .id;
        engine.review(pf_id, Grade::Again, now);
        let later = now + 86400;
        let touched_test = engine.card(pf_id).unwrap().tests(&engine.atoms_for(0))[0];
        engine.tests.get_mut(&touched_test).unwrap().last_seen_secs = later - 60;
        assert!(engine.is_in_cooldown(pf_id, later));
        assert_eq!(next_relearn_card(&engine, later), Some(pf_id));
    }

    #[test]
    fn relearn_lane_clears_after_passing_grade() {
        let m = sample_material_one_verse();
        let r = crate::builder::build(&m, 0);
        let mut engine = ReviewEngine::new(r, 0.9);
        engine.graduate_all();
        let now = 86400 * 365;
        let card_id = engine
            .cards
            .iter()
            .find(|c| matches!(c.kind, CardKind::PhraseFill { .. }))
            .unwrap()
            .id;
        engine.review(card_id, Grade::Again, now);
        // Pass after the FSRS due window — lane should clear.
        engine.review(card_id, Grade::Good, now + 86400);
        assert!(next_relearn_card(&engine, now + 2 * 86400).is_none());
    }

    #[test]
    fn next_card_orders_by_descending_retrievability() {
        // Two cards both below target_retention. The one with the *higher*
        // R (closer to remembered) should surface first per the FSRS-author-
        // recommended ordering.
        let m = sample_material_two_verses();
        let r = crate::builder::build(&m, 0);
        let mut engine = ReviewEngine::new(r, 0.9);
        engine.graduate_all();
        let now = 86400 * 365 + 86400 * 60;

        // Pick two PhraseFill cards from different verses to avoid sibling
        // cooldown interactions. Boost one card's stability so its R is
        // higher (closer to 1) at `now` than the other's.
        let pfs: Vec<_> = engine
            .cards
            .iter()
            .filter(|c| matches!(c.kind, CardKind::PhraseFill { .. }))
            .map(|c| (c.id, c.verse_id))
            .collect();
        let (high_r_id, _) = pfs.iter().find(|(_, v)| *v == 0).copied().unwrap();
        let (low_r_id, _) = pfs.iter().find(|(_, v)| *v == 1).copied().unwrap();
        let high_test = engine.card(high_r_id).unwrap().tests(&engine.atoms_for(0))[0];
        engine.tests.get_mut(&high_test).unwrap().stability = 100.0; // high R at `now`

        let pick = next_card(&engine, now).expect("a card should be due");
        assert_eq!(pick, high_r_id, "high-R card must surface before low-R");
        assert_ne!(pick, low_r_id);
    }

    #[test]
    fn next_card_returns_none_when_all_above_target() {
        // After build at t=now, every state's last_base is at now-365 days
        // with stability 1.0. At now (the build time), retrievability has
        // decayed for 365 days. Use a very-low target so all cards fall
        // above it → next_card should return None.
        let m = sample_material_two_verses();
        let r = crate::builder::build(&m, 86400 * 365);
        let mut engine = ReviewEngine::new(r, 0.9);
        engine.schedule_params.target_retention = 0.0;
        let pick = next_card(&engine, 86400 * 365);
        assert!(pick.is_none());
    }

    #[test]
    fn due_review_count_matches_next_card_eligibility() {
        // Build at t0=0 then jump forward a year — every active card's
        // retrievability has decayed well below default 0.9, so every
        // active card should count as due.
        let m = sample_material_two_verses();
        let r = crate::builder::build(&m, 0);
        let mut engine = ReviewEngine::new(r, 0.9);
        engine.graduate_all();
        let now = 86400 * 365;

        let active = engine
            .cards
            .iter()
            .filter(|c| matches!(c.state, CardState::Active))
            .count() as u32;
        assert!(active > 0, "test material must produce active cards");
        assert_eq!(due_review_count(&engine, now), active);
    }

    #[test]
    fn due_review_count_is_zero_when_no_card_is_due() {
        // `new_unseen` antedates test states by 365 days from the build
        // timestamp, so a build at `now` and a query at `now - 365 days`
        // sees elapsed = 0 → retrievability 1.0 → nothing below target.
        // Verifies the per-verse-retention filter still excludes not-yet-
        // due cards after the threshold move.
        let now = 86400 * 365;
        let m = sample_material_two_verses();
        let r = crate::builder::build(&m, now);
        let mut engine = ReviewEngine::new(r, 0.9);
        engine.graduate_all();
        assert_eq!(due_review_count(&engine, 0), 0);
    }

    #[test]
    fn card_stability_histogram_skips_new_cards() {
        // No graduation = every card is `New`. Histogram must be all zeros
        // even though each card has seeded test states (they just don't
        // belong to the "review distribution" yet).
        let m = sample_material_two_verses();
        let r = crate::builder::build(&m, 0);
        let engine = ReviewEngine::new(r, 0.9);
        let h = card_stability_histogram(&engine);
        assert_eq!(h, StabilityHistogram::default());
    }

    #[test]
    fn card_stability_histogram_buckets_active_cards_by_min_test_stability() {
        let m = sample_material_two_verses();
        let r = crate::builder::build(&m, 0);
        let mut engine = ReviewEngine::new(r, 0.9);
        engine.graduate_all();

        // Default seed leaves every test at stability 1.0 — every active
        // card lands in `learning` (>=1, <7). Nothing in any other bucket.
        let h = card_stability_histogram(&engine);
        assert!(h.learning > 0);
        assert_eq!(h.weak, 0);
        assert_eq!(h.familiar, 0);
        assert_eq!(h.strong, 0);
        assert_eq!(h.mastered, 0);

        // Boost one test's stability into `mastered` and confirm the
        // affected card moves to mastered iff that's its weakest test.
        // Picking a PhraseFill card and bumping ALL its tests so the
        // min (and thus the bucket) flips.
        let card_id = engine
            .cards
            .iter()
            .find(|c| matches!(c.kind, CardKind::PhraseFill { .. }))
            .unwrap()
            .id;
        let atoms = engine.atoms_for(engine.card(card_id).unwrap().verse_id);
        for tk in engine.card(card_id).unwrap().tests(&atoms) {
            engine.tests.get_mut(&tk).unwrap().stability = 100.0;
        }

        let h2 = card_stability_histogram(&engine);
        assert_eq!(h2.mastered, 1, "the boosted card must land in mastered");
        assert_eq!(h2.learning, h.learning - 1);
    }

    #[test]
    fn new_verse_count_counts_distinct_verses_with_new_cards() {
        let m = sample_material_two_verses();
        let r = crate::builder::build(&m, 0);
        let engine = ReviewEngine::new(r, 0.9);
        // Both verses have New cards before any graduation.
        assert_eq!(new_verse_count(&engine), 2);
    }

    #[test]
    fn new_verse_count_drops_to_zero_after_graduation() {
        let m = sample_material_two_verses();
        let r = crate::builder::build(&m, 0);
        let mut engine = ReviewEngine::new(r, 0.9);
        engine.graduate_all();
        assert_eq!(new_verse_count(&engine), 0);
    }

    #[test]
    fn due_verse_count_matches_distinct_due_verses() {
        let m = sample_material_two_verses();
        let r = crate::builder::build(&m, 0);
        let mut engine = ReviewEngine::new(r, 0.9);
        engine.graduate_all();
        let now = 86400 * 365;
        // Both verses' cards are stale → both verses count.
        assert_eq!(due_verse_count(&engine, now), 2);
    }

    #[test]
    fn due_verse_count_skips_new_verses() {
        let m = sample_material_two_verses();
        let r = crate::builder::build(&m, 0);
        let engine = ReviewEngine::new(r, 0.9);
        // No graduation = no Active cards = nothing to be due.
        assert_eq!(due_verse_count(&engine, 86400 * 365), 0);
    }

    #[test]
    fn due_review_count_excludes_new_cards() {
        // Without `graduate_all`, every card is still `CardState::New`.
        // The builder seeds test states for them, but the helper filters
        // on `Active` so the count must still be zero.
        let m = sample_material_two_verses();
        let r = crate::builder::build(&m, 0);
        let engine = ReviewEngine::new(r, 0.9);
        let now = 86400 * 365;
        assert_eq!(due_review_count(&engine, now), 0);
    }

    // ===== next_memorize_batch (two-phase canonical fill) =====

    use crate::material_config::{
        CatchUp, ClubMemorizeConfig, MaterialConfig, MoveToNextConfig, MoveToNextGate, TierScope,
    };
    use crate::schedule_data::{ClubVerseLists, Passage, PassageBlock, Schedule, ScheduleWeek};

    fn make_two_club_schedule() -> Schedule {
        // Single passage covering both fixture verses: John 3:16 (Club150)
        // and John 3:17 (Club300). week_verse_refs(0, Club150) → [(John,3,16)];
        // week_verse_refs(0, Club300) → [(John,3,17)].
        Schedule {
            version: 1,
            material_id: "test".into(),
            season: "2025-26".into(),
            title: "test".into(),
            meeting_day_of_week: "Mon".into(),
            weeks: vec![ScheduleWeek {
                date: "2025-09-08".into(),
                blocks: vec![PassageBlock {
                    passage: Passage {
                        book: "John".into(),
                        chapter: 3,
                        start_verse: 16,
                        end_verse: 17,
                    },
                    verses: ClubVerseLists {
                        club150: vec![16],
                        club300: vec![17],
                    },
                }],
                passage: None,
                verses: None,
                is_review: false,
            }],
            meets: vec![],
        }
    }

    /// Helper: unwrap the verse_id of the first chosen anchor card.
    fn batch_verse_ids(engine: &ReviewEngine, batch: Vec<CardId>) -> Vec<u32> {
        batch
            .into_iter()
            .map(|id| engine.card(id).unwrap().verse_id)
            .collect()
    }

    #[test]
    fn batch_no_schedule_sequential_matches_legacy_next_memorize_card() {
        // Default config = Club 150 only, Sequential. Without a schedule,
        // Phase 1 contributes nothing → Phase 2 picks the first Club 150
        // verse in canonical order. The single-card wrapper must agree.
        let m = sample_material_mixed_tiers();
        let r = crate::builder::build_with_config(&m, &MaterialConfig::all_clubs_enabled(0.9), 0);
        let engine = ReviewEngine::new(r, 0.9);
        let batch = next_memorize_batch(&engine, None, 0, 1);
        assert_eq!(batch.len(), 1);
        // Anchor must match the legacy single-card surface verbatim.
        assert_eq!(Some(batch[0]), next_memorize_card(&engine, 0));
    }

    #[test]
    fn batch_two_sequential_clubs_canonical_order() {
        // 150 + 300 enabled, gate Always → both pools eligible. Canonical
        // (verse_id) order means verse 16 (Club150, id 0) comes before
        // verse 17 (Club300, id 1).
        let m = sample_material_mixed_tiers();
        let r = crate::builder::build_with_config(&m, &MaterialConfig::all_clubs_enabled(0.9), 0);
        let mut engine = ReviewEngine::new(r, 0.9);
        engine.material_config.move_to_next = MoveToNextConfig {
            p150_to_300: MoveToNextGate::Always,
            p300_to_full: MoveToNextGate::Always,
        };
        let batch = next_memorize_batch(&engine, None, 0, 2);
        let verse_ids = batch_verse_ids(&engine, batch);
        assert_eq!(verse_ids, vec![0, 1]);
    }

    #[test]
    fn batch_strict_drain_keeps_lower_club_off() {
        // Gate FullyMemorized on 150 → 300: Club 300 stays ineligible
        // until every Club 150 verse is memorized. With batch_size=2
        // we still get only verse 16 (Club 150) since 17 is Club 300.
        let m = sample_material_mixed_tiers();
        let r = crate::builder::build_with_config(&m, &MaterialConfig::all_clubs_enabled(0.9), 0);
        let mut engine = ReviewEngine::new(r, 0.9);
        engine.material_config.move_to_next = MoveToNextConfig {
            p150_to_300: MoveToNextGate::FullyMemorized,
            p300_to_full: MoveToNextGate::Always,
        };
        let batch = next_memorize_batch(&engine, None, 0, 2);
        let verse_ids = batch_verse_ids(&engine, batch);
        assert_eq!(verse_ids, vec![0]);
        // After Club 150 is fully graduated, gate opens.
        engine.graduate_verse(0);
        let batch_after = next_memorize_batch(&engine, None, 0, 2);
        let verse_ids_after = batch_verse_ids(&engine, batch_after);
        assert_eq!(verse_ids_after, vec![1]);
    }

    #[test]
    fn batch_calendar_cascade_picks_this_week_first() {
        // Two-verse deck with one Club150 (verse 16) and one Club300
        // (verse 17). Schedule's week 0 covers John 3:16-17, lists 16 as
        // Club150 and 17 as Club300. With Club 150 in CalendarCascade
        // and gate Always → Phase 1 takes verse 16, Phase 2 takes
        // verse 17 (eligible via Always). With batch_size=1, only
        // verse 16 appears.
        let m = sample_material_mixed_tiers();
        let r = crate::builder::build_with_config(&m, &MaterialConfig::all_clubs_enabled(0.9), 0);
        let mut engine = ReviewEngine::new(r, 0.9);
        engine.material_config.memorize = crate::material_config::ClubMemorizeMap {
            club150: ClubMemorizeConfig {
                enabled: true,
                catch_up: CatchUp::CalendarCascade,
            },
            club300: ClubMemorizeConfig {
                enabled: true,
                catch_up: CatchUp::Sequential,
            },
            full: ClubMemorizeConfig::default(),
        };
        engine.material_config.move_to_next = MoveToNextConfig {
            p150_to_300: MoveToNextGate::Always,
            p300_to_full: MoveToNextGate::Always,
        };
        let sched = make_two_club_schedule();
        // ts=2025-09-08 (week 0's date) — converted to unix secs.
        let now = crate::schedule_data::parse_iso_date("2025-09-08").unwrap() * 86400;
        let batch = next_memorize_batch(&engine, Some(&sched), now, 1);
        let verse_ids = batch_verse_ids(&engine, batch);
        // Phase 1 contributes verse 16 (Club150 this-week). Soft cap on
        // primary keeps it, even though batch_size=1.
        assert_eq!(verse_ids, vec![0]);
    }

    #[test]
    fn batch_calendar_cascade_soft_cap_overflows_phase1() {
        // Both verses are Club150 this week, CalendarCascade. batch_size=1
        // but Phase 1's primary pool has 2 verses → soft cap pulls both in.
        let m = sample_material_two_verses(); // both verses → Full (clubs:[])
        let mut config = MaterialConfig::all_clubs_enabled(0.9);
        // Force everything to Full club to match the fixture verses.
        config.memorize.full = ClubMemorizeConfig {
            enabled: true,
            catch_up: CatchUp::CalendarCascade,
        };
        config.memorize.club150 = ClubMemorizeConfig::default();
        config.memorize.club300 = ClubMemorizeConfig::default();
        let r = crate::builder::build_with_config(&m, &config, 0);
        let engine = ReviewEngine::new(r, 0.9);

        // Schedule: week 0 covers John 3:16-17, no explicit 150/300 lists
        // (both empty) → Full derives both verses.
        let sched = Schedule {
            version: 1,
            material_id: "t".into(),
            season: "x".into(),
            title: "t".into(),
            meeting_day_of_week: "Mon".into(),
            weeks: vec![ScheduleWeek {
                date: "2025-09-08".into(),
                blocks: vec![PassageBlock {
                    passage: Passage {
                        book: "John".into(),
                        chapter: 3,
                        start_verse: 16,
                        end_verse: 17,
                    },
                    verses: ClubVerseLists {
                        club150: vec![],
                        club300: vec![],
                    },
                }],
                passage: None,
                verses: None,
                is_review: false,
            }],
            meets: vec![],
        };

        let now = crate::schedule_data::parse_iso_date("2025-09-08").unwrap() * 86400;
        let batch = next_memorize_batch(&engine, Some(&sched), now, 1);
        let verse_ids = batch_verse_ids(&engine, batch);
        // Soft cap on Phase 1: both Full verses surface even though
        // batch_size=1.
        assert_eq!(verse_ids.len(), 2);
        assert_eq!(verse_ids, vec![0, 1]);
    }

    #[test]
    fn batch_cascade_falls_through_to_lookahead_in_phase2() {
        // Schedule has two weeks; we're at week 0. CalendarCascade picks
        // week 0's verse for Phase 1 (verse 16); Phase 2 has room for
        // verse 17 (week 1's Club150 lookahead).
        let m = sample_material_two_verses();
        let mut config = MaterialConfig::all_clubs_enabled(0.9);
        // Force Full so both verses are eligible.
        config.memorize.full = ClubMemorizeConfig {
            enabled: true,
            catch_up: CatchUp::CalendarCascade,
        };
        config.memorize.club150 = ClubMemorizeConfig::default();
        config.memorize.club300 = ClubMemorizeConfig::default();
        let r = crate::builder::build_with_config(&m, &config, 0);
        let engine = ReviewEngine::new(r, 0.9);

        let mk_week = |date: &str, start: u16, end: u16| ScheduleWeek {
            date: date.into(),
            blocks: vec![PassageBlock {
                passage: Passage {
                    book: "John".into(),
                    chapter: 3,
                    start_verse: start,
                    end_verse: end,
                },
                verses: ClubVerseLists {
                    club150: vec![],
                    club300: vec![],
                },
            }],
            passage: None,
            verses: None,
            is_review: false,
        };
        let sched = Schedule {
            version: 1,
            material_id: "t".into(),
            season: "x".into(),
            title: "t".into(),
            meeting_day_of_week: "Mon".into(),
            weeks: vec![mk_week("2025-09-08", 16, 16), mk_week("2025-09-15", 17, 17)],
            meets: vec![],
        };
        let now = crate::schedule_data::parse_iso_date("2025-09-08").unwrap() * 86400;
        let batch = next_memorize_batch(&engine, Some(&sched), now, 5);
        let verse_ids = batch_verse_ids(&engine, batch);
        // Phase 1 takes verse 16 (this week's Full); Phase 2 picks up
        // verse 17 (next week's lookahead, in canonical order).
        assert_eq!(verse_ids, vec![0, 1]);
    }

    #[test]
    fn caught_up_gate_opens_at_season_start_without_schedule() {
        // Gate = CaughtUp + no schedule → next club is eligible. Avoids
        // the degenerate case where a configured gate permanently
        // suppresses the lower club for users with no schedule.
        let m = sample_material_mixed_tiers();
        let r = crate::builder::build_with_config(&m, &MaterialConfig::all_clubs_enabled(0.9), 0);
        let mut engine = ReviewEngine::new(r, 0.9);
        engine.material_config.move_to_next = MoveToNextConfig {
            p150_to_300: MoveToNextGate::CaughtUp,
            p300_to_full: MoveToNextGate::CaughtUp,
        };
        let batch = next_memorize_batch(&engine, None, 0, 2);
        let verse_ids = batch_verse_ids(&engine, batch);
        assert_eq!(verse_ids, vec![0, 1]);
    }

    #[test]
    fn batch_empty_when_nothing_eligible() {
        // All clubs disabled → batch is empty (matches Phase 2's
        // empty-eligible early return).
        let m = sample_material_mixed_tiers();
        let r = crate::builder::build_with_config(&m, &MaterialConfig::all_clubs_enabled(0.9), 0);
        let mut engine = ReviewEngine::new(r, 0.9);
        engine.material_config = MaterialConfig::from_scopes(TierScope::Off, TierScope::Off);
        let batch = next_memorize_batch(&engine, None, 0, 5);
        assert!(batch.is_empty());
    }

    #[test]
    fn anchor_card_prefers_recitation_over_phrase_fill() {
        let m = sample_material_one_verse();
        let r = crate::builder::build(&m, 0);
        let engine = ReviewEngine::new(r, 0.9);
        let anchor = anchor_card_for_verse(&engine, 0).expect("anchor for verse 0");
        let card = engine.card(anchor).unwrap();
        assert!(matches!(card.kind, CardKind::Recitation));
    }

    #[test]
    fn anchor_card_falls_back_to_phrase_fill_when_recitation_active() {
        let m = sample_material_one_verse();
        let r = crate::builder::build(&m, 0);
        let mut engine = ReviewEngine::new(r, 0.9);
        // Graduate the verse → Recitation flips to Active. anchor_for_verse
        // returns None (no New bulk_graduable card left).
        engine.graduate_verse(0);
        assert!(anchor_card_for_verse(&engine, 0).is_none());
    }
}
