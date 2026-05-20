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

## [0.1.0] — 2026-05-20 (baseline)

### Added

* Baseline freeze for first production deploy. Documents the current HSRS-state architecture:
  per-test FSRS state on per-verse atomic bindings, atomic + composite cards routed via
  `Card::tests()`, Bayesian-share decomposition of a single card grade across the card's contained
  tests.
* Canonical spec: `docs/path-posterior-memory-model.md`.
* Motivating audit (folded in pre-baseline): `docs/archive/audit-fsrs6-2026-04-28.md`.

Future entries will describe changes from this baseline.
