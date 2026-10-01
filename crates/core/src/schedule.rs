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
    ///
    /// Resolves `card_id` by scan; callers already iterating `cards` should
    /// use [`is_card_in_cooldown`](Self::is_card_in_cooldown) to skip the
    /// re-lookup.
    pub fn is_in_cooldown(&self, card_id: CardId, now_secs: i64) -> bool {
        self.card(card_id)
            .is_some_and(|c| self.is_card_in_cooldown(c, now_secs))
    }

    /// [`is_in_cooldown`](Self::is_in_cooldown) for a card ref already in
    /// hand — no `card_id` scan. Cooldown holds while any of the card's
    /// tests is still within the sibling-cooldown window (i.e. not yet cold).
    pub fn is_card_in_cooldown(&self, card: &Card, now_secs: i64) -> bool {
        let atoms = self.atoms_for(card.verse_id);
        let cd = self.schedule_params.sibling_cooldown_secs;
        card.tests(&atoms)
            .iter()
            .any(|tk| self.tests.get(tk).is_some_and(|s| !s.is_cold(now_secs, cd)))
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

/// The cards the review queue is willing to serve at `now_secs`, each paired
/// with its weakest test's retrievability: `Active`, out of sibling cooldown,
/// and below the verse's target retention. The single source of "eligible to
/// review" — `next_card` picks the highest-R of these, and the due counts
/// tally them, so badge and session can't disagree (#107 C).
fn eligible_due_cards(engine: &ReviewEngine, now_secs: i64) -> impl Iterator<Item = (&Card, f32)> {
    engine
        .cards
        .iter()
        .filter(move |c| matches!(c.state, CardState::Active))
        .filter(move |c| !engine.is_card_in_cooldown(c, now_secs))
        .filter_map(move |c| Some((c, engine.card_min_r(c, now_secs)?)))
        .filter(move |(c, r)| *r < engine.target_r_for_verse(c.verse_id))
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
    eligible_due_cards(engine, now_secs)
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

/// Count distinct verses with at least one due card — the review-queue's
/// verse footprint. Shares `eligible_due_cards` with `next_card`/
/// `due_review_count` (#107 C) and keeps only the verse-content cards, the
/// same filter as `new_verse_count`.
pub fn due_verse_count(engine: &ReviewEngine, now_secs: i64) -> u32 {
    eligible_due_cards(engine, now_secs)
        .filter(|(c, _)| is_verse_content_card(&c.kind))
        .map(|(c, _)| c.verse_id)
        .collect::<HashSet<u32>>()
        .len() as u32
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
/// Counts `eligible_due_cards`, so it mirrors `next_card`'s eligibility
/// exactly — sibling cooldown included (#107 C). The count used to drop the
/// cooldown filter so it wouldn't wobble in the seconds after a review — but
/// that let the badge advertise reviews `next_card` refuses to serve ("35 to
/// review" → "session complete"). The wobble is honest: the user just
/// reviewed overlapping material, so "waiting" dropping is accurate, and the
/// number recovers when the cooldown lapses.
pub fn due_review_count(engine: &ReviewEngine, now_secs: i64) -> u32 {
    eligible_due_cards(engine, now_secs).count() as u32
}

/// Pick the next card from the memorize queue: any `New` card. Returns one
/// canonical card per call; the caller is expected to walk the per-verse
/// progression client-side (see [`crate::session::Session::new_verse_progression`])
/// and then graduate the verse via [`ReviewEngine::graduate_verse`].
///
/// Cooldown and FSRS due time don't apply — `New` cards have never been
/// reviewed. Ties broken by ascending verse id (the batch fill sorts
/// picked verses), so the memorize queue surfaces early verses first.
pub fn next_memorize_card(engine: &ReviewEngine, now_secs: i64) -> Option<CardId> {
    // Thin wrapper around the two-phase batch; the existing single-card
    // surface is preserved for callers (the wasm `next_memorize_card`
    // binding, schedule tests) that don't have or need a schedule.
    next_memorize_batch(engine, None, now_secs, 1)
        .first()
        .copied()
}

/// Build the next `batch_size` memorize cards, owed verses first.
///
/// Owed verses are those [`place_unmemorized`] places as owed, the same
/// set [`memorize_debt`] counts; with no schedule the whole pool stands in
/// for them. They come in [`club_ranks`] order, so a club behind an unmet
/// cross-club gate follows the club above it rather than being hidden,
/// and in deck (verse id) order within a rank. Whatever is left of the
/// batch is filled from the remaining un-memorized verses in deck order.
///
/// Calendar cascade still runs its own first phase: a rank-0 club on
/// `CalendarCascade` puts this week's verses ahead of everything, and
/// that phase may overflow `batch_size`.
///
/// Returns one anchor `CardId` per chosen verse — `Recitation` if the
/// verse emits one, otherwise the first un-graduated bulk-graduable
/// card for that verse (typically `PhraseFill { 0 }`).
pub fn next_memorize_batch(
    engine: &ReviewEngine,
    schedule: Option<&Schedule>,
    now_secs: i64,
    batch_size: u8,
) -> Vec<CardId> {
    let placed = place_unmemorized(engine, schedule, now_secs);
    let ranks = club_ranks(engine, schedule, now_secs);
    // Every placed verse belongs to an enabled club, and every enabled
    // club has a rank.
    let rank_of = |club: ClubTier| {
        ranks
            .iter()
            .find(|(c, _)| *c == club)
            .map_or(u32::MAX, |&(_, rank)| rank)
    };
    let mut picked: Vec<u32> = Vec::new();
    let mut seen: HashSet<u32> = HashSet::new();

    // Calendar cascade's this-week phase, for rank-0 clubs only, as the
    // gates used to admit. The (book, chapter, verse) → verse_id lookup is
    // an O(verses) HashMap with owned String keys, so it is only built
    // when some club is on CalendarCascade.
    let cascade: Vec<ClubTier> = ranks
        .iter()
        .filter(|&&(club, rank)| {
            rank == 0 && engine.material_config.catch_up_for(club) == CatchUp::CalendarCascade
        })
        .map(|&(club, _)| club)
        .collect();
    if !cascade.is_empty()
        && let Some(sched) = schedule
        && let Some(week_idx) = sched.current_week_index(now_secs)
    {
        let lookup = build_verse_lookup(engine);
        let mut this_week: Vec<u32> = Vec::new();
        for &club in &cascade {
            for vref in sched.week_verse_refs(week_idx, club) {
                let Some(&vid) = lookup.get(&vref) else {
                    continue;
                };
                let unmemorized = placed
                    .binary_search_by_key(&vid, |p| p.verse_id)
                    .is_ok_and(|i| placed[i].club == club);
                if unmemorized && seen.insert(vid) {
                    this_week.push(vid);
                }
            }
        }
        this_week.sort_unstable();
        picked.extend(this_week);
    }

    let owes = |p: &&PlacedVerse| match p.placement {
        Placement::Owed => true,
        Placement::Unscheduled => schedule.is_none(),
        Placement::Ahead => false,
    };
    let mut owed: Vec<&PlacedVerse> = placed.iter().filter(owes).collect();
    owed.sort_unstable_by_key(|p| (rank_of(p.club), p.verse_id));
    let rest = placed.iter().filter(|p| !owes(p));
    for p in owed.into_iter().chain(rest) {
        if picked.len() >= usize::from(batch_size) {
            break;
        }
        if seen.insert(p.verse_id) {
            picked.push(p.verse_id);
        }
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

/// How much memorizing the schedule still expects, as of `now_secs`.
///
/// `verses` counts un-memorized verses the schedule introduced in weeks
/// `0..=current_week` for every club with memorize enabled; `cards` counts
/// the `New` cards those verses carry. Dashboards pair the two ("N
/// fresh cards from M verses").
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize)]
pub struct MemorizeDebt {
    pub verses: u32,
    pub cards: u32,
}

/// Un-memorized work the schedule has already asked for: the verses
/// [`place_unmemorized`] places as owed, which is the whole backlog
/// through this week, not just this week's row, so a learner who skipped
/// a fortnight sees the debt rather than a flat weekly quota.
///
/// Before the season's first week nothing is owed, so the debt is zero.
/// With no schedule there is no calendar to bound the work, and every
/// un-memorized verse in the counted clubs stands in for the owed verses.
///
/// Counts every club with memorize enabled, per the badge spec's
/// "Σ over enabled clubs". The `move_to_next` gates are deliberately not
/// applied: they decide which club [`next_memorize_batch`] serves from
/// next, not what the schedule has asked for, so a learner behind on
/// Club 300 still owes this week's Full verses. Applying them would make
/// falling behind shrink the count.
///
/// Zero debt does not mean an empty memorize queue: a learner on plan can
/// still work ahead into weeks that haven't started. Callers rendering
/// the zero state must say so.
pub fn memorize_debt(
    engine: &ReviewEngine,
    schedule: Option<&Schedule>,
    now_secs: i64,
) -> MemorizeDebt {
    let verses: HashSet<u32> = place_unmemorized(engine, schedule, now_secs)
        .into_iter()
        .filter(|p| match p.placement {
            Placement::Owed => true,
            Placement::Unscheduled => schedule.is_none(),
            Placement::Ahead => false,
        })
        .map(|p| p.verse_id)
        .collect();

    let cards = engine
        .cards
        .iter()
        .filter(|c| matches!(c.state, CardState::New) && verses.contains(&c.verse_id))
        .count();
    MemorizeDebt {
        verses: verses.len() as u32,
        cards: cards as u32,
    }
}

/// Where an un-memorized verse stands against the schedule
/// (specs/003-memorize-by-schedule/data-model.md).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Placement {
    /// First assigned in a week that has started.
    Owed,
    /// First assigned in a week that hasn't started yet.
    Ahead,
    /// No week assigns it under an enabled club, or there is no schedule.
    Unscheduled,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct PlacedVerse {
    verse_id: u32,
    /// The verse's own club, the one whose memorize setting admits it.
    club: ClubTier,
    placement: Placement,
}

/// Place every un-memorized verse of a club with memorize enabled, in
/// verse-id order. The one definition of "owed" that the count and the
/// queue both read, so they can't disagree about it.
///
/// A week assigns a verse when its row lists it under any enabled club,
/// Full's derived range included. A verse the schedule files under a
/// different club than its deck tag therefore still places: on the John
/// printable, 1:17-18 are tagged Club 150 but week 0 leaves them to Full.
/// The first week to assign a verse wins, so one a schedule lists twice
/// lands in a single bucket. Whether earliest-wins is right for verses a
/// printed row moves to another week is an open question, recorded in
/// `docs/memorize.md`.
fn place_unmemorized(
    engine: &ReviewEngine,
    schedule: Option<&Schedule>,
    now_secs: i64,
) -> Vec<PlacedVerse> {
    let enabled: Vec<ClubTier> = ClubTier::ALL
        .into_iter()
        .filter(|&club| engine.material_config.memorize_enabled_for(club))
        .collect();
    let unmemorized = unmemorized_verses_by_tier(engine, &enabled);

    // Keyed on the schedule's own strings rather than `build_verse_lookup`,
    // which clones a book name per verse in the whole deck: `memorize_debt`
    // runs on every `/api/years` request.
    let mut first_week: HashMap<(&str, u16, u16), usize> = HashMap::new();
    if let Some(sched) = schedule {
        for &club in &enabled {
            sched.for_each_ref(club, |week, book, chapter, verse| {
                first_week
                    .entry((book, chapter, verse))
                    .and_modify(|w| *w = (*w).min(week))
                    .or_insert(week);
            });
        }
    }
    let current_week = schedule.and_then(|s| s.current_week_index(now_secs));

    let mut placed: Vec<PlacedVerse> = unmemorized
        .iter()
        .flat_map(|(&club, verses)| verses.iter().map(move |&verse_id| (club, verse_id)))
        .map(|(club, verse_id)| {
            let week = engine.verse_render(verse_id).and_then(|r| {
                first_week
                    .get(&(r.book.as_str(), r.chapter, r.verse))
                    .copied()
            });
            let placement = match week {
                None => Placement::Unscheduled,
                Some(week) if current_week.is_some_and(|current| week <= current) => {
                    Placement::Owed
                }
                Some(_) => Placement::Ahead,
            };
            PlacedVerse {
                verse_id,
                club,
                placement,
            }
        })
        .collect();
    placed.sort_unstable_by_key(|p| p.verse_id);
    placed
}

/// Each enabled club with its rank: the number of unmet cross-club gates
/// on the chain from the top enabled club down to it. The queue serves
/// lower ranks first, so a gate decides which club to focus on and never
/// hides a club's verses (FR-006).
///
/// Clubs come in [`ClubTier::ALL`] order, and each gate is read against
/// the nearest enabled club above. A skip-club layout (Club 150 and Full
/// enabled, Club 300 off) uses `move_to_next.p300_to_full` against Club
/// 150: adjacent-pair gates don't compose across skips, by design.
fn club_ranks(
    engine: &ReviewEngine,
    schedule: Option<&Schedule>,
    now_secs: i64,
) -> Vec<(ClubTier, u32)> {
    let config = &engine.material_config;
    let mut ranks: Vec<(ClubTier, u32)> = Vec::new();
    for club in ClubTier::ALL {
        if !config.memorize_enabled_for(club) {
            continue;
        }
        let rank = match ranks.last() {
            None => 0,
            Some(&(higher, higher_rank)) => {
                // `gate_to(Club150)` is the only `None` case, and Club150
                // is always the top enabled club when enabled. Any future
                // tier added between Club150 and Club300 would need a gate
                // entry in `MaterialConfig`; the expect catches the
                // omission instead of silently falling through to `Always`.
                let gate = config
                    .gate_to(club)
                    .expect("gate_to is Some for every non-top tier");
                let open = gate_is_open(engine, schedule, higher, gate, now_secs);
                higher_rank + u32::from(!open)
            }
        };
        ranks.push((club, rank));
    }
    ranks
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
/// time has elapsed AND whose own last touch is past the sibling cooldown.
///
/// The per-test coldness gate replaces the lane's old card-level cooldown
/// bypass (#107): a just-lapsed test (graded seconds ago) re-serving its
/// card teaches nothing — the learner just saw the answer. Gating on the
/// *test's* `last_seen_secs` still lets a cold lapse surface even when a
/// sibling card has the whole card in `is_in_cooldown` via some other
/// shared test.
///
/// Returns `None` when no lane card is due. Ties broken by earliest due time
/// (the lapse a learner has been kept waiting longest gets cleared first).
pub fn next_relearn_card(engine: &ReviewEngine, now_secs: i64) -> Option<CardId> {
    let cd = engine.schedule_params.sibling_cooldown_secs;
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
                    if !state.is_cold(now_secs, cd) {
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
    fn relearn_lane_serves_lapsed_card_masked_by_shared_test_touch() {
        // Lapse Recitation yesterday; a Citation review a minute ago
        // freshens the shared citation test, putting Recitation in
        // card-level cooldown. The lane's per-test gate must still surface
        // the lapse: its phrase tests are pending, cold, and past due.
        let m = sample_material_one_verse();
        let r = crate::builder::build(&m, 0);
        let mut engine = ReviewEngine::new(r, 0.9);
        engine.graduate_all();
        let now = 86400 * 365;
        let recit_id = engine
            .cards
            .iter()
            .find(|c| matches!(c.kind, CardKind::Recitation))
            .unwrap()
            .id;
        engine.review(recit_id, Grade::Again, now);
        let later = now + 86400;
        let cit_test = engine
            .cards
            .iter()
            .find(|c| matches!(c.kind, CardKind::Citation))
            .map(|c| c.tests(&engine.atoms_for(0))[0])
            .unwrap();
        let cit_state = engine.tests.get_mut(&cit_test).unwrap();
        cit_state.last_seen_secs = later - 60;
        cit_state.pending_relearn = false;
        assert!(engine.is_in_cooldown(recit_id, later));
        let picked = next_relearn_card(&engine, later).expect("lane must serve the cold lapse");
        assert_eq!(engine.card(picked).unwrap().verse_id, 0);
    }

    #[test]
    fn relearn_lane_masks_just_lapsed_card_until_cooldown() {
        // #107 A/B: grading Again advances last_seen on every marked test,
        // so immediately re-serving the same content teaches nothing ("I
        // just saw it so I know it"). The lane must wait out the sibling
        // cooldown before re-serving a just-lapsed card or its siblings.
        let m = sample_material_one_verse();
        let r = crate::builder::build(&m, 0);
        let mut engine = ReviewEngine::new(r, 0.9);
        engine.graduate_all();
        let now = 86400 * 365;
        let recit_id = engine
            .cards
            .iter()
            .find(|c| matches!(c.kind, CardKind::Recitation))
            .unwrap()
            .id;
        engine.review(recit_id, Grade::Again, now);
        assert_eq!(next_relearn_card(&engine, now + 60), None);
        // Once cold (and past the FSRS sub-day due), the lapse re-surfaces.
        assert!(next_relearn_card(&engine, now + 86400).is_some());
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
    fn due_counts_exclude_cards_in_cooldown() {
        // #107 C: badge and session must agree. Build the split's
        // real-world shape — a composite card due via a stale test whose
        // atomic owners aren't Active, masked via fresh sibling tests:
        // Recitation stays the only Active card, its citation test stays
        // stale (due) while every other test was touched a minute ago
        // (cooldown). Badge and session must both read "nothing now".
        let m = sample_material_one_verse();
        let r = crate::builder::build(&m, 0);
        let mut engine = ReviewEngine::new(r, 0.9);
        engine.graduate_all();
        let t = 86400 * 365;
        let cit_test = engine
            .cards
            .iter()
            .find(|c| matches!(c.kind, CardKind::Citation))
            .map(|c| c.tests(&engine.atoms_for(0))[0])
            .unwrap();
        let recit_id = engine
            .cards
            .iter()
            .find(|c| matches!(c.kind, CardKind::Recitation))
            .unwrap()
            .id;
        for card in engine.cards.iter_mut() {
            if card.id != recit_id {
                card.state = CardState::New;
            }
        }
        for (key, state) in engine.tests.iter_mut() {
            if *key != cit_test {
                state.last_seen_secs = t - 60;
            }
        }
        assert!(engine.is_in_cooldown(recit_id, t));
        assert!(next_card(&engine, t).is_none());
        assert_eq!(due_review_count(&engine, t), 0);
        assert_eq!(due_verse_count(&engine, t), 0);
        // Cooldown expiry: badge and session flip together.
        let after = t + engine.schedule_params.sibling_cooldown_secs;
        assert_eq!(next_card(&engine, after), Some(recit_id));
        assert_eq!(due_review_count(&engine, after), 1);
        assert_eq!(due_verse_count(&engine, after), 1);
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
    fn batch_strict_drain_puts_lower_club_after_higher() {
        // Gate FullyMemorized on 150 → 300 ranks Club 300 behind Club 150
        // until Club 150 is fully memorized, but no longer hides it.
        let m = sample_material_mixed_tiers();
        let r = crate::builder::build_with_config(&m, &MaterialConfig::all_clubs_enabled(0.9), 0);
        let mut engine = ReviewEngine::new(r, 0.9);
        engine.material_config.move_to_next = MoveToNextConfig {
            p150_to_300: MoveToNextGate::FullyMemorized,
            p300_to_full: MoveToNextGate::Always,
        };
        let batch = next_memorize_batch(&engine, None, 0, 1);
        assert_eq!(batch_verse_ids(&engine, batch), vec![0]);
        let batch = next_memorize_batch(&engine, None, 0, 2);
        assert_eq!(batch_verse_ids(&engine, batch), vec![0, 1]);
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
        let now = day_secs("2025-09-08");
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
                is_review: false,
            }],
            meets: vec![],
        };

        let now = day_secs("2025-09-08");
        let batch = next_memorize_batch(&engine, Some(&sched), now, 1);
        let verse_ids = batch_verse_ids(&engine, batch);
        // Soft cap on Phase 1: both Full verses surface even though
        // batch_size=1.
        assert_eq!(verse_ids.len(), 2);
        assert_eq!(verse_ids, vec![0, 1]);
    }

    /// John 3:16 in week 0, 3:17 in week 1 — the two verses
    /// `sample_material_two_verses` builds, one per week, with no club
    /// lists so both land in the Full tier.
    fn two_week_john_schedule() -> Schedule {
        let mk_week = |date: &str, verse: u16| ScheduleWeek {
            date: date.into(),
            blocks: vec![PassageBlock {
                passage: Passage {
                    book: "John".into(),
                    chapter: 3,
                    start_verse: verse,
                    end_verse: verse,
                },
                verses: ClubVerseLists {
                    club150: vec![],
                    club300: vec![],
                },
            }],
            is_review: false,
        };
        Schedule {
            version: 1,
            material_id: "t".into(),
            season: "x".into(),
            title: "t".into(),
            meeting_day_of_week: "Mon".into(),
            weeks: vec![mk_week("2025-09-08", 16), mk_week("2025-09-15", 17)],
            meets: vec![],
        }
    }

    /// Engine over that deck with every club enabled, paired with the
    /// schedule. `all_clubs_enabled` already puts the Full tier on
    /// Sequential, which is all `memorize_debt` needs — it ignores
    /// `catch_up` entirely, unlike `next_memorize_batch`.
    fn debt_fixture() -> (ReviewEngine, Schedule) {
        let m = sample_material_two_verses();
        let r = crate::builder::build_with_config(&m, &MaterialConfig::all_clubs_enabled(0.9), 0);
        (ReviewEngine::new(r, 0.9), two_week_john_schedule())
    }

    fn day_secs(iso: &str) -> i64 {
        crate::schedule_data::parse_iso_date(iso).unwrap() * 86400
    }

    #[test]
    fn memorize_debt_stops_at_the_current_week() {
        let (engine, sched) = debt_fixture();
        let debt = memorize_debt(&engine, Some(&sched), day_secs("2025-09-08"));
        // Week 1's verse 17 is lookahead, not debt.
        assert_eq!(debt.verses, 1);
        // Every New card on John 3:16: two PhraseFills, Recitation,
        // Citation, VerseAtVerseRef, VerseInBook, VerseInChapter. The
        // count pairs with `verses` in the dashboards' "N cards from M
        // verses", so it counts the whole card fan-out, not just the
        // bulk-graduable anchors.
        assert_eq!(debt.cards, 7);

        let later = memorize_debt(&engine, Some(&sched), day_secs("2025-09-15"));
        assert_eq!(later.verses, 2);
    }

    #[test]
    fn memorize_debt_counts_verses_the_schedule_files_under_another_tier() {
        // Deck tags verse 16 Club150 and verse 17 Club300, but the week's
        // row lists neither, so the schedule introduces both through Full's
        // derived range. This is the John printable's shape — 1:17-18 are
        // Club 150 verses the week-0 row leaves to Full — and pairing each
        // pool with only its own tier's refs would count zero.
        let m = sample_material_mixed_tiers();
        let r = crate::builder::build_with_config(&m, &MaterialConfig::all_clubs_enabled(0.9), 0);
        let mut engine = ReviewEngine::new(r, 0.9);
        engine.material_config.move_to_next = MoveToNextConfig {
            p150_to_300: MoveToNextGate::Always,
            p300_to_full: MoveToNextGate::Always,
        };
        let sched = Schedule {
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
                is_review: false,
            }],
            ..two_week_john_schedule()
        };
        let debt = memorize_debt(&engine, Some(&sched), day_secs("2025-09-08"));
        assert_eq!(debt.verses, 2);
    }

    #[test]
    fn memorize_debt_counts_every_enabled_club_whatever_the_gates() {
        // The gates decide what the queue serves next, not what the
        // schedule has asked for. A learner behind on Club 150 still owes
        // this week's Club 300 verse; only switching a club's memorize
        // off takes its verses out of the count.
        let m = sample_material_mixed_tiers();
        let r = crate::builder::build_with_config(&m, &MaterialConfig::all_clubs_enabled(0.9), 0);
        let mut engine = ReviewEngine::new(r, 0.9);
        engine.material_config.move_to_next = MoveToNextConfig {
            p150_to_300: MoveToNextGate::FullyMemorized,
            p300_to_full: MoveToNextGate::FullyMemorized,
        };
        let sched = Schedule {
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
                is_review: false,
            }],
            ..two_week_john_schedule()
        };
        let now = day_secs("2025-09-08");
        // Club 150 is not fully memorized, so the gate ranks Club 300 and
        // Full behind it in the queue, but their verses are still owed.
        assert_eq!(
            club_ranks(&engine, Some(&sched), now),
            vec![
                (ClubTier::Club150, 0),
                (ClubTier::Club300, 1),
                (ClubTier::Full, 2)
            ]
        );
        let owed = memorize_debt(&engine, Some(&sched), now);
        assert_eq!(owed.verses, 2);

        engine.material_config.memorize.club300.enabled = false;
        let without_300 = memorize_debt(&engine, Some(&sched), now);
        assert_eq!(without_300.verses, 1);
        // Cards follow verses: the Club 300 verse's cards leave with it.
        assert!(without_300.cards > 0 && without_300.cards < owed.cards);
    }

    #[test]
    fn memorize_debt_drops_memorized_verses() {
        let (mut engine, sched) = debt_fixture();
        engine.graduate_verse(0);
        let debt = memorize_debt(&engine, Some(&sched), day_secs("2025-09-15"));
        assert_eq!(debt.verses, 1);
    }

    #[test]
    fn memorize_debt_counts_the_whole_pool_without_a_schedule() {
        // With no calendar to bound the work, every un-memorized verse in
        // the enabled clubs stands in for the owed verses (FR-010).
        let (engine, _) = debt_fixture();
        assert_eq!(memorize_debt(&engine, None, 0).verses, 2);
    }

    #[test]
    fn memorize_debt_is_zero_before_the_season() {
        // Nothing has been asked for yet; the queue works ahead from the
        // first week instead (FR-011).
        let (engine, sched) = debt_fixture();
        let debt = memorize_debt(&engine, Some(&sched), day_secs("2025-09-01"));
        assert_eq!(debt, MemorizeDebt::default());
    }

    // ===== club ranks =====

    fn ranks_with(
        p150_to_300: MoveToNextGate,
        p300_to_full: MoveToNextGate,
    ) -> Vec<(ClubTier, u32)> {
        let m = sample_material_mixed_tiers();
        let r = crate::builder::build_with_config(&m, &MaterialConfig::all_clubs_enabled(0.9), 0);
        let mut engine = ReviewEngine::new(r, 0.9);
        engine.material_config.move_to_next = MoveToNextConfig {
            p150_to_300,
            p300_to_full,
        };
        club_ranks(&engine, None, 0)
    }

    #[test]
    fn club_ranks_are_zero_when_every_gate_is_met() {
        assert_eq!(
            ranks_with(MoveToNextGate::Always, MoveToNextGate::Always),
            vec![
                (ClubTier::Club150, 0),
                (ClubTier::Club300, 0),
                (ClubTier::Full, 0)
            ]
        );
    }

    #[test]
    fn club_ranks_count_unmet_gates_down_the_chain() {
        // Club 150 isn't fully memorized, so Club 300 sits one gate back.
        // Full adds its own gate only when that gate is unmet too.
        assert_eq!(
            ranks_with(MoveToNextGate::FullyMemorized, MoveToNextGate::Always),
            vec![
                (ClubTier::Club150, 0),
                (ClubTier::Club300, 1),
                (ClubTier::Full, 1)
            ]
        );
        assert_eq!(
            ranks_with(
                MoveToNextGate::FullyMemorized,
                MoveToNextGate::FullyMemorized
            ),
            vec![
                (ClubTier::Club150, 0),
                (ClubTier::Club300, 1),
                (ClubTier::Full, 2)
            ]
        );
    }

    #[test]
    fn club_ranks_rank_a_gate_that_can_never_open() {
        // Checkpoint gates without a schedule never open. They still rank
        // the lower club rather than shutting it out.
        assert_eq!(
            ranks_with(
                MoveToNextGate::AfterMajorCheckpoint,
                MoveToNextGate::AfterMinorCheckpoint
            ),
            vec![
                (ClubTier::Club150, 0),
                (ClubTier::Club300, 1),
                (ClubTier::Full, 2)
            ]
        );
    }

    #[test]
    fn club_ranks_leave_out_clubs_with_memorize_off() {
        let m = sample_material_mixed_tiers();
        let r = crate::builder::build_with_config(&m, &MaterialConfig::all_clubs_enabled(0.9), 0);
        let mut engine = ReviewEngine::new(r, 0.9);
        engine.material_config.memorize.club300.enabled = false;
        engine.material_config.move_to_next = MoveToNextConfig {
            p150_to_300: MoveToNextGate::Always,
            p300_to_full: MoveToNextGate::FullyMemorized,
        };
        // Full's gate is read against Club 150, the enabled club above it.
        assert_eq!(
            club_ranks(&engine, None, 0),
            vec![(ClubTier::Club150, 0), (ClubTier::Full, 1)]
        );
    }

    // ===== the owed queue =====

    #[test]
    fn batch_serves_an_owed_verse_before_an_earlier_ahead_one() {
        // Week 0 lists verse 17 and week 1 lists verse 16, so verse 17 is
        // owed while verse 16, first in the deck, is not yet.
        let (engine, _) = debt_fixture();
        let sched = john_schedule(&[("2025-09-08", 17, 17, &[]), ("2025-09-15", 16, 16, &[])]);
        let batch = next_memorize_batch(&engine, Some(&sched), day_secs("2025-09-08"), 1);
        assert_eq!(batch_verse_ids(&engine, batch), vec![1]);
    }

    #[test]
    fn batch_serves_owed_verses_in_deck_order_across_weeks() {
        // Both verses are owed by week 1; deck order, not week order.
        let (engine, _) = debt_fixture();
        let sched = john_schedule(&[("2025-09-08", 17, 17, &[]), ("2025-09-15", 16, 16, &[])]);
        let batch = next_memorize_batch(&engine, Some(&sched), day_secs("2025-09-15"), 2);
        assert_eq!(batch_verse_ids(&engine, batch), vec![0, 1]);
    }

    #[test]
    fn memorizing_served_owed_verses_drops_the_count_by_as_many() {
        let (mut engine, sched) = debt_fixture();
        let now = day_secs("2025-09-15");
        assert_eq!(memorize_debt(&engine, Some(&sched), now).verses, 2);
        for card in next_memorize_batch(&engine, Some(&sched), now, 1) {
            let verse = engine.card(card).unwrap().verse_id;
            engine.graduate_verse(verse);
        }
        assert_eq!(memorize_debt(&engine, Some(&sched), now).verses, 1);
    }

    // ===== placement of un-memorized verses =====

    fn placements(
        engine: &ReviewEngine,
        sched: Option<&Schedule>,
        iso: &str,
    ) -> Vec<(u32, Placement)> {
        place_unmemorized(engine, sched, day_secs(iso))
            .into_iter()
            .map(|p| (p.verse_id, p.placement))
            .collect()
    }

    /// One week per `(date, first verse, last verse, club150 list)` over
    /// John 3, with no Club 300 list.
    fn john_schedule(weeks: &[(&str, u16, u16, &[u16])]) -> Schedule {
        Schedule {
            weeks: weeks
                .iter()
                .map(|&(date, start_verse, end_verse, club150)| ScheduleWeek {
                    date: date.into(),
                    blocks: vec![PassageBlock {
                        passage: Passage {
                            book: "John".into(),
                            chapter: 3,
                            start_verse,
                            end_verse,
                        },
                        verses: ClubVerseLists {
                            club150: club150.to_vec(),
                            club300: vec![],
                        },
                    }],
                    is_review: false,
                })
                .collect(),
            ..two_week_john_schedule()
        }
    }

    #[test]
    fn placement_owes_started_weeks_and_holds_later_ones_ahead() {
        let (engine, sched) = debt_fixture();
        assert_eq!(
            placements(&engine, Some(&sched), "2025-09-08"),
            vec![(0, Placement::Owed), (1, Placement::Ahead)]
        );
        assert_eq!(
            placements(&engine, Some(&sched), "2025-09-15"),
            vec![(0, Placement::Owed), (1, Placement::Owed)]
        );
    }

    #[test]
    fn placement_owes_nothing_before_the_season() {
        let (engine, sched) = debt_fixture();
        assert_eq!(
            placements(&engine, Some(&sched), "2025-09-01"),
            vec![(0, Placement::Ahead), (1, Placement::Ahead)]
        );
    }

    #[test]
    fn placement_owes_every_scheduled_verse_after_the_season() {
        let (engine, sched) = debt_fixture();
        assert_eq!(
            placements(&engine, Some(&sched), "2026-01-05"),
            vec![(0, Placement::Owed), (1, Placement::Owed)]
        );
    }

    #[test]
    fn placement_without_a_schedule_is_unscheduled() {
        let (engine, _) = debt_fixture();
        assert_eq!(
            placements(&engine, None, "2025-09-08"),
            vec![(0, Placement::Unscheduled), (1, Placement::Unscheduled)]
        );
    }

    #[test]
    fn placement_leaves_a_verse_no_week_assigns_unscheduled() {
        let (engine, _) = debt_fixture();
        let sched = john_schedule(&[("2025-09-08", 16, 16, &[])]);
        assert_eq!(
            placements(&engine, Some(&sched), "2025-09-08"),
            vec![(0, Placement::Owed), (1, Placement::Unscheduled)]
        );
    }

    #[test]
    fn placement_takes_the_first_week_that_assigns_a_verse() {
        // Verse 17 is listed in week 0 and again in week 1; it is owed
        // from week 0, not held back to week 1.
        let (engine, _) = debt_fixture();
        let sched = john_schedule(&[("2025-09-08", 17, 17, &[]), ("2025-09-15", 16, 17, &[])]);
        assert_eq!(
            placements(&engine, Some(&sched), "2025-09-08"),
            vec![(0, Placement::Ahead), (1, Placement::Owed)]
        );
    }

    #[test]
    fn placement_counts_an_assignment_under_any_enabled_club() {
        // The row lists verse 17, a Club 300 verse, under Club 150, and
        // leaves verse 16, a Club 150 verse, to Full's derived range. Both
        // are assigned while their own clubs and the listing clubs are on.
        let m = sample_material_mixed_tiers();
        let r = crate::builder::build_with_config(&m, &MaterialConfig::all_clubs_enabled(0.9), 0);
        let mut engine = ReviewEngine::new(r, 0.9);
        let sched = john_schedule(&[("2025-09-08", 16, 17, &[17])]);
        assert_eq!(
            placements(&engine, Some(&sched), "2025-09-08"),
            vec![(0, Placement::Owed), (1, Placement::Owed)]
        );
        // With Club 150 off, verse 16 leaves the pool, and the only listing
        // of verse 17 no longer assigns it.
        engine.material_config.memorize.club150.enabled = false;
        assert_eq!(
            placements(&engine, Some(&sched), "2025-09-08"),
            vec![(1, Placement::Unscheduled)]
        );
    }

    #[test]
    fn placement_skips_memorized_verses() {
        let (mut engine, sched) = debt_fixture();
        engine.graduate_verse(0);
        assert_eq!(
            placements(&engine, Some(&sched), "2025-09-08"),
            vec![(1, Placement::Ahead)]
        );
    }

    #[test]
    fn placement_follows_an_edited_schedule() {
        let (engine, sched) = debt_fixture();
        let edited = john_schedule(&[("2025-09-08", 17, 17, &[]), ("2025-09-15", 16, 16, &[])]);
        assert_eq!(
            placements(&engine, Some(&sched), "2025-09-08"),
            vec![(0, Placement::Owed), (1, Placement::Ahead)]
        );
        assert_eq!(
            placements(&engine, Some(&edited), "2025-09-08"),
            vec![(0, Placement::Ahead), (1, Placement::Owed)]
        );
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

        let sched = two_week_john_schedule();
        let now = day_secs("2025-09-08");
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
    fn batch_empty_when_every_club_is_off() {
        // Gates order clubs and never empty the queue; only switching every
        // club's memorize off leaves nothing to serve.
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
