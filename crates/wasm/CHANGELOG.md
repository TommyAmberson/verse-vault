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
