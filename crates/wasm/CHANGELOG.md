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

### Added

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
