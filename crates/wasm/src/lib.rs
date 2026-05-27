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
    next_card, next_memorize_card as schedule_next_memorize_card, next_relearn_card,
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

/// Engine handle exposed to JS. Wraps a `ReviewEngine` and translates JSON
/// payloads at the boundary.
#[wasm_bindgen]
pub struct WasmEngine {
    engine: ReviewEngine,
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
    /// `material_config_json` may be `""` to use `MaterialConfig::default()`
    /// (everything-on); otherwise it's a JSON `MaterialConfig` carrying the
    /// per-year toggles (headings / ftv / citation).
    #[wasm_bindgen(constructor)]
    pub fn new(
        material_json: &str,
        material_config_json: &str,
        persisted_states_json: &str,
        desired_retention: f32,
        now_secs: i64,
    ) -> Result<WasmEngine, JsError> {
        let material: MaterialData = serde_json::from_str(material_json)
            .map_err(|e| JsError::new(&format!("material_json parse error: {e}")))?;
        let config = parse_material_config(material_config_json)
            .map_err(|e| JsError::new(&format!("material_config_json parse error: {e}")))?;
        let build_result = build_with_config(&material, &config, now_secs);
        let mut engine = ReviewEngine::new(build_result, desired_retention);

        let trimmed = persisted_states_json.trim();
        if !trimmed.is_empty() {
            let entries: Vec<TestStateEntry> = serde_json::from_str(trimmed)
                .map_err(|e| JsError::new(&format!("persisted_states_json parse error: {e}")))?;
            for entry in entries {
                let (key, state) = entry.into_pair();
                engine.tests.insert(key, state);
            }
        }

        Ok(WasmEngine { engine })
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
    /// card is due. Consults the relearning lane first (freshly-lapsed
    /// cards past their FSRS sub-day due time, bypassing sibling cooldown)
    /// then the regular descending-R schedule.
    pub fn next_review_card(&self, now_secs: i64) -> Option<u32> {
        if let Some(id) = next_relearn_card(&self.engine, now_secs) {
            return Some(id.0);
        }
        next_card(&self.engine, now_secs).map(|c| c.0)
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
    /// session-scoped pseudo-card placement: a `VerseInHeading` heading
    /// is drilled on the first verse that introduces it within this
    /// batch; `HeadingPassage` and `ChapterClubList` cards are attached
    /// to a session-verse when their trigger conditions are met (any
    /// heading member started for HP, all chapter+tier members started
    /// for CCL), capped at one of each kind per verse so backlog cards
    /// spread instead of piling on a single attach point.
    pub fn memorize_session(&self, limit: u32) -> Result<String, JsError> {
        use std::collections::{HashMap, HashSet};
        use verse_vault_core::card::{CardKind, CardState};
        #[derive(Serialize)]
        #[serde(rename_all = "camelCase")]
        struct Entry {
            verse_id: u32,
            card_ids: Vec<u32>,
            /// Card id of the verse's Recitation, when emitted. The web
            /// client uses this to render the whole verse as a plain
            /// reading prompt during the session's opening + closing
            /// walkthroughs, avoiding the phrase-0 highlight that a
            /// PhraseFill render would impose.
            recitation_card_id: Option<u32>,
        }
        let cards = &self.engine.cards;

        let mut seen_verses: HashSet<u32> = HashSet::new();
        let mut verse_order: Vec<u32> = Vec::new();
        for card in cards.iter() {
            if !matches!(card.state, CardState::New) {
                continue;
            }
            if seen_verses.insert(card.verse_id) {
                verse_order.push(card.verse_id);
                if verse_order.len() >= limit as usize {
                    break;
                }
            }
        }

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

        for verse_id in verse_order {
            let mut card_ids: Vec<u32> = Vec::new();
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
                        }
                    }
                    _ => card_ids.push(card.id.0),
                }
            }
            if let Some(&c) = hp_assigned.get(&verse_id) {
                card_ids.push(c);
            }
            if let Some(&c) = ccl_assigned.get(&verse_id) {
                card_ids.push(c);
            }
            let recitation_card_id = cards
                .iter()
                .find(|c| c.verse_id == verse_id && matches!(c.kind, CardKind::Recitation))
                .map(|c| c.id.0);
            entries.push(Entry {
                verse_id,
                card_ids,
                recitation_card_id,
            });
        }

        serde_json::to_string(&entries)
            .map_err(|e| JsError::new(&format!("session serialise error: {e}")))
    }

    /// Flip every `New` card belonging to `verse_id` to `Active`. Returns
    /// the number of cards transitioned. Idempotent. Called by the
    /// `/memorize` flow after the learner walks the per-verse progression
    /// and confirms.
    pub fn graduate_verse(&mut self, verse_id: u32) -> u32 {
        self.engine.graduate_verse(verse_id) as u32
    }

    /// Count of `New` cards still awaiting memorize. Drives the
    /// "N to memorize" nudge in the web UI nav.
    pub fn new_card_count(&self) -> u32 {
        self.engine
            .cards
            .iter()
            .filter(|c| matches!(c.state, verse_vault_core::card::CardState::New))
            .count() as u32
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

fn parse_material_config(json: &str) -> Result<MaterialConfig, serde_json::Error> {
    let trimmed = json.trim();
    if trimmed.is_empty() {
        Ok(MaterialConfig::default())
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
