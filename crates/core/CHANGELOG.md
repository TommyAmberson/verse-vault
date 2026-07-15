# Changelog — `verse-vault-core`

All notable changes to this crate are documented here, following
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## Why this changelog matters

`verse-vault-core` is the **algorithm contract** — the version on `Cargo.toml` is effectively a
protocol version. Every consumer that runs the algorithm (server-side via the API, eventually
browser/Tauri/CLI fat clients) declares which `core` version it ships with in its own changelog. A
version mismatch between client and server is a real compatibility signal: state computed under
different algorithms can diverge, and historical events may replay differently.

Bumps follow semver semantics:

* **MAJOR**: breaking change to memory model or state semantics — replay of historical events under
  the new core would produce different state.
* **MINOR**: additive feature (new test kind, new card kind, new scheduler knob) that's
  backward-compatible with existing event logs.
* **PATCH**: pure bug fix or implementation change with no observable semantic effect.

## [Unreleased]

## [0.7.1] — 2026-07-15

PATCH bump — scheduling-query bug fixes for #107. No state-semantics or wire change: event replay
under 0.7.1 produces byte-identical state to 0.7.0; only the read-side scheduling surfaces change
behaviour.

### Fixed

* **Relearning lane re-served just-lapsed cards** (#107 A/B). `next_relearn_card` now applies a
  per-test coldness gate: a `pending_relearn` test only qualifies once its own `last_seen_secs` is
  older than `sibling_cooldown_secs`. Grading Again advances `last_seen_secs` on every marked test,
  so the lane previously surfaced the same card (or a sibling sharing the test) seconds after the
  lapse — a re-drill of an answer the learner just saw. A cold lapse still surfaces even when its
  card is cooldown-masked via some other shared test, which was the lane's designed purpose.
* **Badge/session disagreement fresh off a session** (#107 C). `due_review_count` and
  `due_verse_count` now honour the sibling cooldown, matching `next_card`'s eligibility exactly.
  They previously counted cooldown-masked cards, so the "N to review" badge advertised reviews the
  session refused to serve ("1 to review" → "Session complete") until the cooldown lapsed.

## [0.7.0] — 2026-07-11

MAJOR bump — schedule editor redesign phase 6. `ScheduleWeek` swaps to `blocks: Vec<PassageBlock>`
so compound (`|`) weeks carry multiple passages under one date. State semantics change on
multi-passage weeks: `week_verse_refs` and `cumulative_verse_refs_through_week` now sum across every
passage block, and Full-tier derivation runs per-block (a verse listed as Club 300 on one passage no
longer shadows Full on the sibling passage).

The legacy v1 wire fields `passage`/`verses` at the `ScheduleWeek` level remain accepted via serde
defaults, so pre-migration user rows and bundled JSONs deserialise unchanged. Call
`Schedule::normalize_v1_weeks()` after `serde_json::from_str` to fold them into `blocks[]` before
touching the algorithm (`crates/wasm::parse_schedule` does this automatically).

### Migration

* `ScheduleWeek::passage` / `ScheduleWeek::verses` are now
  `#[serde(skip_serializing_if = "Option::is_none")]` and cleared by `normalize_v1_weeks`. Newly
  emitted schedules land in v2 wire form (blocks-only).
* Direct construction of `ScheduleWeek { passage, verses, ... }` no longer compiles — call sites
  must populate `blocks` (empty on review weeks, one element on single-passage weeks).
* Algorithm re-runs on the same event log produce identical output when every week is
  single-passage; multi-passage weeks change output because they now surface refs from every block
  instead of dropping to a review-empty stub.

## [0.6.0] — 2026-06-14

MAJOR bump for the schedules + per-club settings rework (Phase 1). The state shape of
`MaterialConfig` changes: the flat `(new_scope, review_scope, desired_retention)` triple is replaced
by per-club `memorize`, `review`, and a per-pair `move_to_next` gate. Event replay of pre-0.6.0
settings JSON still works via serde aliases that materialise the per-club shape on read — but a
0.6.0 engine constructed from a 0.5.1 settings string sees a different `MaterialConfig` than a 0.5.1
engine would, so this is a MAJOR by the changelog's "different state under replay" rubric.

### New: per-club memorize + review config

* `MaterialConfig.memorize: ClubMemorizeMap` — per-club
  `{ enabled, catch_up: Sequential | CalendarCascade }`. Replaces `new_scope` and
  `desired_retention`'s memorize half.
* `MaterialConfig.review: ClubReviewMap` — per-club `{ enabled, desired_retention }`. Retention is
  now per-club (range `[0.5, 0.9]`, default `0.8`); the old flat `desired_retention` migrates by
  applying the (clamped) value across every enabled review club.
* `MaterialConfig.move_to_next: MoveToNextConfig` — per adjacent pair (`p150_to_300`,
  `p300_to_full`), with five gates: `FullyMemorized`, `AfterMajorCheckpoint`,
  `AfterMinorCheckpoint`, `CaughtUp`, `Always`. Default `CaughtUp` so enabling a lower club surfaces
  its verses as soon as the user is on-pace for the higher.
* `MaterialConfig.lesson_batch_size: u8` (default `1`) — moved into the config so per-session size
  travels with the rest of the per-material preferences.
* `MaterialConfig::default()` is now the spec's new-user shape (Club 150 enabled at retention 0.8,
  others off). The historical "everything active at 0.9" is now
  `MaterialConfig::all_clubs_enabled(0.9)`; `builder::build()` uses the latter so existing test
  fixtures continue to emit cards for every tier.

Legacy JSON (`{ new_scope, review_scope, desired_retention, ... }`) still parses through
`MaterialConfigRaw`'s `from` adapter. The retention is clamped to the new `[0.5, 0.9]` range; values
stored above 0.9 (a common pre-0.6.0 preference) cap to 0.9 on first load.

### New: `Schedule` data model

* `crates/core/src/schedule_data.rs` introduces
  `Schedule { weeks, meets, meeting_day_of_week, ... }` and
  `Meet { id, name, start_date, end_date, location }`. Bundled per material at
  `data/schedules/<deck>-<season>.json`; the API ships a customised copy per user in a
  `material_schedules` row.
* Date helpers (`current_week_index`, `most_recent_past_meet`) and verse-ref helpers
  (`week_verse_refs`, `cumulative_verse_refs_through_week`, `cumulative_count_*`) anchor the
  cross-club gate evaluators and the memorize-tab badge math downstream. Full-tier refs are derived
  as `passage` range minus `club150 ∪ club300`.

### Per-verse retention threading

* `ReviewEngine::target_r_for_verse(verse_id) -> f32` reads the verse's most-specific tier and looks
  up `MaterialConfig::target_r_for(tier)`. Falls back to `schedule_params.target_retention` for
  pseudo-verses with no tier.
* `next_card`, `due_review_count`, `due_verse_count`, and `next_relearn_card` all switch to the
  per-verse path. `ScheduleParams.target_retention` stays as the fallback only; the scheduler no
  longer uses it directly for the threshold check.
* `target_r_for` clamps to `[0.5, 0.9]` on read — out-of-range stored values can't reach FSRS math
  (would produce NaN or infinite due times).

### New: two-phase canonical memorize fill

* `next_memorize_batch(engine, schedule, now_secs, batch_size) -> Vec<CardId>` in `schedule.rs`
  implements the spec's algorithm. Phase 1 picks `CalendarCascade` clubs' this-week primary verses
  in canonical order (soft cap overflow allowed). Phase 2 picks everything else eligible in
  canonical order until the batch fills. Cross-club gates only control eligibility; once eligible,
  ordering is purely canonical.
* `next_memorize_card(engine, now_secs)` is now a thin `.first()` wrapper around
  `next_memorize_batch(engine, None, now_secs, 1)`. Passing `schedule: None` collapses the algorithm
  to Phase 2 only (i.e. pure-Sequential), which matches the legacy single-card surface.
* `anchor_card_for_verse(engine, verse_id)` extracted as a shared helper — picks `Recitation` when
  New, else the first `New` bulk-graduable card. Commit on `crates/wasm@0.6.0` reuses this in
  `memorize_session_v2` so the wasm verse-anchor pick stays consistent with the new batch surface.

## [0.5.1] — 2026-06-11

Two correctness fixes surfaced by an exhaustive review pass. Both are pure implementation fixes with
no event-replay semantic change for well-formed historical state: replaying a healthy event log
under 0.5.1 produces the same `TestState` for every test that wasn't hitting the bug. Replay of a
log that previously hit one of the bugs (same-instant sub-updates inflating stability, or a
zero-word Ftv card emitted into the schedule) ends up in the corrected state, which is the intended
direction. PATCH per this changelog's rubric.

### Floor `elapsed` consistently across the retrievability-blend in `FsrsBridge::update`

* The `weight<1` blend in `FsrsBridge::update` computed `r_now` and `r_direct` with raw `elapsed`
  but inverted via `invert_r(elapsed.max(0.001), ...)`. A same-instant sub-update (`elapsed == 0`)
  produced `r_now = r_direct = 1.0`, then `invert_r(1.0, 0.001, ...)` hit its `denom < 1e-9`
  short-circuit and returned `S_MAX` — a single same-instant review collapsed stability to the
  ~365-day ceiling regardless of prior state. The forward and inverse now share the same
  `max(0.001)` floor on `elapsed`, so they agree numerically and the same-instant case correctly
  resolves to the unchanged stability. 0.001 day (~86 s) is well below the resolution of any real
  review timestamp, so human-scale intervals are unaffected.

### Don't emit `Ftv` cards for verses with `ftvWordCount = 0`

* `builder.rs`'s FTV eligibility check accepted `ftv_words == 0`: it required
  `(ftv_words as usize) <= FTV_MAX_WORDS` and `ftv_words <= phrase_zero_word_count`, both of which
  pass on zero. The doc on `Verse::ftv_word_count` says `None` means no FTV — `derive_structure` is
  the gatekeeper — but shipped data (e.g. Ephesians 1:2, Philippians 1:2 in `data/1-gepc.json`)
  carries an explicit `"ftvWordCount": 0`. The builder was emitting a zero-word FTV card for those
  verses with no visible cue. Adds an `ftv_words > 0` floor to the eligibility check.

## [0.5.0] — 2026-05-28

`graduate_verse` narrows to the unconditional verse-bound set. Conditional kinds (`Ftv`,
`VerseInHeading`, `VerseInClub`) and the multi-verse pseudos (`HeadingPassage`, `ChapterClubList`)
are no longer flipped by a verse's graduation — they need explicit `graduate_card` events. This lets
the memorize flow surface each of them as a standalone session item the learner reads, drills, and
graduates independently of the verse they anchor to. A settings flip after the host verse was first
graduated then produces a visible orphan instead of a silently transitively-Active card the user
never engaged with. MAJOR per the state-semantics rubric — replay of an existing `graduate_verse`
log produces a different end state (previously transitively-graduated Ftv / VerseInHeading /
VerseInClub / HP / CCL stay `New` until an explicit `graduate_card` is replayed).

### Added

* `ReviewEngine::graduate_card(card_id) -> bool` — flips a single `New` card to `Active`, returning
  whether a transition happened. Idempotent. Used by the memorize flow to graduate every kind that
  `graduate_verse` no longer touches.

### Changed

* `ReviewEngine::graduate_verse` flips only the unconditional verse-bound kinds: `PhraseFill`,
  `Recitation`, `Citation`, `VerseAtVerseRef`, `VerseInChapter`, `VerseInBook`. These always exist
  for any verse with content and reliably represent "the user memorized this verse." The conditional
  kinds (`Ftv`, `VerseInHeading`, `VerseInClub`) and the multi-verse pseudos (`HeadingPassage`,
  `ChapterClubList`) are deliberately skipped — their emission depends on the per-year settings
  (`ftv`, `heading_card`, `club_card_scope`, `heading_passage_card`, `chapter_list_scope`), and
  flipping one on after the host verse was first graduated would otherwise silently
  transitively-Active the newly emitted card.

## [0.4.0] — 2026-05-28

Tier status (`Active` / `Maintenance` / `Paused`) becomes a **runtime filter** instead of a
build-time mutation: flipping a tier in settings only changes what surfaces in the memorize and
review queues, never card state or FSRS state. Existing `Active` cards in a tier the user just moved
to `Maintenance` keep their review schedule; only their never-graduated siblings stop appearing in
`/memorize`. MINOR per the additive-feature rubric — adds new public surface on `ReviewEngine` and a
new `schedule::new_card_count` helper.

### Added

* `ReviewEngine.material_config: MaterialConfig` — retained from the build so queue helpers can
  consult per-tier scopes at request time without callers threading it through.
* `ReviewEngine.verse_status(verse_id)` — effective `ClubStatus` (Active / Maintenance / Paused) for
  a verse, derived from its most-specific tier and the current `material_config`.
* `schedule::new_card_count(engine)` — count of `New` cards eligible for the memorize queue. Was
  previously a wasm-only inline filter; the move to core keeps the tier-status filter colocated with
  `next_memorize_card` and `new_verse_count`.

### Changed

* `next_memorize_card`, `new_card_count`, `new_verse_count` — now skip cards whose verse's tier is
  in `Maintenance` status (the user opted that tier out of new-card introduction but kept it in the
  review scope). Paused-tier verses were already excluded at build time and stay that way; their
  `test_states` persist in the database and reconnect when the tier flips back.
* Stats helpers (`card_stability_histogram`, `verse_stability_histogram`, `due_review_count`,
  `due_verse_count`, `learned_verse_count`) deliberately stay unfiltered — they reflect what's in
  the engine, not what's queued.

## [0.3.0] — 2026-05-28

Dashboard stats helpers: a bundle of pure-read scheduler queries that drive the new `/dashboard`
view, plus a new `StabilityHistogram` wire type. All additive; existing event replay produces
identical state. MINOR per this changelog's own rubric ("additive feature — new test kind, new card
kind, new scheduler knob") — six new public scheduler helpers count as the additive case.

### Added

* `schedule::StabilityHistogram { weak, learning, familiar, strong, mastered }` — five-bucket
  stability count, days-based (`< 1` / `< 7` / `< 30` / `< 90` / `>= 90`). Shared return type for
  the histogram helpers below.
* `schedule::due_review_count(engine, now_secs)` — count of active cards whose minimum-test
  retrievability is below `target_retention` at `now_secs`. Mirrors `next_card`'s eligibility but
  drops the sibling-cooldown filter, since the dashboard surfaces this between sessions and
  shouldn't wobble in the seconds after a review.
* `schedule::card_stability_histogram(engine)` — buckets every active card by its weakest test's
  stability. Skips New cards (they belong to the memorize queue, not the review distribution).
* `schedule::new_verse_count(engine)` / `schedule::due_verse_count(engine, now_secs)` —
  verse-footprint counterparts to the existing `new_card_count` and `due_review_count`.
* `schedule::verse_stability_histogram(engine)` — buckets distinct verses by the minimum stability
  across their verse-content cards' tests. Each verse lives in exactly one bucket, so the sum of
  `weak..mastered` equals the total memorised-verse count.
* `schedule::learned_verse_count(engine, threshold_days)` — count of distinct verses whose weakest
  verse-content card test is at or above `threshold_days` (the API passes its
  `STABILITY_FAMILIAR_DAYS` so the cutoff stays defined in one place).

### Semantics

* Verse-side helpers (`new_verse_count`, `due_verse_count`, `verse_stability_histogram`,
  `learned_verse_count`) only consider **verse-content cards** — `PhraseFill`, `VerseAtVerseRef`,
  `Recitation`, `Citation`, `Ftv`. Meta-location cards (`VerseInChapter` / `VerseInBook` /
  `VerseInHeading` / `VerseInClub`), the multi-verse pseudos (`HeadingPassage`, `ChapterClubList`),
  and `Reading` don't contribute. Net effect: a verse's stability tracks the worst of its
  content-card tests, and meta-card stability drifting around can't bounce a verse between dashboard
  stability buckets.
* Card-side helpers (`card_stability_histogram`, `due_review_count`) still count every card the user
  reviews — meta cards are real review work, just not signals of verse content recall.

## [0.2.1] — 2026-05-27

* `VerseRender.chapter_members: Vec<u16>` — additive field carrying the verse numbers a
  `ChapterClubList` pseudo-card asks about. Empty for real verses and other pseudos; the
  `emit_chapter_club_list_cards` builder populates it from the matching-tier members so consumers
  can render the back-of-card answer without a separate lookup. `#[serde(default)]` so older
  snapshot data still loads.

## [0.2.0] — 2026-05-26

Card-audit pass: drops the redundant no-citation FTV variant and introduces a passage-cued heading
prompt as the new primary heading test. The intermediate `0.1.1` bump (FTV-only) never shipped on
its own; both changes land together as `0.2.0`.

### Added

* `CardKind::HeadingPassage { heading_idx }` — composite card anchored to a pseudo verse_id whose
  `VerseAtoms.heading_members` lists every real verse in the heading's range. Grades each member's
  `VerseHeadingBinding` for the card's `heading_idx`, so the passage prompt shares FSRS state with
  the per-verse `VerseInHeading` cards rather than spawning parallel bindings.
* `VerseAtoms.heading_members: Vec<u32>` — the per-heading member list consumed by
  `HeadingPassage::tests`. Empty for real verses.

### Changed

* `MaterialConfig.headings: bool` is split into two independent toggles:
  * `heading_card: bool` (default **false**) — gates the per-verse `VerseInHeading` card. Defaults
    off because the passage-cued version is the primary heading test and the per-verse version is
    high-volume / low-signal for most learners. Old JSON with the legacy `headings` key deserializes
    into this field via a serde alias, so existing rows keep their preference.
  * `heading_passage_card: bool` (default **true**) — gates the new `HeadingPassage` card.
* Builder emits one `HeadingPassage` card per heading that covers at least one included real verse,
  ordered after the main verse loop and before `emit_chapter_club_list_cards` (pseudo-id allocator
  is shared and monotonic).
* Builder emits one `Ftv` card per FTV-eligible verse (always `with_citation: true`) instead of two.
  The no-citation variant was near-identical to its sibling on the prompt side — only the reveal
  differed — and `Recitation` already covers the recall-without-ref shape from the verse-text side.
  The `CardKind::Ftv { with_citation }` enum variant keeps its field for wire-format compatibility;
  existing `with_citation: false` cards in persisted state are unaffected but won't be re-emitted on
  rebuild.

## [0.1.0] — 2026-05-20 (baseline)

### Added

* Baseline freeze for first production deploy. Documents the current HSRS-state architecture:
  per-test FSRS state on per-verse atomic bindings, atomic + composite cards routed via
  `Card::tests()`, Bayesian-share decomposition of a single card grade across the card's contained
  tests.
* Canonical spec: `docs/path-posterior-memory-model.md`.
* Motivating audit (folded in pre-baseline): `docs/archive/audit-fsrs6-2026-04-28.md`.

Future entries will describe changes from this baseline.
