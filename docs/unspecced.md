# Unspecced features

Shipped behaviour with no design doc in `docs/`. Every entry below is live in production — this is a
documentation backlog, not a roadmap.

Everything here is a gap, not a disagreement: a feature shipped without a doc, rather than a doc
being contradicted by a decision. Where a doc and the code _do_ disagree, check the contract
changelogs first — `crates/{core,wasm}/CHANGELOG.md` record deliberate behaviour changes and will
usually say which side moved on purpose.

Some entries have **no coverage at all**. Others have **scattered mentions but no owning doc** — a
table in `persistence.md`, an endpoint in `server-api.md`, a route row in `web-nav.md`, and nothing
that explains the feature as a whole. Both need a spec; the second kind also needs the scattered
references pointed at it once one exists.

Compiled 2026-09-10 by auditing `docs/` against the tree. Delete an entry when its doc lands.

## Memorize schedules

The largest gap. A material can carry a season schedule that drives which verses become available
when, separately from FSRS due dates.

* **Surface:** `crates/core/src/schedule.rs`, `crates/core/src/schedule_data.rs`,
  `packages/api/src/lib/schedules.ts`, `packages/api/src/routes/schedules.ts`,
  `apps/web/src/views/ScheduleEditorView.vue`, route `/schedule/:materialId`, the
  `material_schedules` table (migration `0022`), and `data/schedules/*.json`
* **Coverage:** none. `docs/scheduling.md` is exclusively FSRS due-date scheduling and never
  mentions season schedules — the name collision is itself a trap
* **Nearest thing to a spec:** `docs/superpowers/specs/2026-06-14-schedules-and-settings-design.md`,
  now read-only history and predating the canonicalisation work in migration `0025`

## Rendering pipeline

How a card becomes displayable HTML: passage text, keyword markup, progressive reveal, heading and
FTV handling.

* **Surface:** `crates/core/src/render.rs`, `crates/core/src/content.rs`,
  `packages/api/src/lib/render.ts`, `GET /api/materials/:id/renders`,
  `GET /api/materials/:id/passages`
* **Coverage:** `docs/wasm-api.md` documents the render JSON shape at the boundary and
  `docs/session.md` covers progressive reveal within a session. Neither explains where the HTML
  comes from, how api.bible passages are cached and patched, or what the markup means

## Spelling dialects

NKJV text arrives in American spelling; the app substitutes British or Canadian forms on render.

* **Surface:** `packages/api/src/lib/spelling.ts` (VarCon `A.json`, A→B and A→C maps), applied in
  `composeRender` (`lib/render.ts`) and reached from the `cards` and `materials` routes
* **Configuration:** server-wide, not per-user. The `RENDER_DIALECT` env var (`index.ts:57-60`)
  selects one of `american` / `british` / `canadian`; `DEFAULT_DIALECT` is `canadian`. Nothing in
  `apps/web` exposes it
* **Coverage:** none anywhere in `docs/`
* **Worth capturing:** whether server-wide is the intended scope or a placeholder for a per-user
  setting; and the dialect rules themselves, which the code cannot explain — Canadian takes British
  `-our`, `-ence`, `-re` and doubled consonants but keeps American `-ize` verbs and `-or` agent
  nouns

## Club tiers

Club 150 / 300 / Full verse lists are described in the README as first-class, with their own
scheduling and membership drills.

* **Surface:** `data/*-tiers.json` (years 5, 6, 7 — transcribed from the QuizMeet booklet),
  `card_count_by_club`, per-tier target retention in `MaterialConfig`, club-list diffing in
  `apps/web/src/lib/diff/clubList.ts`
* **Coverage:** scattered. `docs/graph.md` mentions club tier as an element property,
  `docs/validation.md` references Club 150. `docs/decks.md` inventories every deck file but has no
  row for the `-tiers.json` files
* **Open question:** whether tier inventory belongs in `decks.md` or in a club-tier doc of its own

## Material config and scope toggles

Per-user, per-material switches for headings, FTV, and new/review/club/chapter-list scope.

* **Surface:** `crates/core/src/material_config.rs`, the `user_year_settings` table (per-club since
  migration `0023`), `POST /api/years/:materialId/settings`, `SettingsMaterialsView.vue`
* **Coverage:** `docs/wasm-api.md` describes the constructor argument and `docs/persistence.md` the
  table. No doc explains what each scope actually gates or how the toggles interact

## Offline mode

* **Surface:** `PATCH /api/materials/:id/offline-mode`, the IndexedDB cache and event queue in
  `apps/web`
* **Coverage:** mentioned in six docs, owned by none. `docs/test-scenarios.md` lists manual smokes
  for it and `docs/architecture.md` covers the sync protocol it rides on, but nothing states what
  offline mode enables, what it costs, or when a user would turn it on

## Activity feed

* **Surface:** `packages/api/src/routes/activity.ts`, `GET /api/activity`,
  `apps/web/src/lib/heatmap.ts`, the heatmap on `StatsView`
* **Coverage:** a row in `docs/web-nav.md`. The endpoint is absent from `docs/server-api.md`

## Account data export, import, and reset

* **Surface:** `packages/api/src/lib/{export,import,reset}.ts`, `export-format.ts`,
  `GET /api/export`, `POST /api/import`, `DELETE /api/account/progress`, reachable from
  `ProfilePickerView`
* **Coverage:** `docs/server-api.md` documents the three endpoints. The export format itself — what
  round-trips, what is deliberately dropped, how versions migrate — is unspecified
* **Nearest thing to a spec:**
  `docs/superpowers/specs/2026-05-29-account-data-management-design.md`, read-only history

## Card-id stability

Card ids are emission-index based, so a config change can renumber them and corrupt review history.

* **Surface:** `legacy_card_id_map` on the WASM engine, `packages/api/src/lib/card-ref.ts`,
  content-key translation in `data-migrations.ts`
* **Coverage:** none. This is a live correctness hazard with a known repair procedure and an open
  issue behind it; it deserves a doc rather than institutional memory

## Data-migrations framework

Server-side backfills that run once against user data, distinct from Drizzle schema migrations.

* **Surface:** `packages/api/src/lib/data-migrations.ts`, the `data_migrations` table (migration
  `0027`), backfills such as `0024_backfill_graduated_verses` and `0025_canonicalise_schedules`
* **Coverage:** none. `docs/persistence.md` covers the schema but not this mechanism

## Enrollment

* **Surface:** `packages/api/src/lib/enrollment.ts`, `POST /api/materials/enroll`, the
  `user_materials` table
* **Coverage:** the endpoint is in `docs/server-api.md`; the table is absent from
  `docs/persistence.md`. No doc covers what enrolling does to a user's graph and state

## Graduated cards vs graduated verses

Two separate tables and two separate endpoints, with no doc explaining why both exist.

* **Surface:** the `graduated_verses` and `graduated_cards` tables,
  `POST /api/cards/memorize/graduate` and `POST /api/cards/memorize/graduate-card`
* **Coverage:** `docs/persistence.md` documents `graduated_verses` only; `docs/server-api.md`
  documents the verse-level endpoint only
