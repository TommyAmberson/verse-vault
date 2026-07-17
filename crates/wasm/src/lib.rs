//! WASM bindings for the verse-vault HSRS engine. JSON crosses the boundary
//! as strings (debuggable, version-tolerant). The crate compiles as both a
//! `cdylib` (via `wasm-pack`) and an `rlib` so the wire types and helpers
//! can be unit-tested with plain `cargo test`.

use serde::{Deserialize, Serialize};
use wasm_bindgen::prelude::*;

use verse_vault_core::builder::build_with_config;
use verse_vault_core::card::CardKind;
use verse_vault_core::content::{Annotation, AnnotationKind, MaterialData};
use verse_vault_core::element::{ClubTier, ElementId};
use verse_vault_core::engine::{ReviewEngine, TestUpdate, UpdateKind};
use verse_vault_core::material_config::MaterialConfig;
use verse_vault_core::render::{HeadingRender, VerseRender};
use verse_vault_core::schedule::{
    card_stability_histogram as schedule_card_stability_histogram,
    due_review_count as schedule_due_review_count, due_verse_count as schedule_due_verse_count,
    learned_verse_count as schedule_learned_verse_count, new_card_count as schedule_new_card_count,
    new_verse_count as schedule_new_verse_count, next_card,
    next_memorize_card as schedule_next_memorize_card, next_relearn_card,
    verse_stability_histogram as schedule_verse_stability_histogram,
};
use verse_vault_core::test_kind::{TestKey, TestKind};
use verse_vault_core::test_state::TestState;
use verse_vault_core::types::{CardId, Grade};

#[wasm_bindgen(start)]
pub fn init() {
    console_error_panic_hook::set_once();
}

/// JSON-friendly mirror of `(TestKey, TestState)`. The `(test_kind, element)`
/// pair is flattened in so the wire format reads as a list of self-describing
/// records — JS doesn't have to reconstruct a TestKey from nested fields.
#[derive(Serialize, Deserialize, Clone, PartialEq, Debug)]
pub struct TestStateEntry {
    pub element: ElementId,
    pub test_kind: TestKind,
    pub stability: f32,
    pub difficulty: f32,
    pub last_seen_secs: i64,
    pub last_base_secs: i64,
    pub last_root_secs: i64,
    #[serde(default)]
    pub pending_relearn: bool,
}

impl TestStateEntry {
    pub fn from_pair(key: TestKey, state: &TestState) -> Self {
        Self {
            element: key.element,
            test_kind: key.kind,
            stability: state.stability,
            difficulty: state.difficulty,
            last_seen_secs: state.last_seen_secs,
            last_base_secs: state.last_base_secs,
            last_root_secs: state.last_root_secs,
            pending_relearn: state.pending_relearn,
        }
    }

    pub fn into_pair(self) -> (TestKey, TestState) {
        let key = TestKey {
            kind: self.test_kind,
            element: self.element,
        };
        let state = TestState {
            stability: self.stability,
            difficulty: self.difficulty,
            last_seen_secs: self.last_seen_secs,
            last_base_secs: self.last_base_secs,
            last_root_secs: self.last_root_secs,
            pending_relearn: self.pending_relearn,
        };
        (key, state)
    }
}

/// Wire-format mirror of `engine::TestUpdate`. `kind` is serialized as a
/// short string so the JS side doesn't have to parse Rust-style enum tags.
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct TestUpdateWire {
    pub key: TestKey,
    pub kind: UpdateKindWire,
    pub before: TestState,
    pub after: TestState,
}

/// JS-friendly mirror of `card::CardKind`. Serializes with internal `kind`
/// tagging so the JS side gets `{ "kind": "PhraseFill", "position": 1 }`
/// instead of Rust's externally-tagged `{ "PhraseFill": { "position": 1 } }`.
#[derive(Serialize, Clone, Debug)]
#[serde(tag = "kind")]
pub enum CardKindWire {
    PhraseFill {
        position: u16,
    },
    VerseAtVerseRef,
    VerseInChapter,
    VerseInBook,
    VerseInHeading {
        #[serde(rename = "headingIdx")]
        heading_idx: u16,
    },
    VerseInClub {
        tier: ClubTier,
    },
    Recitation,
    Citation,
    Ftv {
        #[serde(rename = "withCitation")]
        with_citation: bool,
    },
    ChapterClubList {
        tier: ClubTier,
    },
    HeadingPassage {
        #[serde(rename = "headingIdx")]
        heading_idx: u16,
    },
    Reading,
}

impl From<CardKind> for CardKindWire {
    fn from(k: CardKind) -> Self {
        match k {
            CardKind::PhraseFill { position } => CardKindWire::PhraseFill { position },
            CardKind::VerseAtVerseRef => CardKindWire::VerseAtVerseRef,
            CardKind::VerseInChapter => CardKindWire::VerseInChapter,
            CardKind::VerseInBook => CardKindWire::VerseInBook,
            CardKind::VerseInHeading { heading_idx } => {
                CardKindWire::VerseInHeading { heading_idx }
            }
            CardKind::VerseInClub { tier } => CardKindWire::VerseInClub { tier },
            CardKind::Recitation => CardKindWire::Recitation,
            CardKind::Citation => CardKindWire::Citation,
            CardKind::Ftv { with_citation } => CardKindWire::Ftv { with_citation },
            CardKind::ChapterClubList { tier } => CardKindWire::ChapterClubList { tier },
            CardKind::HeadingPassage { heading_idx } => {
                CardKindWire::HeadingPassage { heading_idx }
            }
            CardKind::Reading => CardKindWire::Reading,
        }
    }
}

/// JS-friendly mirror of `core::render::HeadingRender`. Carries only the
/// heading-binding identifier and its verse range; the title is resolved
/// server-side against api.bible's sections endpoint.
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct HeadingRenderWire {
    pub heading_idx: u16,
    pub start_chapter: u16,
    pub start_verse: u16,
    pub end_chapter: u16,
    pub end_verse: u16,
}

impl From<&HeadingRender> for HeadingRenderWire {
    fn from(h: &HeadingRender) -> Self {
        Self {
            heading_idx: h.heading_idx,
            start_chapter: h.start_chapter,
            start_verse: h.start_verse,
            end_chapter: h.end_chapter,
            end_verse: h.end_verse,
        }
    }
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct AnnotationWire {
    pub word_index: u16,
    pub kind: AnnotationKind,
}

impl From<Annotation> for AnnotationWire {
    fn from(a: Annotation) -> Self {
        Self {
            word_index: a.word_index,
            kind: a.kind,
        }
    }
}

/// Structural render data — phrase word counts, annotation indices, FTV
/// length. The actual NKJV verse text is composed server-side at request
/// time from the api.bible cache; never crosses this wire.
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct VerseRenderWire {
    pub book: String,
    pub chapter: u16,
    pub verse: u16,
    pub phrase_word_counts: Vec<u16>,
    pub annotations: Vec<AnnotationWire>,
    pub ftv_word_count: Option<u16>,
    pub headings: Vec<HeadingRenderWire>,
    pub clubs: Vec<ClubTier>,
    /// Populated on `ChapterClubList` pseudo-verses with the verse
    /// numbers in the chapter that match the card's tier; empty
    /// everywhere else.
    pub chapter_members: Vec<u16>,
}

impl From<&VerseRender> for VerseRenderWire {
    fn from(v: &VerseRender) -> Self {
        Self {
            book: v.book.clone(),
            chapter: v.chapter,
            verse: v.verse,
            phrase_word_counts: v.phrase_word_counts.clone(),
            annotations: v
                .annotations
                .iter()
                .copied()
                .map(AnnotationWire::from)
                .collect(),
            ftv_word_count: v.ftv_word_count,
            headings: v.headings.iter().map(HeadingRenderWire::from).collect(),
            clubs: v.clubs.clone(),
            chapter_members: v.chapter_members.clone(),
        }
    }
}

/// Wire shape returned by `WasmEngine::get_card_render` — everything the
/// frontend needs to render a card prompt and its answer.
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct CardRenderWire {
    pub card_id: u32,
    pub verse_id: u32,
    #[serde(flatten)]
    pub kind: CardKindWire,
    pub verse: VerseRenderWire,
}

#[derive(Serialize, Deserialize, Clone, Copy, PartialEq, Debug)]
pub enum UpdateKindWire {
    Root,
    Sub,
}

impl From<UpdateKind> for UpdateKindWire {
    fn from(k: UpdateKind) -> Self {
        match k {
            UpdateKind::Root => UpdateKindWire::Root,
            UpdateKind::Sub => UpdateKindWire::Sub,
        }
    }
}

impl From<&TestUpdate> for TestUpdateWire {
    fn from(u: &TestUpdate) -> Self {
        Self {
            key: u.key,
            kind: u.kind.into(),
            before: u.before,
            after: u.after,
        }
    }
}

/// Engine handle exposed to JS. Wraps a `ReviewEngine`, an optional per-
/// material `Schedule`, and translates JSON payloads at the boundary.
#[wasm_bindgen]
pub struct WasmEngine {
    engine: ReviewEngine,
    schedule: Option<verse_vault_core::schedule_data::Schedule>,
}

#[wasm_bindgen]
impl WasmEngine {
    /// Build the engine from a `MaterialData` JSON blob and (optionally) a
    /// list of persisted `TestStateEntry` records to overlay onto the freshly
    /// seeded test states.
    ///
    /// `now_secs` is the wall-clock time used to seed unseen tests; pass the
    /// same Unix-seconds value the rest of the system uses (browser callers
    /// can do `BigInt(Math.floor(Date.now() / 1000))`).
    /// `persisted_states_json` may be `""` or `"[]"` to start fresh.
    /// `material_config_json` may be `""` to use the legacy "everything on"
    /// fallback config (transitional — Phase 1's API path always supplies
    /// a real per-club JSON for production users; see `parse_material_config`)
    /// (everything-on); otherwise it's a JSON `MaterialConfig` carrying the
    /// per-year toggles (headings / ftv / citation) plus the per-club
    /// memorize / review / move_to_next shape.
    /// `schedule_json` may be `""` to skip the schedule entirely — the
    /// memorize algorithm collapses to pure-Sequential when no schedule is
    /// supplied. Otherwise it's a JSON `Schedule` matching the bundled
    /// `data/schedules/<deck>-<season>.json` shape.
    ///
    /// As of `crates/wasm@0.6.0` the standalone `desired_retention`
    /// argument was removed: per-club retention now lives inside
    /// `MaterialConfig.review.{club}.desired_retention`, and the
    /// fallback for pseudo-verses with no tier is the
    /// `ScheduleParams::default().target_retention` (0.9). Existing
    /// callers should drop the argument and pass `schedule_json` in
    /// its slot (empty string preserves pre-0.6.0 behaviour).
    #[wasm_bindgen(constructor)]
    pub fn new(
        material_json: &str,
        material_config_json: &str,
        schedule_json: &str,
        persisted_states_json: &str,
        now_secs: i64,
    ) -> Result<WasmEngine, JsError> {
        let material: MaterialData = serde_json::from_str(material_json)
            .map_err(|e| JsError::new(&format!("material_json parse error: {e}")))?;
        let config = parse_material_config(material_config_json)
            .map_err(|e| JsError::new(&format!("material_config_json parse error: {e}")))?;
        let schedule = parse_schedule(schedule_json)
            .map_err(|e| JsError::new(&format!("schedule_json parse error: {e}")))?;
        let build_result = build_with_config(&material, &config, now_secs);
        // ReviewEngine::new still takes a `desired_retention` that seeds
        // `ScheduleParams.target_retention`; that param now only services
        // the fallback path (`target_r_for_verse` falls back to it for
        // pseudo-verses with no tier). Per-tier retention is read from
        // the MaterialConfig.
        let mut engine = ReviewEngine::new(build_result, 0.9);

        let trimmed = persisted_states_json.trim();
        if !trimmed.is_empty() {
            let entries: Vec<TestStateEntry> = serde_json::from_str(trimmed)
                .map_err(|e| JsError::new(&format!("persisted_states_json parse error: {e}")))?;
            for entry in entries {
                let (key, state) = entry.into_pair();
                engine.tests.insert(key, state);
            }
        }

        Ok(WasmEngine { engine, schedule })
    }

    /// Apply a card review. `grade` is the FSRS-style integer rating
    /// (1=Again, 2=Hard, 3=Good, 4=Easy). Composite cards distribute the
    /// grade across their contained tests via the engine's Bayesian-share
    /// weight. Returns the resulting list of `TestUpdateWire`s as JSON.
    pub fn replay_event(
        &mut self,
        card_id: u32,
        grade: u8,
        now_secs: i64,
    ) -> Result<String, JsError> {
        self.replay_event_inner(card_id, grade, now_secs)
            .map_err(|e| JsError::new(&e))
    }

    /// Snapshot every `TestState` known to the engine as a JSON array of
    /// `TestStateEntry`. Persist this between sessions to resume.
    pub fn export_test_states(&self) -> Result<String, JsError> {
        let entries: Vec<TestStateEntry> = self
            .engine
            .tests
            .iter()
            .map(|(k, s)| TestStateEntry::from_pair(*k, s))
            .collect();
        serde_json::to_string(&entries)
            .map_err(|e| JsError::new(&format!("export serialise error: {e}")))
    }

    /// Pick the next card to review at `now_secs`, or `None` if no Active
    /// card is due. Consults the relearning lane first (lapsed cards past
    /// their FSRS sub-day due time whose tests are cold — see the per-test
    /// coldness gate on `core::schedule::next_relearn_card`) then the
    /// regular descending-R schedule.
    pub fn next_review_card(&self, now_secs: i64) -> Option<u32> {
        if let Some(id) = next_relearn_card(&self.engine, now_secs) {
            return Some(id.0);
        }
        next_card(&self.engine, now_secs).map(|c| c.0)
    }

    /// Count of active cards whose retrievability is below target at
    /// `now_secs`. Mirrors `next_review_card`'s eligibility exactly,
    /// sibling cooldown included (#107 C) — see
    /// `core::schedule::due_review_count`. Dashboard surfaces this as
    /// the "reviews waiting" number.
    pub fn due_review_count(&self, now_secs: i64) -> u32 {
        schedule_due_review_count(&self.engine, now_secs)
    }

    /// JSON-serialised `StabilityHistogram` of active cards bucketed by
    /// weakest-test stability — drives the dashboard's per-card stage
    /// tiles. JSON over the boundary matches the existing pattern for
    /// structured returns (`export_test_states`, `memorize_session`).
    pub fn card_stability_histogram(&self) -> Result<String, JsError> {
        let h = schedule_card_stability_histogram(&self.engine);
        serde_json::to_string(&h).map_err(|e| JsError::new(&e.to_string()))
    }

    /// JSON-serialised `StabilityHistogram` of distinct verses bucketed
    /// by their weakest verse-content card's test stability. Meta-location
    /// cards (`VerseInChapter` / `VerseInBook` / `VerseInHeading` /
    /// `VerseInClub`), the multi-verse pseudos (`HeadingPassage`,
    /// `ChapterClubList`), and `Reading` don't contribute — see
    /// `core::schedule::is_verse_content_card` for the filter.
    pub fn verse_stability_histogram(&self) -> Result<String, JsError> {
        let h = schedule_verse_stability_histogram(&self.engine);
        serde_json::to_string(&h).map_err(|e| JsError::new(&e.to_string()))
    }

    /// Count of distinct verses with at least one `New` card — the
    /// memorize queue's verse footprint. Pseudo verses excluded.
    pub fn new_verse_count(&self) -> u32 {
        schedule_new_verse_count(&self.engine)
    }

    /// Count of distinct verses with at least one due card at
    /// `now_secs` — the review queue's verse footprint. Pseudo
    /// verses excluded.
    pub fn due_verse_count(&self, now_secs: i64) -> u32 {
        schedule_due_verse_count(&self.engine, now_secs)
    }

    /// Count of distinct verses whose weakest test's stability is at
    /// or above `threshold_days`. Pseudo verses excluded. The API
    /// passes its `STABILITY_FAMILIAR_DAYS` so the threshold stays
    /// defined in one place.
    pub fn learned_verse_count(&self, threshold_days: f32) -> u32 {
        schedule_learned_verse_count(&self.engine, threshold_days)
    }

    /// Pick the next New card for the memorize queue. The caller walks the
    /// per-verse progression client-side (see `new_verse_progression` on
    /// the core `Session`) then calls `graduate_verse` to commit.
    pub fn next_memorize_card(&self, now_secs: i64) -> Option<u32> {
        schedule_next_memorize_card(&self.engine, now_secs).map(|c| c.0)
    }

    /// JSON-serialised list of up to `limit` New verses, each paired with
    /// its memorize progression. Used by the web UI to plan a whole
    /// memorize session in one trip — the client can show all verses up
    /// front, drill across them in any order, and walk back through them
    /// for graduation.
    ///
    /// Same per-card filtering rules as `memorize_progression`, plus
    /// session-scoped placement of standalone meta cards:
    ///
    /// * `HeadingPassage` placed via the per-entry `hp_card_id` slot —
    ///   HP attaches to its heading's first session-verse, or to any
    ///   session-verse with capacity (orphan / catch-up).
    /// * `ChapterClubList` via `ccl_card_id` — CCL attaches to the
    ///   chapter+tier's last in-session member (or capacity).
    /// * Conditional verse-bound kinds (`Ftv`, `VerseInHeading`,
    ///   `VerseInClub`) New on a verse whose unconditional content is
    ///   already Active surface as orphans in `orphan_card_ids`
    ///   (deduped by heading_idx / club tier so one per kind per
    ///   session, round-robined across session-verses).
    ///
    /// The web client treats all of those slots as their own reading
    /// / drill / graduation steps. Graduation goes through
    /// `graduate_card`, not the host verse's `graduate_verse`.
    pub fn memorize_session(&self, limit: u32) -> Result<String, JsError> {
        // Pre-0.6.0 surface — calls v2 with `now_secs = 0` so the
        // existing web client keeps working through the wasm bump. The
        // empty-or-absent schedule path inside next_memorize_batch
        // collapses to Phase 2 (pure-Sequential) which matches today's
        // canonical-order behaviour exactly. Deprecated; remove after
        // Phase 2 ships the v2 call site on the web client.
        self.memorize_session_v2(limit, 0)
    }

    /// Schedule-aware memorize session — two-phase canonical fill via
    /// `crates/core::schedule::next_memorize_batch`. Returns the same
    /// `{ verses, orphans }` JSON shape `memorize_session` returns; only
    /// the verse-anchor source changes.
    ///
    /// `now_secs` is the wall-clock used to compute the current week
    /// (CalendarCascade Phase 1) and to evaluate cross-club gates that
    /// reference dated checkpoints.
    pub fn memorize_session_v2(&self, limit: u32, now_secs: i64) -> Result<String, JsError> {
        use std::collections::{HashMap, HashSet};
        use verse_vault_core::card::{CardKind, CardState};
        use verse_vault_core::element::ClubTier;
        #[derive(Serialize)]
        #[serde(rename_all = "camelCase")]
        struct Entry {
            verse_id: u32,
            /// Verse-bound cards drilled with this verse.
            card_ids: Vec<u32>,
            /// Subset of `card_ids` that need an explicit `graduate_card`
            /// on step-3 verse graduation. `graduate_verse` already flips
            /// the rest. Empty when the verse has no conditional kinds
            /// emitted (Ftv/VerseInHeading/VerseInClub).
            #[serde(skip_serializing_if = "Vec::is_empty")]
            conditional_card_ids: Vec<u32>,
            /// Card id of the verse's Recitation, when emitted. The
            /// reading walkthrough uses this to render the verse text
            /// without a PhraseFill's phrase-0 highlight.
            recitation_card_id: Option<u32>,
            #[serde(skip_serializing_if = "Option::is_none")]
            hp_card_id: Option<u32>,
            #[serde(skip_serializing_if = "Option::is_none")]
            ccl_card_id: Option<u32>,
        }
        #[derive(Serialize)]
        #[serde(rename_all = "camelCase")]
        struct Session {
            verses: Vec<Entry>,
            /// Standalone cards that don't anchor to a session-verse:
            /// HP/CCL whose attach point overflowed `verse_order` plus
            /// conditional verse-bound orphans (Ftv/VerseInHeading/
            /// VerseInClub New on Active verses). Per-kind cap = `limit`.
            #[serde(skip_serializing_if = "Vec::is_empty")]
            orphans: Vec<u32>,
        }
        let cards = &self.engine.cards;

        // Tier gate for the HP/CCL/orphan placement loops below. A verse
        // in `Maintenance` keeps its cards built so already-memorized
        // work can still be reviewed, but New cards on those verses must
        // NOT enter the memorize queue. The HashSet collects verse_ids
        // that have at least one `New` card AND pass
        // `verse_active_for_memorize`, so every downstream loop can
        // short-circuit with a single contains() check.
        let memorize_active_verses: HashSet<u32> = cards
            .iter()
            .filter(|c| matches!(c.state, CardState::New))
            .filter(|c| self.engine.verse_active_for_memorize(c.verse_id))
            .map(|c| c.verse_id)
            .collect();

        // Verse anchors come from the schedule-aware two-phase fill —
        // Phase 1 picks CalendarCascade clubs' this-week primary verses
        // first, Phase 2 fills the rest in canonical order. With no
        // schedule supplied (legacy path), Phase 1 contributes nothing
        // and Phase 2 walks every eligible verse in canonical order,
        // matching the old card-scan behaviour byte-for-byte.
        let batch_cap = limit.min(u8::MAX as u32) as u8;
        let batch_card_ids = verse_vault_core::schedule::next_memorize_batch(
            &self.engine,
            self.schedule.as_ref(),
            now_secs,
            batch_cap,
        );
        let verse_order: Vec<u32> = batch_card_ids
            .iter()
            .filter_map(|cid| self.engine.card(*cid).map(|c| c.verse_id))
            .collect();

        // Pre-compute pseudo-card attachments before walking the verses.
        // Two rules govern when a HeadingPassage / ChapterClubList card
        // moves from `New` into the session:
        //
        //   * HeadingPassage: introduce when at least one heading member
        //     is "started" (Active before this session or being graduated
        //     in it). Attach to the earliest member in this session's
        //     `verse_order` — or, when conditions are met purely from
        //     prior Actives (orphan / catch-up after a settings flip),
        //     attach to whichever session verse still has capacity.
        //   * ChapterClubList: introduce when every chapter+tier member
        //     is started by end-of-session. Attach to the latest member
        //     in `verse_order`, or to remaining capacity as a catch-up.
        //
        // Cap at 1 of each kind per session-verse so a backlog of orphan
        // cards doesn't pile onto the first verse — they spread across
        // `verse_order` and the overflow defers to the next session.
        let session_verses: HashSet<u32> = verse_order.iter().copied().collect();
        let active_verses: HashSet<u32> = cards
            .iter()
            .filter(|c| matches!(c.state, CardState::Active))
            .filter(|c| {
                !matches!(
                    c.kind,
                    CardKind::ChapterClubList { .. } | CardKind::HeadingPassage { .. }
                )
            })
            .map(|c| c.verse_id)
            .collect();

        enum AttachIntent {
            Normal(u32),
            Orphan,
            None,
        }

        let mut hp_assigned: HashMap<u32, u32> = HashMap::new();
        let mut ccl_assigned: HashMap<u32, u32> = HashMap::new();
        let mut hp_pending: Vec<u32> = Vec::new();
        let mut ccl_pending: Vec<u32> = Vec::new();

        for card in cards.iter() {
            if !matches!(card.state, CardState::New) {
                continue;
            }
            // Same tier-scope gate as the verse-anchor loop. Excludes
            // CCL pseudos whose tier is in Maintenance; HP pseudos
            // pass through unconditionally because their `clubs` list
            // is empty and `verse_active_for_memorize` returns true
            // for None status.
            if !memorize_active_verses.contains(&card.verse_id) {
                continue;
            }
            let (is_hp, intent) = match card.kind {
                CardKind::HeadingPassage { .. } => {
                    let atoms = self.engine.atoms_for(card.verse_id);
                    let in_session_min = atoms
                        .heading_members
                        .iter()
                        .copied()
                        .filter(|v| session_verses.contains(v))
                        .min();
                    let any_active = atoms
                        .heading_members
                        .iter()
                        .any(|v| active_verses.contains(v));
                    let intent = if let Some(v) = in_session_min {
                        AttachIntent::Normal(v)
                    } else if any_active {
                        AttachIntent::Orphan
                    } else {
                        AttachIntent::None
                    };
                    (true, intent)
                }
                CardKind::ChapterClubList { .. } => {
                    let atoms = self.engine.atoms_for(card.verse_id);
                    let all_settled = atoms
                        .chapter_members
                        .iter()
                        .all(|(v, _)| active_verses.contains(v) || session_verses.contains(v));
                    let in_session_max = atoms
                        .chapter_members
                        .iter()
                        .map(|(v, _)| *v)
                        .filter(|v| session_verses.contains(v))
                        .max();
                    let intent = if !all_settled {
                        AttachIntent::None
                    } else if let Some(v) = in_session_max {
                        AttachIntent::Normal(v)
                    } else {
                        AttachIntent::Orphan
                    };
                    (false, intent)
                }
                _ => continue,
            };
            let (assigned, pending) = if is_hp {
                (&mut hp_assigned, &mut hp_pending)
            } else {
                (&mut ccl_assigned, &mut ccl_pending)
            };
            match intent {
                AttachIntent::Normal(v) => match assigned.entry(v) {
                    std::collections::hash_map::Entry::Vacant(e) => {
                        e.insert(card.id.0);
                    }
                    // Clash: another card of the same kind already claimed
                    // this verse. Defer to the pending pool; the second
                    // pass places it on the next session-verse with
                    // capacity.
                    std::collections::hash_map::Entry::Occupied(_) => {
                        pending.push(card.id.0);
                    }
                },
                AttachIntent::Orphan => pending.push(card.id.0),
                AttachIntent::None => {}
            }
        }

        // Second pass: drain the pending pool into remaining capacity in
        // `verse_order` order so catch-ups land at the start of the
        // session.
        let mut hp_idx = 0usize;
        let mut ccl_idx = 0usize;
        for &verse_id in &verse_order {
            if hp_idx < hp_pending.len()
                && let std::collections::hash_map::Entry::Vacant(e) = hp_assigned.entry(verse_id)
            {
                e.insert(hp_pending[hp_idx]);
                hp_idx += 1;
            }
            if ccl_idx < ccl_pending.len()
                && let std::collections::hash_map::Entry::Vacant(e) = ccl_assigned.entry(verse_id)
            {
                e.insert(ccl_pending[ccl_idx]);
                ccl_idx += 1;
            }
        }

        let mut session_headings: HashSet<u16> = HashSet::new();
        let mut entries: Vec<Entry> = Vec::with_capacity(verse_order.len());

        for &verse_id in &verse_order {
            let mut card_ids: Vec<u32> = Vec::new();
            let mut conditional_card_ids: Vec<u32> = Vec::new();
            for card in cards.iter().filter(|c| c.verse_id == verse_id) {
                match card.kind {
                    CardKind::ChapterClubList { .. }
                    | CardKind::HeadingPassage { .. }
                    | CardKind::Reading => continue,
                    CardKind::VerseInHeading { heading_idx } => {
                        let already_introduced = cards.iter().any(|other| {
                            other.verse_id != verse_id
                                && matches!(other.state, CardState::Active)
                                && matches!(
                                    other.kind,
                                    CardKind::VerseInHeading { heading_idx: h } if h == heading_idx
                                )
                        });
                        if !already_introduced && session_headings.insert(heading_idx) {
                            card_ids.push(card.id.0);
                            conditional_card_ids.push(card.id.0);
                        }
                    }
                    CardKind::Ftv { .. } | CardKind::VerseInClub { .. } => {
                        card_ids.push(card.id.0);
                        conditional_card_ids.push(card.id.0);
                    }
                    _ => card_ids.push(card.id.0),
                }
            }
            let hp_card_id = hp_assigned.get(&verse_id).copied();
            let ccl_card_id = ccl_assigned.get(&verse_id).copied();
            let recitation_card_id = cards
                .iter()
                .find(|c| c.verse_id == verse_id && matches!(c.kind, CardKind::Recitation))
                .map(|c| c.id.0);
            entries.push(Entry {
                verse_id,
                card_ids,
                conditional_card_ids,
                recitation_card_id,
                hp_card_id,
                ccl_card_id,
            });
        }

        // Build the top-level orphan pool. Five sources, each capped
        // at `limit` so the session honours the configured max even
        // when there are no fresh verses to anchor against:
        //
        //   * HP overflow (`hp_pending` minus what fit in `verse_order`).
        //   * CCL overflow (same).
        //   * Conditional verse-bound kinds (Ftv / VerseInHeading /
        //     VerseInClub) New on a verse that isn't a session-verse —
        //     deduped by `heading_idx` / `tier` so multiple orphans of
        //     the same heading/tier collapse to one.
        let cap = limit as usize;
        let mut orphans: Vec<u32> = Vec::new();
        // HP overflow: ids in `hp_pending` that didn't end up in
        // `hp_assigned` after the second pass. Budget caps total HP
        // (placed + overflow) at `limit` per session.
        let hp_placed_ids: HashSet<u32> = hp_assigned.values().copied().collect();
        let hp_budget = cap.saturating_sub(hp_placed_ids.len());
        for &id in hp_pending
            .iter()
            .filter(|id| !hp_placed_ids.contains(id))
            .take(hp_budget)
        {
            orphans.push(id);
        }
        // CCL overflow, same shape.
        let ccl_placed_ids: HashSet<u32> = ccl_assigned.values().copied().collect();
        let ccl_budget = cap.saturating_sub(ccl_placed_ids.len());
        for &id in ccl_pending
            .iter()
            .filter(|id| !ccl_placed_ids.contains(id))
            .take(ccl_budget)
        {
            orphans.push(id);
        }
        // Conditional orphans. Each kind capped at `limit`; dedup by
        // heading_idx / tier so we don't burn the cap on multiple
        // orphans for the same heading or club.
        let mut ftv_count = 0usize;
        let mut vih_count = 0usize;
        let mut vic_count = 0usize;
        let mut seen_orphan_headings: HashSet<u16> = HashSet::new();
        let mut seen_orphan_tiers: HashSet<ClubTier> = HashSet::new();
        for card in cards.iter() {
            if !matches!(card.state, CardState::New) {
                continue;
            }
            // Same tier-scope gate. Without this, a verse in
            // Maintenance status (its tier in `review_scope` but not
            // `new_scope`) still leaks Ftv / VerseInHeading /
            // VerseInClub orphans into the session even though the
            // verse-anchor loop excluded it — concrete reported repro:
            // John 1:6 (Club300, Maintenance under new=Up150 /
            // review=Up300) has `ftvWordCount=5` so the builder emits a
            // `Ftv` card in New state, which without this gate lands
            // in `orphans[]`.
            if !memorize_active_verses.contains(&card.verse_id) {
                continue;
            }
            if session_verses.contains(&card.verse_id) {
                continue;
            }
            match card.kind {
                CardKind::Ftv { .. } if ftv_count < cap => {
                    orphans.push(card.id.0);
                    ftv_count += 1;
                }
                CardKind::VerseInHeading { heading_idx }
                    if seen_orphan_headings.insert(heading_idx) && vih_count < cap =>
                {
                    orphans.push(card.id.0);
                    vih_count += 1;
                }
                CardKind::VerseInClub { tier }
                    if seen_orphan_tiers.insert(tier) && vic_count < cap =>
                {
                    orphans.push(card.id.0);
                    vic_count += 1;
                }
                _ => {}
            }
        }

        serde_json::to_string(&Session {
            verses: entries,
            orphans,
        })
        .map_err(|e| JsError::new(&format!("session serialise error: {e}")))
    }

    /// Flip every `New` verse-bound card belonging to `verse_id` to
    /// `Active`. Returns the number of cards transitioned. Idempotent.
    /// Called by the `/memorize` flow after the learner walks the
    /// per-verse progression and confirms.
    ///
    /// HeadingPassage and ChapterClubList cards anchored to the same
    /// verse_id are deliberately skipped — they surface as standalone
    /// session items in the `memorize_session` shape and graduate via
    /// `graduate_card`. See `verse-vault-core@0.5.0` for the state
    /// semantics.
    pub fn graduate_verse(&mut self, verse_id: u32) -> u32 {
        self.engine.graduate_verse(verse_id) as u32
    }

    /// Flip a single `New` card to `Active` and return whether the
    /// transition happened (false on unknown card id or already
    /// non-`New`). Idempotent. Used by the `/memorize` flow to
    /// graduate HeadingPassage / ChapterClubList cards independently
    /// of their attach verse.
    pub fn graduate_card(&mut self, card_id: u32) -> bool {
        self.engine
            .graduate_card(verse_vault_core::types::CardId(card_id))
    }

    /// True when `card_id` belongs to this material's deck. Cheap
    /// existence probe — the API uses it to distinguish 404 from
    /// "already graduated" on the per-card graduation endpoint.
    pub fn has_card(&self, card_id: u32) -> bool {
        self.engine
            .card(verse_vault_core::types::CardId(card_id))
            .is_some()
    }

    /// Count of `New` cards eligible for the memorize queue. Drives
    /// the "N to memorize" nudge in the web UI nav.
    pub fn new_card_count(&self) -> u32 {
        schedule_new_card_count(&self.engine)
    }

    /// Render data for a card: kind, verse_id, plus the verse's render data
    /// (book / chapter / verse number, full text, phrases, ftv, headings,
    /// clubs). Returns JSON of `CardRenderWire`. Errors when the card id
    /// is unknown or the verse has no render data.
    pub fn get_card_render(&self, card_id: u32) -> Result<String, JsError> {
        let card = self
            .engine
            .card(CardId(card_id))
            .ok_or_else(|| JsError::new(&format!("unknown card id {card_id}")))?;
        let verse = self.engine.verse_render(card.verse_id).ok_or_else(|| {
            JsError::new(&format!(
                "no render data for verse {} (card {card_id})",
                card.verse_id
            ))
        })?;
        let wire = CardRenderWire {
            card_id,
            verse_id: card.verse_id,
            kind: card.kind.into(),
            verse: VerseRenderWire::from(verse),
        };
        serde_json::to_string(&wire)
            .map_err(|e| JsError::new(&format!("render serialise error: {e}")))
    }

    /// Aggregate card counts by the verse's most-specific club tier. JSON
    /// shape: `{ "Club150": 42, "Club300": 8, "Full": 0 }`. Used by the
    /// material picker to render per-club totals next to each row.
    pub fn card_count_by_club(&self) -> Result<String, JsError> {
        serde_json::to_string(&self.club_counts())
            .map_err(|e| JsError::new(&format!("serialise error: {e}")))
    }

    /// Render data for every card in the deck, in card-id order. Returns
    /// JSON of `CardRenderWire[]`. The server uses this on the bulk
    /// `GET /materials/:id/renders` path to compose every card's HTML in
    /// one engine call rather than N round-trips; the client doesn't call
    /// this directly today.
    pub fn all_card_renders(&self) -> Result<String, JsError> {
        serde_json::to_string(&self.all_card_renders_inner())
            .map_err(|e| JsError::new(&format!("render serialise error: {e}")))
    }
}

fn parse_schedule(
    json: &str,
) -> Result<Option<verse_vault_core::schedule_data::Schedule>, serde_json::Error> {
    let trimmed = json.trim();
    if trimmed.is_empty() {
        Ok(None)
    } else {
        let mut schedule: verse_vault_core::schedule_data::Schedule =
            serde_json::from_str(trimmed)?;
        // Fold any legacy `passage`/`verses` week-level fields (v1 wire
        // shape) into `blocks[]` before the algorithm touches the data —
        // API 0.1.30+ emits v2 natively, but bundled JSONs and pre-
        // migration user rows still ship v1.
        schedule.normalize_v1_weeks();
        Ok(Some(schedule))
    }
}

fn parse_material_config(json: &str) -> Result<MaterialConfig, serde_json::Error> {
    let trimmed = json.trim();
    if trimmed.is_empty() {
        // Empty config_json from the API means "no user settings stored yet."
        // Pre-Phase-1, that fell through to MaterialConfig::default() which
        // historically meant "every club Active at 0.9 retention." The new
        // MaterialConfig::default() is the spec's Club-150-only new-user
        // shape, so a verbatim swap would silently pause Club 300 / Full
        // verses for any user without a settings row — including the wasm
        // test fixtures that use clubs: [] (parse_tiers → Full).
        //
        // Preserve the historical contract by mapping "" to all-clubs-
        // enabled at the legacy 0.9 default. The TS engine.ts path (commit 8
        // in this train) writes the real per-club JSON before calling wasm,
        // so production never relies on this branch for real users.
        Ok(MaterialConfig::all_clubs_enabled(0.9))
    } else {
        serde_json::from_str(trimmed)
    }
}

impl WasmEngine {
    /// Tier-bucketed counts shared by the bindgen entry point and native
    /// tests. parse_tiers in the builder guarantees every verse has at
    /// least one tier (Full when no narrower tag), so the None match arm
    /// is defensive.
    fn club_counts(&self) -> std::collections::HashMap<String, u32> {
        let mut counts: std::collections::HashMap<String, u32> = std::collections::HashMap::new();
        for card in &self.engine.cards {
            let atoms = self.engine.atoms_for(card.verse_id);
            let label = match atoms.clubs.first() {
                Some(ClubTier::Club150) => "Club150",
                Some(ClubTier::Club300) => "Club300",
                Some(ClubTier::Full) | None => "Full",
            };
            *counts.entry(label.to_string()).or_insert(0) += 1;
        }
        counts
    }

    /// Native test shim for `card_count_by_club` (mirrors the bindgen
    /// surface). Returns the same JSON the JS side would receive.
    pub fn card_count_by_club_for_test(&self) -> String {
        serde_json::to_string(&self.club_counts()).unwrap()
    }

    /// Shared body of the bindgen `all_card_renders` and its native
    /// test shim. The builder seeds render data for every card's verse,
    /// so a missing entry is a real invariant break worth panicking on
    /// — silently skipping would deliver a partial deck to the
    /// offline-mode client with no signal.
    fn all_card_renders_inner(&self) -> Vec<CardRenderWire> {
        self.engine
            .cards
            .iter()
            .map(|card| {
                let verse = self
                    .engine
                    .verse_render(card.verse_id)
                    .expect("builder guarantees verse render for every card");
                CardRenderWire {
                    card_id: card.id.0,
                    verse_id: card.verse_id,
                    kind: card.kind.into(),
                    verse: VerseRenderWire::from(verse),
                }
            })
            .collect()
    }

    /// Native-Rust shim for `all_card_renders`. Mirrors the
    /// `card_count_by_club_for_test` pattern — body is infallible over
    /// plain-data wires, so `unwrap` is honest.
    pub fn all_card_renders_for_test(&self) -> String {
        serde_json::to_string(&self.all_card_renders_inner()).unwrap()
    }

    /// Native-Rust shim for `replay_event` so integration tests can drive
    /// the validation paths without triggering a `JsError` (which calls a
    /// wasm-bindgen import that panics on non-wasm targets).
    pub fn replay_event_for_test(
        &mut self,
        card_id: u32,
        grade: u8,
        now_secs: i64,
    ) -> Result<String, String> {
        self.replay_event_inner(card_id, grade, now_secs)
    }

    /// Native-Rust shim for `get_card_render`. Same JsError-on-native
    /// caveat as `replay_event_for_test`.
    pub fn get_card_render_for_test(&self, card_id: u32) -> Result<String, String> {
        let card = self
            .engine
            .card(CardId(card_id))
            .ok_or_else(|| format!("unknown card id {card_id}"))?;
        let verse = self.engine.verse_render(card.verse_id).ok_or_else(|| {
            format!(
                "no render data for verse {} (card {card_id})",
                card.verse_id
            )
        })?;
        let wire = CardRenderWire {
            card_id,
            verse_id: card.verse_id,
            kind: card.kind.into(),
            verse: VerseRenderWire::from(verse),
        };
        serde_json::to_string(&wire).map_err(|e| format!("render serialise error: {e}"))
    }

    /// Validate at the WASM boundary so a stale / drifted JS payload returns
    /// a recoverable error instead of panicking through `engine.review` and
    /// aborting the entire WASM instance. Kept outside the `#[wasm_bindgen]`
    /// impl so we can test it as plain Rust (constructing a `JsError` panics
    /// on non-wasm targets).
    fn replay_event_inner(
        &mut self,
        card_id: u32,
        grade: u8,
        now_secs: i64,
    ) -> Result<String, String> {
        let g = match grade {
            1 => Grade::Again,
            2 => Grade::Hard,
            3 => Grade::Good,
            4 => Grade::Easy,
            _ => return Err(format!("invalid grade {grade}: expected 1..=4")),
        };
        if self.engine.card(CardId(card_id)).is_none() {
            return Err(format!("unknown card id {card_id}"));
        }
        let outcome = self.engine.review(CardId(card_id), g, now_secs);
        let wire: Vec<TestUpdateWire> = outcome.updates.iter().map(TestUpdateWire::from).collect();
        serde_json::to_string(&wire).map_err(|e| format!("response serialise error: {e}"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use verse_vault_core::element::ElementId;
    use verse_vault_core::test_kind::TestKind;

    #[test]
    fn test_state_entry_round_trips_via_json() {
        let entry = TestStateEntry {
            element: ElementId::Phrase {
                verse_id: 7,
                start_word: 4,
                end_word: 6,
            },
            test_kind: TestKind::PhraseFromContext,
            stability: 12.5,
            difficulty: 5.5,
            last_seen_secs: 1_700_000_000,
            last_base_secs: 1_699_000_000,
            last_root_secs: 1_690_000_000,
            pending_relearn: true,
        };
        let j = serde_json::to_string(&entry).unwrap();
        let r: TestStateEntry = serde_json::from_str(&j).unwrap();
        assert_eq!(entry, r);
    }

    #[test]
    fn test_state_entry_into_pair_round_trip() {
        let entry = TestStateEntry {
            element: ElementId::VerseRefPosition { verse_id: 1 },
            test_kind: TestKind::VerseRefPosition,
            stability: 3.0,
            difficulty: 4.0,
            last_seen_secs: 100,
            last_base_secs: 90,
            last_root_secs: 80,
            pending_relearn: false,
        };
        let (key, state) = entry.clone().into_pair();
        let again = TestStateEntry::from_pair(key, &state);
        assert_eq!(entry, again);
    }

    #[test]
    fn test_state_entry_missing_pending_relearn_defaults_false() {
        // Pre-Slice-2 snapshots have no `pending_relearn` field. Make sure
        // they still deserialize cleanly with the flag defaulting to false.
        let with_flag = TestStateEntry {
            element: ElementId::VerseRefPosition { verse_id: 1 },
            test_kind: TestKind::VerseRefPosition,
            stability: 3.0,
            difficulty: 4.0,
            last_seen_secs: 100,
            last_base_secs: 90,
            last_root_secs: 80,
            pending_relearn: false,
        };
        let mut value = serde_json::to_value(&with_flag).unwrap();
        value.as_object_mut().unwrap().remove("pending_relearn");
        let entry: TestStateEntry = serde_json::from_value(value).unwrap();
        assert!(!entry.pending_relearn);
    }

    #[test]
    fn test_update_wire_round_trips() {
        let key = TestKey {
            kind: TestKind::PhraseFromContext,
            element: ElementId::Phrase {
                verse_id: 1,
                start_word: 0,
                end_word: 2,
            },
        };
        let before = TestState::new_unseen(0);
        let after = TestState::new_unseen(86400);
        let wire = TestUpdateWire {
            key,
            kind: UpdateKindWire::Root,
            before,
            after,
        };
        let j = serde_json::to_string(&wire).unwrap();
        let r: TestUpdateWire = serde_json::from_str(&j).unwrap();
        assert_eq!(r.key, wire.key);
        assert_eq!(r.kind, wire.kind);
        assert_eq!(r.before.stability, wire.before.stability);
        assert_eq!(r.after.last_seen_secs, wire.after.last_seen_secs);
    }
}
