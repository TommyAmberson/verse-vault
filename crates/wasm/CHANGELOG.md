# Changelog — `verse-vault-wasm`

All notable changes to this crate are documented here, following
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## Why this changelog matters

`verse-vault-wasm` is the **wire-format contract** between the Rust core and every JavaScript
consumer (the Node API today; future browser fat client, Tauri, CLI). All cross-language JSON shapes
(`TestStateEntry`, `CardRenderWire`, `ElementId`, `TestKey`, `CardKind`, …) cross this boundary. A
version change implies consumers must rebuild against the matching wire format.

Bumps follow semver semantics:

* **MAJOR**: breaking change to a JSON shape any consumer depends on (renamed field, changed type,
  removed variant).
* **MINOR**: additive field or new exposed function that older consumers can ignore safely.
* **PATCH**: implementation or doc change with no observable wire-format effect.

The contract is documented in `docs/wasm-api.md`.

## [Unreleased]

## [0.7.0] — 2026-07-11

MAJOR bump — schedule editor redesign phase 6. Consumes `verse-vault-core@0.7.0`'s
`ScheduleWeek::blocks[]` shape end-to-end. `parse_schedule` now folds any legacy v1
`passage`/`verses` fields into `blocks[]` via `Schedule::normalize_v1_weeks` before the engine
constructor runs, so schedules serialised at rest as either v1 or v2 wire form both boot the same
engine.

Consumer effect: single-passage schedules behave identically to 0.6.0. Multi-passage weeks now
contribute refs from every block during Phase 1 memorize fill; under 0.6.0 the raw v2 wire form
silently degraded to a review-empty stub because the Rust struct had no `blocks` field.

### Wire format

No new WASM function surface — the `WasmEngine` constructor signature is unchanged. The change is
entirely in how `schedule_json` deserialises.

## [0.6.0] — 2026-06-14

MAJOR bump for the schedules + per-club settings rework (Phase 1). The `WasmEngine` constructor
signature changes — `desired_retention` is removed, `schedule_json` is added — and the per-club
`MaterialConfig` shape now flows across the wire. Pre-0.6.0 JS callers will not type-check or run
against this build; update the constructor call site (and the `memorize_session` call site when
ready, see below) when bumping consumers.

### `WasmEngine` constructor signature change

Old:

```ts
new WasmEngine(material_json, material_config_json, persisted_states_json, desired_retention, now_secs)
```

New:

```ts
new WasmEngine(material_json, material_config_json, schedule_json, persisted_states_json, now_secs)
```

* `desired_retention` is removed. Per-club retention now lives inside
  `MaterialConfig.review.{club}.desiredRetention`; the fallback for pseudo-verses with no tier is
  the engine's `ScheduleParams::default().target_retention` (0.9).
* `schedule_json` is new. Pass `""` to skip the schedule entirely — the memorize algorithm collapses
  to pure-Sequential canonical-order fill in that case, matching pre-0.6.0 behaviour. Otherwise it's
  a JSON `Schedule` matching the bundled `data/schedules/<deck>-<season>.json` shape from
  `crates/core@0.6.0`.

### `MaterialConfig` wire shape

The flat `(new_scope, review_scope, desired_retention)` triple is replaced by per-club `memorize`,
`review`, and a per-pair `move_to_next` gate. Legacy shape is still accepted on read via the
migration adapter — but new clients should emit the per-club shape directly to avoid the clamp on
legacy retention values above 0.9. See `crates/core@0.6.0`'s changelog for the field list and
migration semantics.

### New: `memorize_session_v2(limit, now_secs)`

* Schedule-aware two-phase canonical-order fill. Phase 1 picks `CalendarCascade` clubs' this-week
  primary verses, Phase 2 fills the rest from eligible clubs in canonical (deck) order. Returns the
  same `{ verses, orphans }` JSON shape `memorize_session` returns.
* `memorize_session(limit)` stays callable for one release as a deprecated wrapper — it invokes v2
  with `now_secs = 0`, which collapses gracefully when no schedule is supplied. The web client's
  call site switches in Phase 2 of the implementation train.

### Test scaffolding adjustment

* `parse_material_config("")` now returns `MaterialConfig::all_clubs_enabled(0.9)` instead of
  `MaterialConfig::default()`. The new default is the spec's Club-150-only shape, which would
  silently pause fixtures using `clubs: []` (resolves to `Full`). The TS API path always supplies a
  real per-club JSON for production users, so this branch is reached only in tests and the WASM
  smoke harness.

## [0.5.1] — 2026-06-11

### Fix `memorize_session` ignoring tier-scope

* `WasmEngine.memorize_session` was iterating the engine's card list and queuing any verse with at
  least one `New` unconditional card, regardless of whether the verse's tier was in `new_scope`. A
  verse in `Maintenance` status (its tier is in `review_scope` but not `new_scope` — e.g. Club 300
  when the user set "Memorize new verses" to **150**) keeps its cards built so already-memorized
  cards can still be reviewed, but its New cards must not enter the memorize queue. All three loops
  in `memorize_session` now share a precomputed `memorize_active_verses` HashSet:
  * The verse-anchor loop (originally surfacing John 1:6 in the reproduction).
  * The HP / CCL pseudo-card assignment loop — a CCL pseudo whose tier is in `review_scope` but not
    `new_scope` was leaking into `orphans` via the pending-pool overflow.
  * The conditional-orphan loop — Ftv / VerseInHeading / VerseInClub cards on a Maintenance verse
    (e.g. John 1:6's Ftv card) were the dominant residual leak even after the verse-anchor loop was
    gated. Matches what `schedule::next_memorize_card` and `schedule::new_card_count` have been
    doing per card all along.
* No wire-format change. Patch bump.

## [0.5.0] — 2026-05-28

Lockstep bump for `verse-vault-core@0.5.0` (per-card graduations). `WasmEngine.memorize_session`
reshapes to surface `HeadingPassage`, `ChapterClubList`, and orphan conditional cards as standalone
session items the web client walks through steps 1 / 2 / 3 of the memorize flow.
`WasmEngine.graduate_card` is exposed so those cards graduate independently of any `graduate_verse`
call. MAJOR per this changelog's rubric — `memorize_session`'s top-level shape changes from
`Entry[]` to `{ verses: Entry[], orphans: number[] }`, and HP/CCL ids no longer fold into
`Entry.cardIds`.

### Added

* `WasmEngine.graduate_card(card_id) -> bool` — exposes `ReviewEngine::graduate_card`. Returns
  whether the card transitioned `New → Active`. Idempotent.
* `memorize_session` `Entry.hpCardId` / `Entry.cclCardId: number | undefined` — the `HeadingPassage`
  / `ChapterClubList` card placed immediately after this verse in the reading walkthrough. Omitted
  (not `null`) when no card attaches here.
* `memorize_session` top-level `orphans: number[]` — standalone cards that don't anchor to a
  session-verse: HP/CCL overflow plus conditional verse-bound kinds (`Ftv`, `VerseInHeading`,
  `VerseInClub`) `New` on already-Active verses (deduped by `heading_idx` / `tier`). Each kind is
  capped at the call's `limit`, so a session with no fresh verses still honours the configured
  session max via orphans alone. Omitted when empty.

### Changed

* `memorize_session` returns `{ verses, orphans }` instead of a bare array.
* `memorize_session` `Entry.cardIds` no longer includes `HeadingPassage` or `ChapterClubList` ids;
  those live in `hpCardId` / `cclCardId`. Verse-bound conditional kinds on fresh session-verses
  still appear here (drilled alongside the verse), but graduate independently via `graduate_card`.
* `memorize_session` `verse_order` now only includes verses with at least one `New` unconditional
  verse-bound card. A verse whose only `New` cards are conditional orphans (post-settings-flip)
  doesn't anchor a session-verse; its cards distribute through the top-level `orphans` list.

## [0.4.0] — 2026-05-28

Lockstep bump for `verse-vault-core@0.4.0`. `WasmEngine.new_card_count` now delegates to the core
helper (same signature, tighter behaviour — filters out Maintenance-tier verses). No new exposed
methods on `WasmEngine`; wire shapes unchanged.

## [0.3.0] — 2026-05-28

Wrappers for the new `verse-vault-core@0.3.0` dashboard stats helpers. MINOR per this changelog's
own rubric ("additive field or new exposed function") — six new exposed `WasmEngine` methods. Older
consumers ignore the new methods safely.

### Added

* `WasmEngine.due_review_count(now_secs) -> u32` — count of active cards whose retrievability is
  below the scheduler's target. Drives the dashboard's "reviews waiting" number.
* `WasmEngine.card_stability_histogram() -> string` — JSON-serialised
  `{ weak, learning, familiar, strong, mastered }` count of active cards bucketed by weakest-test
  stability.
* `WasmEngine.verse_stability_histogram() -> string` — same shape, bucketed by the worst
  verse-content-card test stability per verse.
* `WasmEngine.new_verse_count() -> u32` / `WasmEngine.due_verse_count(now_secs) -> u32` /
  `WasmEngine.learned_verse_count(threshold_days) -> u32` — verse-footprint counts.

JSON-string returns for the histograms follow the existing pattern for structured values
(`export_test_states`, `memorize_session`). Verse-side methods exclude meta-location and multi-verse
pseudo cards per `verse-vault-core@0.3.0`'s `is_verse_content_card` filter.

## [0.2.1] — 2026-05-27

* `VerseRenderWire.chapterMembers: number[]` — additive wire field forwarding
  `VerseRender.chapter_members` from `verse-vault-core@0.2.1`. Populated on `ChapterClubList`
  pseudo-verses so JS clients can render the back-of-card list without a follow-up lookup; empty
  everywhere else.

## [0.2.0] — 2026-05-26

Bundles the previously-unreleased `all_card_renders` additions with the new `HeadingPassage` wire
variant. Ships alongside `verse-vault-core@0.2.0`.

### Added

* `CardKindWire::HeadingPassage { headingIdx }` — wire-format mirror of the new core
  `CardKind::HeadingPassage` variant. Composite passage card anchored to a pseudo verse whose atoms
  list every real verse in the heading; grades each member's `VerseHeadingBinding`. Additive; old
  consumers that match on `kind` will fall through their default branch on this variant (the API
  forwards the wire shape unchanged so the web client can route it).
* `next_memorize_card`'s pseudo-card placement is overhauled. `HeadingPassage` cards introduce when
  at least one heading member is "started" (Active or being graduated this session) and attach to
  the earliest such member; `ChapterClubList` cards introduce when every chapter+tier member is
  started and attach to the latest. When the trigger conditions are met purely from prior Actives —
  e.g. the user just enabled the per-passage card in settings after memorising the relevant verses —
  the card is attached as a catch-up to a session-verse with capacity. Each session-verse caps at
  one `HeadingPassage` and one `ChapterClubList` so a backlog spreads across `verse_order` instead
  of piling on the first verse. Replaces the previous "last member is the current verse" trigger
  which misfired when verses graduated out of order.
* `all_card_renders()` — returns `CardRenderWire[]` for every card in the deck in card-id order.
  Used by the API's bulk `GET /materials/:id/renders` endpoint to compose every card's HTML in one
  engine call. Additive; existing consumers ignore it.

### Changed

* `all_card_renders` panics (rather than silently skipping) on a card whose verse has no render
  data. The builder invariant says every card has render data; the previous `filter_map` would have
  delivered a partial deck to the offline-mode client with no signal if the invariant ever drifted.
  PATCH-level: wire shape unchanged, behaviour only differs on a path that never fires under the
  documented invariant.

* Native `all_card_renders_for_test` shim now returns `String` instead of `Result<String, String>` —
  matches the sibling `card_count_by_club_for_test`. The body has no fallible operations over
  plain-data wires; `unwrap` is honest.

## [0.1.0] — 2026-05-20 (baseline)

### Added

* Baseline freeze for first production deploy. Documents the current `WasmEngine` surface
  (constructor, `replay_event`, `next_review_card`, `next_memorize_card`, `get_card_render`,
  `export_test_states`, `graduate_verse`) and the serde-tagged JSON shapes for `TestKey`,
  `ElementId` (range-form `Phrase`), `CardKind`, `TestState`.

Future entries will describe wire-format or surface changes from this baseline.
