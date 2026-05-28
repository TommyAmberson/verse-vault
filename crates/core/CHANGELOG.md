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
