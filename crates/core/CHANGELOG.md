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
