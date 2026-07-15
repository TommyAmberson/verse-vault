# Changelog — `@verse-vault/api`

All notable changes to this package are documented here, following
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Released via `.github/workflows/deploy-api.yml` (rsync to VPS, atomic symlink-flip, restart
`verse-vault.service`) on every `version` bump in `packages/api/package.json` that lands on
`master`.

## [Unreleased]

## [0.1.33] — 2026-07-15

PATCH — ships the #107 scheduling fixes by bundling the new algorithm contract. No API-surface
change.

### Bundled algorithm contract

* `verse-vault-core@0.7.1` — relearn-lane per-test coldness gate (#107 A/B) and cooldown-aware
  `due_review_count` / `due_verse_count` (#107 C).
* `verse-vault-wasm@0.7.1` — no wire-format change.

### Fixed

* `/stats`'s `reviewsDueCount` and `versesDueCount` (via the bundled engine) no longer count
  cooldown-masked cards, so the "N to review" badge agrees with what a session will actually serve
  right after reviewing.

## [0.1.32] — 2026-07-15

PATCH — data repair for years predating the event-sourced graduation log (#111). No API-surface
change.

### Bundled algorithm contract

* `verse-vault-core@0.7.0` — unchanged.
* `verse-vault-wasm@0.7.0` — unchanged.

### Fixed

* Migration `0024_backfill_graduated_verses` inserts a `graduated_verses` row for every
  `(user, material, verse)` holding at least one **reviewed** `PhraseFromContext` test state. Years
  migrated from the pre-event-log flow carried test states but no graduation rows, so every card
  rebuilt as `New` and the year was silently unreviewable on both server and client engines (live
  case: `nkjv-cor`). Two conditions gate the evidence:
  * Kind: only the verse's own content cards emit `PhraseFromContext`; multi-verse kinds
    (`VerseHeading`/`VerseClub`) are excluded because HeadingPassage/ChapterClubList cards write
    rows carrying other verses' ids.
  * Reviewed, not merely seeded: `enrollUser` (and `rebuildFromEvents`) persist the engine's full
    test-state catalogue — pristine `TestState::new_unseen` rows (stability 1.0, difficulty 5.0, all
    timestamps at enrollment − 365 d) for every verse before the first review. Those exact seed
    signatures are excluded; FSRS never reproduces them on a graded row. Without this the backfill
    would graduate every verse of every enrolled material for every user.

  Existing graduation rows win (`ON CONFLICT DO NOTHING`); re-runs are no-ops; rows whose user was
  deleted out-of-band are skipped rather than aborting boot. Per-card graduations
  (`graduated_cards`) are not backfilled — affected HP/CCL/conditional cards resurface in the
  memorize queue and re-graduate organically.

## [0.1.31] — 2026-07-11

Phase 6 of the schedule editor redesign — WASM engine consumes v2 schedules natively. PATCH — no
externally-observable API change; persisted schedules that failed to load under 0.1.30 (multi-block
weeks) now boot the engine.

### Bundled algorithm contract

* `verse-vault-core@0.7.0` — MAJOR. `ScheduleWeek` swaps to `blocks: Vec<PassageBlock>`; algorithm
  reads across every block; Full-tier derivation is per-block.
* `verse-vault-wasm@0.7.0` — MAJOR. `parse_schedule` normalises v1 wire form (legacy
  `passage`/`verses` fields) into `blocks[]` before constructing the engine.

### Changed

* `EngineStore.load` and `EngineStore.rebuildFromEvents` pass schedule JSON verbatim to the WASM
  engine — the transitional `downgradeScheduleToV1WireFormat` helper is deleted.
* `packages/api/src/lib/schedules.ts` drops `downgradeScheduleToV1WireFormat`. Callers no longer
  need it — the WASM engine speaks v2 directly.

## [0.1.30] — 2026-07-11

Phase 2 of the schedule editor redesign — `PUT /api/materials/:id/schedule` now accepts a v2 payload
(`week.blocks: PassageBlock[]`) alongside the v1 wire form the bundled JSONs and existing user rows
still use. MINOR — additive shape acceptance, no engine or contract-crate change.

### Bundled algorithm contract

* `verse-vault-core@0.6.0` — unchanged.
* `verse-vault-wasm@0.6.0` — unchanged.

### Schedule v2 wire shape

* `validateSchedule` and the new `migrateSchedule` normalise any accepted wire version (1 or 2) onto
  a single v2 in-memory shape (`SchedulePayloadV2`, `ScheduleWeekV2`, `PassageBlock`). Review weeks
  carry `blocks: []`; normal weeks carry `blocks: [{ passage, verses }]`; NT-Survey-style compound
  weeks may carry `blocks.length ≥ 2` (accepted at the API boundary but rejected at the WASM engine
  boundary until Rust catches up in the redesign's phase 6).
* `downgradeScheduleToV1WireFormat` serialises a v2 schedule back to the v1 shape the WASM engine
  understands. `EngineStore.load` and `EngineStore.rebuildFromEvents` route persisted or bundled
  schedule JSON through it before handing anything to `new WasmEngine(...)`. Without this the raw v2
  shape would deserialise silently on the Rust side (serde ignores the unknown `blocks` field and
  treats each week as passage-less), silently degrading Phase 1 memorize fill.

### `validateSchedule` tightens Meet + passage validation

Shipped originally with apps/web 0.4.0 (Phase 3 schedule editor) and now paired with the v2
acceptance above. The user-customisable surface behind `PUT /api/materials/:id/schedule` field-
checks meets and per-week passages so a malformed editor payload can't reach disk.

* Meets: each entry must carry `id`, `name`, `startDate`, `endDate` as non-empty strings; dates are
  `YYYY-MM-DD` with sane month/day; `endDate >= startDate`; `id` unique within the schedule.
  `location` accepts empty/missing/"TBD" (the bundled schedules use both forms as placeholders).
* Per-week passage on non-Review weeks: `book` non-empty; `chapter`, `startVerse`, `endVerse`
  positive integers; `endVerse >= startVerse`. Closes a gap where the editor's de-review toggle
  could save zeroed placeholders the server silently accepted.

## [0.1.29] — 2026-06-15

`GET /api/years` now surfaces `perClub` (parsed `PerClubYearSettings`) alongside the legacy
`settings` field. The web client's Phase 2 chain UI reads it so user-customised `catchUp` and
`moveToNext` selections round-trip through a save → reload — values the lossy legacy-column collapse
can't carry. No client breaks: the existing `settings` field is unchanged.

### Bundled algorithm contract

* `verse-vault-core@0.6.0` — unchanged.
* `verse-vault-wasm@0.6.0` — unchanged.

## [0.1.28] — 2026-06-14

Phase 1 of the schedules + per-club settings rework. MINOR per this changelog's rubric — additive
endpoints, both-shape acceptance on existing endpoints, and a new disk-loaded resource (bundled
schedules) that older clients can simply ignore.

### Bundled algorithm contract

* `verse-vault-core@0.6.0` — `MaterialConfig` restructures from the flat
  `(new_scope, review_scope, desired_retention)` triple into per-club shapes (`memorize`, `review`,
  `move_to_next`). New `Schedule` data model
  * the two-phase canonical-order memorize fill. Per-verse retention threading through every
    scheduler entry point. MAJOR — pre-0.6.0 state shape no longer drives the engine directly (read
    through the serde-aliases migration adapter).
* `verse-vault-wasm@0.6.0` — `WasmEngine` constructor drops `desired_retention`, adds
  `schedule_json`. New `memorize_session_v2(limit, now_secs)` is the schedule-aware surface; legacy
  `memorize_session(limit)` stays as a deprecated wrapper for one release. MAJOR.

### New: `GET/PUT/DELETE /api/materials/:id/schedule`

Per-(user, material) memorize-schedule overrides. `GET` returns the user's customised schedule if
present, else the bundled default (`data/schedules/<deck>-<season>.json`), else
`{ schedule: null }`. `PUT` shape-validates and upserts, invalidates the engine cache. `DELETE`
drops the override; bundled default reapplies on the next request. Unknown `materialId` → 404;
missing auth → 401; malformed PUT body → 400.

### `POST /api/years/:id/settings` accepts the per-club shape

The route detects shape via the `looksLikePerClub` heuristic (presence of `memorize` or `review` at
the body root). Per-club shape: every field required, validated by `validatePerClubYearSettings`,
retention clamped to `[0.5, 0.9]`. Legacy flat shape: existing partial-merge semantics preserved,
retention still validates in the legacy `[0.7, 0.97]` range. Both paths dual-write — the legacy
columns stay authoritative for older clients while `config_json` carries the per-club shape the
engine reads.

### Per-club desired retention

Retention is now per-club, not per-material. The legacy `user_year_settings.desired_retention`
column survives as a mirror for backward compat with pre-Phase-1 clients; the engine reads
`config_json.review.{club}.desiredRetention` instead, with the [0.5, 0.9] clamp applied on read for
defence-in-depth.

### Schedules bundled per material

`data/schedules/<deck>-<season>.json` (gitignored alongside the deck JSONs themselves, whitelisted
via a `!data/schedules/*.json` rule). Phase 1 ships the SK 2025-26 1 & 2 Corinthians schedule
covering 24 of 27 active weeks plus all 3 meets. Multi-chapter weeks are stubbed as Review weeks
because Phase 1's `Schedule.Passage` model is single-chapter (the rest of the season's weeks fall
outside that limitation).

### Import / export round-trip the new fields

* `YearSettingsExport.configJson` — per-club shape carried verbatim through export and import. Older
  exports omit the field; the importer treats absent as null, preserving round-trip equality with
  pre-Phase-1 shapes.
* `ScheduleExport { scheduleJson, updatedAt }` — per-(user, material) schedule overrides. Optional
  on `MaterialExport`. Applied in STEP 1 of the three-step import transaction so engine.load() in
  STEP 2 picks up the imported schedule before the cardref index is built — preserves the
  apply-settings-before-cardref invariant from PR #95.

### DB

Two new migrations:

* `0022_material_schedules.sql` — new table keyed by `(user_id, material_id)` storing schedule
  overrides as a JSON blob, with an `idx_material_schedules_user` index.
* `0023_user_year_settings_per_club.sql` — adds the `config_json` column to `user_year_settings`,
  materialises it from the legacy flat columns via SQLite's `json_object()` per the spec's migration
  table. Legacy columns stay during transition; a future migration drops them once Phase 2's web UI
  ships.

## [0.1.27] — 2026-06-12

### Bundled algorithm contract

* `verse-vault-core@0.5.1` — adds the `ftv_words > 0` floor on FTV card emission (no zero-word
  prompts) and floors `elapsed` consistently across `FsrsBridge::update`'s retrievability blend so
  same-instant sub-updates no longer collapse stability to the ~365-day ceiling. PATCH-equivalent.
* `verse-vault-wasm@0.5.1` — `memorize_session` precomputes a `memorize_active_verses` HashSet and
  gates all three loops (verse-anchor, HP/CCL pseudo-card assignment, conditional orphan) against
  it, so Maintenance-tier verses no longer leak into the memorize queue via any path. No wire-
  format change.

### Apply imported settings before resolving cardRefs

* `applyAccountImport` (`lib/import.ts`) was building the cardRef index against the engine that
  `engines.load` returned BEFORE the imported settings were applied — the engine reflected the
  user's current `MaterialConfig`, while `applySettings` then wrote the imported settings inside the
  same transaction. The cardId universe is config-dependent (`builder.rs` gates Ftv / HeadingPassage
  / VerseInClub / etc. emission on `MaterialConfig` flags), so when the import flipped any of those
  flags, cardRefs either dropped to `unresolved` (FSRS history lost) or silently misrouted onto the
  wrong card. Split the transaction so settings + enrollment commit first, the engine cache
  invalidates, then a fresh `engines.load` builds the index against post- import settings before
  applying graduations + events.

### Reject out-of-range grades on `/api/import`

* `applyReviewEvents` (in `lib/import.ts`) wrote every imported event's `grade` straight into
  `reviewEvents` without bounds checking — `sync.ts`'s `validateUpload` and `cards.ts`'s review
  handler both gate grades to `{1, 2, 3, 4}`, but the import path didn't. An untrusted payload with
  e.g. `grade: 99` committed the poisoned row inside the import transaction, then crashed
  `engines.rebuildFromEvents` (which calls `engine.replay_event`, which returns a `JsError` on
  unknown grades). The import surfaced as a 500 and the bad row stayed in the database, wedging
  every subsequent sync or rebuild on the same `(user, material)` until manual DB intervention
  removed it. The import path now drops grades outside `1..=4` into `unresolved` instead.

### Tier cheap `/api/auth/*` reads onto the loose `authedTier`

* `GET /api/auth/get-session` and `GET /api/auth/multi-session/list-device-sessions` now route
  through the looser `authedTier` (120 req/min) instead of the tight `unauthedAuthTier` (10/min).
  The web client hits these on every app boot and every route navigation; treating them as
  credential-stuffing surface was tripping normal nav at single-digit refresh rates. Credential
  writes (sign-in, sign-up, password reset, OAuth callbacks, sign-out, multi-session state-change
  ops) keep the tight tier — that's the actual attack surface.
* Allowlist lives in `AUTH_LOOSE_PATHS` at the top of `middleware/observability.ts`. Update when
  Better Auth lands a new cheap-read endpoint.

### Rate-limit / CORS fixes that broke local dev usability

* **CORS headers now attach to 429 responses.** `cors()` was mounted _after_
  `observabilityMiddleware`, so when observability returned a 429 directly (skipping `next()`), the
  cors layer never ran — browsers saw a response with no `Access-Control-Allow-Origin` and surfaced
  it as a generic `NetworkError` instead of the real 429 + `Retry-After`. Reorder cors() outermost
  so its before-phase sets `Allow-Origin` on whatever response observability produces.
* **`ip:unknown` skips the bucket in dev.** Localhost requests carry neither `CF-Connecting-IP` nor
  `X-Forwarded-For`, so every unauthenticated request collapsed into one shared `ip:unknown` bucket
  — a single page refresh fired enough auth-public calls (router boot's `get-session`,
  `reconcileDeviceSessions` → `list-device-sessions`, the offline-banner's count fetch) to exhaust
  the tier and 429 everything that followed. New `rateLimitUnknownIp` option on
  `ObservabilityOptions` defaults to `process.env.NODE_ENV === 'production'`: prod still limits (a
  real request landing as `ip:unknown` is a misconfig or bypass attempt and gets defense-in- depth),
  dev passes the request through. Tests pin `rateLimitUnknownIp: true` in
  `TEST_DEFAULT_OBSERVABILITY` so existing rate-limit assertions keep firing.

## [0.1.26] — 2026-05-30

### Bundled algorithm contract

* `verse-vault-core@0.5.0` — unchanged.
* `verse-vault-wasm@0.5.0` — unchanged.

### Account progress reset endpoint

* **`DELETE /api/account/progress`** — wipes the caller's review events, graduations, and derived
  test states across every enrolled material, under the engine's per-key lock; keeps enrollments +
  per-year settings + the content snapshot. Idempotent; returns
  `{ materialsReset, eventsDeleted, graduationsDeleted }`. Backs the web "Delete all progress"
  action. Logic in `lib/reset.ts`, route in `routes/account.ts`.

Bundled algorithm contract unchanged. No wire-format break.

## [0.1.25] — 2026-05-29

### Bundled algorithm contract

* `verse-vault-core@0.5.0` — unchanged.
* `verse-vault-wasm@0.5.0` — unchanged.

### Account export / import + Anki bootstrap

Adds a versioned account portability format and an Anki bootstrap converter, so a new user can seed
years of memorization history into verse-vault from their existing `.colpkg` backup.

* **`AccountExport` v1** (`packages/api/src/lib/export-format.ts`) — single JSON payload covering
  the user row, every enrolled material, per-year settings, graduations, and the full review-event
  log. Cards key on `CardRef` (`kind` + verseId + params), not `cardId`, so an export from an older
  snapshot version can be replayed against the current one as long as the referenced verses still
  exist. HP / CCL use natural keys (`headingIdx`, `(book, chapter, tier)`) so external converters
  don't need to know the builder's synthetic pseudo-verse ids.
* **`GET /api/export`** — full account dump as `verse-vault-export-YYYY-MM-DD.json`. Walks every
  enrolled material, loads the engine to build the cardId↔CardRef index, then translates DB rows
  into the wire format.
* **`POST /api/import`** — accepts an `AccountExport`, returns an `ImportSummary` (events inserted /
  skipped via `clientEventId` dedup, graduations applied, unresolved cardRefs). Per-material
  transaction: a bad cardRef in one material doesn't poison another's writes. After each material's
  writes land, calls `EngineStore.rebuildFromEvents(key)` for that material (under the engine's
  per-key lock) so `test_states` regenerates from the now-augmented event log — no engine-state
  copying. Body capped at 50 MB via hono's `body-limit`.
* **Settings merge policy**: per-row `max(updatedAt)` wins. Locally-tuned settings aren't blown away
  by an older imported row, and re-import of the same payload is a no-op. Imported settings run
  through the same bound/enum validation as the `PUT /api/years/:id/settings` route (extracted to
  `lib/year-settings.ts`); an out-of-range value is rejected with a 400 rather than written
  verbatim.
* **`tools/anki_to_export.py`** — reads a `.colpkg`, maps the 3 Verse template ords to Citation /
  Recitation / Ftv, Heading notes to HeadingPassage, Key Verse List to ChapterClubList. Graduation
  rule (per spec): any Verse note with ANY of its 3 cards in Anki queue ≥ 2 graduates the verse;
  same rule for HP / CCL goes through `graduatedCards`, and the graduation timestamp is the earliest
  _passing_ review (not the first time the card was seen). `clientEventId` is
  `anki:<col-mod>:<revlog-id>` so re-running the converter is idempotent on import. Output uploads
  directly to `/api/import`.

Bundled algorithm contract unchanged. No wire-format break.

## [0.1.24] — 2026-05-29

### Bundled algorithm contract

* `verse-vault-core@0.5.0` — unchanged.
* `verse-vault-wasm@0.5.0` — unchanged.

### Structured request logging + in-memory rate limits

The API now ships an observability + rate-limit middleware. One unit handles both because they share
the same per-request context (who, what route, status, duration). About 150 lines of focused
middleware code instead of two separate ones.

* **Structured per-request log**: replaces Hono's built-in `logger()`. Emits one JSON line per
  non-OPTIONS request to stdout (captured into journald via the systemd unit). Shape:
  `{requestId, userId, ip, method, path, status, durationMs}` plus `error` on handler throws and
  `rateLimited: true` on 429s. See `docs/server-api.md` → "Request logging".
* **`X-Request-Id` on every response**: clients can quote it in support requests; handlers can read
  it from `c.get('requestId')` for cross-handler correlation.
* **Token-bucket rate limit** with two tiers:
  * Authed: 120 req/min for every route except the two below (env `RATE_LIMIT_AUTHED_PER_MIN`).
  * Unauthed `/api/auth/*`: 10 req/min (env `RATE_LIMIT_UNAUTHED_PER_MIN`). Defangs
    credential-stuffing loops without affecting normal review traffic.
  * `/health` exempt entirely.
  * Bucket key is the client IP (`CF-Connecting-IP` in production behind Cloudflare Tunnel).
* **`429` responses** carry `Retry-After: <ceil(secs)>` and the standard
  `{ "error": "Rate limit exceeded" }` body. The response flows back through `cors()` so browsers
  see a real 429, not a network error. CORS `exposeHeaders` now lists `Retry-After` and
  `X-Request-Id` so browser JS can read them.
* **Failed `/api/auth/sign-in/email` attempts still consume a token** — intentional brute-force
  protection.

In-memory state lives in a new `TokenBucketStore` (`packages/api/src/lib/rate-limit.ts`) bounded at
10 000 buckets with LRU eviction on insert. No periodic timer — sidesteps the `createApp`/test-leak
trap the `EngineStore.start()` follow-up fixed. No new npm dependencies. Single-instance only;
horizontal scale-out will need a shared store. NAT'd users currently share a bucket; per-user keying
is a follow-up.

Bundled algorithm contract unchanged. No wire-format break.

## [0.1.23] — 2026-05-29

### Bundled algorithm contract

* `verse-vault-core@0.5.0` — unchanged.
* `verse-vault-wasm@0.5.0` — unchanged.

### Backfill `user_year_settings.desired_retention` storage

Migration 0018 added `desired_retention REAL DEFAULT 0.9 NOT NULL` to `user_year_settings`. SQLite's
`ALTER TABLE ADD COLUMN` doesn't physically write the DEFAULT into rows that pre-existed the
migration — the default is applied at SELECT time. `PRAGMA integrity_check` flags those rows as NOT
NULL violations even though every SELECT returns 0.9, and
`UPDATE ... WHERE desired_retention IS NULL` matches nothing (the WHERE clause evaluates against the
read-time value).

Discovered by the freshly-added `deploy/restore-drill.sh` (PR #79) running `integrity_check` against
a B2 restore. Live prod had four such rows. The restore chain itself was fine — the bug was in
physical storage all along, and the drill surfaced it.

* **Migration 0021** (`0021_backfill_desired_retention_storage`):
  `UPDATE user_year_settings SET desired_retention = COALESCE(desired_retention, 0.9)`. The COALESCE
  goes through the write path, rewriting storage with a literal 0.9 even though the read-side
  already returned 0.9 from the DEFAULT.
* No code change. The schema-side `NOT NULL DEFAULT 0.9` was already correct; the data just needed
  to catch up.

Bundled algorithm contract unchanged. No wire-format break.

## [0.1.22] — 2026-05-29

### Bundled algorithm contract

* `verse-vault-core@0.5.0` — unchanged.
* `verse-vault-wasm@0.5.0` — unchanged.

### Drop duplicated `material_data` BLOB from `graph_snapshots` (closes #16)

`graph_snapshots.material_data` stored a per-user copy of the bundled JSON the engine builds against
— for a deck like `nkjv-cor` (~150 KB per row), every enrolled user duplicated the same blob in
SQLite. At ~10 KB users × ~3 enrollments × 150 KB ≈ 4 GB of duplicated rows once we're at year-2
scale.

Replaces the column with a `content_sha` TEXT carrying the SHA-256 hex digest of the bundled JSON
the snapshot was created against. The actual materialData lives on disk (`data/<materialId>.json`)
and is loaded fresh on every `EngineStore.load` via the existing `getMaterialJson(materialId)`. The
DB only tracks which content version each user is on; the disk file is the single source of truth.

* **Migration 0020** (`0020_drop_snapshot_material_data`) creates a new `graph_snapshots` table
  without the BLOB column, copies existing rows over with
  `content_sha = 'pre-content-sha-migration'` as a placeholder (SQLite has no native SHA-256, so we
  backfill in code on first load), then swaps and rebuilds the indexes.
* **First-load bump-on-load** populates the real SHA for every pre-migration row. The next request
  for each enrolled (user, material) detects the placeholder mismatch, inserts a new
  `graph_snapshots` row with `version+1` and the real `content_sha`, and the user proceeds normally.
  Engine state (test_states, graduations) is untouched.
* **`/state` response shape unchanged** — `materialData` is still ferried to clients, just now
  loaded from disk in the route handler rather than from the DB row.
* **`EngineStore.rebuildFromEvents`** now sources its materialJson from disk too, which means it
  inherently replays against current content. `adaptElement` still handles known structural
  transforms (legacy positional `Phrase` → word-range).
* **No wire-format break.** Clients see no change.

### What's still deferred from #16

* **Background full-event-log replay** for the case where `adaptElement` can't map an old element to
  a new one. In practice the phrase splitter's edits are range-based and already migrate cleanly;
  heading-boundary or club-tier edits would lose state on affected verses (user re-grades). Not
  worth building until that case actually surfaces.

## [0.1.21] — 2026-05-29

### Bundled algorithm contract

* `verse-vault-core@0.5.0` — unchanged.
* `verse-vault-wasm@0.5.0` — unchanged.

### Drop full-catalog `export_test_states` on the review-write path (closes #15)

`POST /api/cards/review` and the in-order branch of `POST /api/sync/:materialId/events` previously
called `engine.export_test_states()` after each `replay_event`, parsed the full per-(user, material)
test-state catalog, then filtered to the handful of tests actually touched — just to decide which
rows to upsert. For a real deck (~6 000 test_states on `nkjv-cor`) that's ~6 000 entries serialised
on the WASM side, ferried across the bindgen boundary, and re-parsed in JS — every single review,
for ~5 rows of actual change.

`WasmEngine.replay_event` already returns the post-update state for each touched test on the wire
(`TestUpdateWire.after` includes `pending_relearn`, courtesy of `wasm-bindgen`'s serde derive). Read
it directly:

* New `changedStatesFromUpdates(updates: TestUpdateWire[]): TestStateEntry[]` helper in
  `lib/engine.ts` maps the updates straight to `TestStateEntry[]` for `writeTestStates`.
  Last-write-wins on duplicate test keys (matters for `sync.ts` which can replay several events
  hitting the same test in one lock callback) — same result the prior export-then-filter would have
  produced.
* `cards.ts` POST `/review` and `sync.ts` POST `/events` (in-order path) use the new helper.
* `sync.ts` still serialises the full catalog **once** per in-order request for the response payload
  (thin clients wholesale-replace their cache); cutting that requires a wire-shape change and is out
  of scope here. cards.ts has no equivalent response export, so its hot path is now fully free of
  the full-catalog serialise. Sync goes from two full exports per in-order request to one.
* The rebuild path in `sync.ts` and `engine.ts` still calls `export_test_states` — it's
  reconstructing state from the full event log, so a full export is correct there.

Bundled algorithm contract unchanged. No wire-format break (the field was already there).

## [0.1.20] — 2026-05-29

### Bundled algorithm contract

* `verse-vault-core@0.5.0` — unchanged.
* `verse-vault-wasm@0.5.0` — unchanged.

### EngineStore eviction (closes #13)

`EngineStore.cache` was an unbounded `Map` — every (user, material) pair ever loaded stayed resident
until process restart, holding a Rust-side `WasmEngine` whose heap the JS GC can't reclaim. Fine at
single-dev scale, monotone RAM growth at multi-user scale.

* **LRU cap** (default 128 entries). On cache insert with the cap reached, the entry with the oldest
  `lastUsedAt` is evicted to make room. Cache hits bump `lastUsedAt` so the recently-used set
  survives pressure.
* **Idle TTL** (default 7200 s = 2 h). A background reaper walks the cache every
  `reaperIntervalSecs` (default 60 s) and evicts entries idle past the TTL. 2 h is long enough to
  bridge a within-visit pause (lunch break between memorize and review) and short enough to clean up
  between typical inter-visit gaps (~12 h for once-a-day users).
* **Refcounted handles + deferred `free()`.** `EngineStore.load()` returns a `Disposable`
  `LoadedEngine`; route handlers bind it with `using` so dispose fires at scope exit and the cache
  entry's refcount drops. `drainPendingFree` only calls `engine.free()` when refcount is zero AND
  the 30 s grace period has elapsed — the refcount pin guarantees correctness even if a handler
  stashes a handle across a slow `await` (api.bible fetch), and the grace period catches any code
  path that escapes the `using` contract by mistake. New `tryLoad(key)` returns `null` instead of
  throwing `NotEnrolledError`, which composes with `using` more naturally than the prior try/catch
  pattern.
* **Reaper lifecycle**: `EngineStore.start()` is called from `src/index.ts` (production entry
  point), not `createApp`, so tests using `createTestApp` don't accumulate one `setInterval` per app
  instance. `createApp` returns `{ app, engines }` so the entry point can reach the store.
  `.unref()` on the timer keeps SIGTERM exits clean even without an explicit `stop()`.

User-visible effect: none. An evicted user's next request rebuilds the engine from disk state via
the existing cold-load path (~50 ms). At launch scale this prevents the "server lasts a day before
needing a restart" failure mode; at single-dev scale it's invisible.

## [0.1.19] — 2026-05-28

### Bundled algorithm contract

* `verse-vault-core@0.5.0` — `graduate_verse` narrows to the unconditional verse-bound kinds; new
  `graduate_card` flips a single card. HP, CCL, and conditional verse-bound kinds graduate per-card
  now. Existing event replay produces a different end state for previously transitively-graduated
  cards (they revert to New and re-surface in the next memorize session).
* `verse-vault-wasm@0.5.0` — `memorize_session` returns `{ verses, orphans }`; HP/CCL ids surface
  via `hpCardId` / `cclCardId` on each verse-entry instead of `cardIds`; orphan conditional cards
  live in the top-level `orphans` list (per-kind cap = `limit`). New `WasmEngine.graduate_card`
  export.

### Per-card graduations

New `graduated_cards` table (migration `0019_graduated_cards`) backs the per-card graduation path.
`graduate_verse` flips only the unconditional verse-bound kinds (per `verse-vault-core@0.5.0`); HP,
CCL, and the conditional verse-bound kinds (Ftv, VerseInHeading, VerseInClub) graduate via the new
path.

* **Engine load + rebuild** replay both tables: `graduate_verse` from `graduated_verses` then
  `graduate_card` from `graduated_cards`. Existing data with conditional kinds previously flipped
  transitively reverts on load — those cards surface as orphans in the next memorize session and
  graduate explicitly.
* **`POST /api/sync/:materialId/events`** accepts a new event kind:
  `{ kind: 'graduateCard', cardId }`. Same client-event-id dedup, same `accepted` / `duplicates`
  accounting as `graduate`.
* **`GET /api/sync/:materialId/state`** gains `graduatedCardIds: number[]` alongside the existing
  `graduatedVerseIds`, so fat clients can replay both paths after a fresh build.
* **`POST /api/cards/memorize/graduate-card`** — single-card-graduation endpoint for the web
  client's standalone HP / CCL / orphan items. Mirrors `/memorize/graduate`'s response shape
  (`{ graduated: boolean }`).

### Per-(user, material) target retention

`user_year_settings` gains a `desired_retention` REAL NOT NULL DEFAULT 0.9 column (migration
`0018_user_year_desired_retention`). `EngineStore.load` reads the per-row value and passes it to
`new WasmEngine(..., retention, ...)` instead of the previously hardcoded
`DEFAULT_DESIRED_RETENTION` 0.9. `GET /api/years` returns the value in `settings.desiredRetention`;
`POST /api/years/:materialId/settings` accepts it (bounded [0.7, 0.97] — FSRS-author recommended
range, above 0.97 explodes review count, below 0.7 lets too much fade). The settings endpoint
already invalidates the cached engine on save, so saved changes take effect on the next request.

## [0.1.18] — 2026-05-28

### `GET /api/activity` — daily review + memorize counts

New endpoint returning per-day UTC aggregates of `review_events` (the "reviews" series) and
`graduated_verses` (the "memorize" series), capped at 1825 days (~5 academic years). Drives the
dashboard's new activity heatmap. Both series are sparse (no-activity days omitted); the client
zero-fills the calendar grid. Authenticated users only. Bundled algorithm contract unchanged
(`verse-vault-core@0.4.0`, `verse-vault-wasm@0.4.0`).

## [0.1.17] — 2026-05-28

### `/api/stats/:materialId` payload reshaped for the dashboard

* **`testDistribution` → `cardDistribution` + `verseDistribution`.** The old field counted raw
  test_states — an engine-internal unit users don't think in. The new pair counts cards (per active
  card, bucketed by weakest-test stability) and verses (per single-verse-card verse, same
  min-aggregation).
* **`reviewsDueCount`, `newVerseCount`, `versesDueCount` added.** Card-side and verse-side
  footprints of the review and memorize queues — drives the dashboard's "X cards from Y verses"
  pairing in both heroes.
* **`versesLearned` semantics tighten.** Engine-derived too; only verses whose weakest verse-content
  card test is at familiar+ stability count. Meta-location cards and the multi-verse pseudos no
  longer contribute.

### Engine instead of SQL for every per-verse number

The route now loads the per-material engine and asks it for every per-verse aggregate
(`learned_verse_count`, `verse_stability_histogram`, `new_verse_count`, `due_verse_count`) and both
card-side histograms (`card_stability_histogram`, `due_review_count`). The previous SQL queries
couldn't tell a real verse from a `HeadingPassage` / `ChapterClubList` pseudo (whose `verse_id` is
shared across multiple real verses), so a deck with passage cards inflated every verse count by one
per pseudo. Engine-side, `CardKind` discriminates. `EngineStore.load` is cached per (user, material)
so subsequent dashboard renders pay the load cost once.

### Memorize queue honours per-tier `new_scope`

The engine now filters `Maintenance`-tier verses out of `new_card_count`, `next_memorize_card`, and
`new_verse_count` (which the api forwards via `getYears().newCardCount` and `/api/stats`'s
`newVerseCount`). Already-graduated cards in Maintenance tiers stay reviewable; only their
never-graduated siblings stop being introduced. No api-side code change — the behaviour follows from
bundling `verse-vault-core@0.4.0`.

### Bundled algorithm contract

* `verse-vault-core@0.4.0` — adds the dashboard stats helpers and the runtime per-tier scope filter
  (`ReviewEngine.material_config` + `verse_status` + `verse_active_for_memorize`).
* `verse-vault-wasm@0.4.0` — exposes the matching `WasmEngine` wrappers.

## [0.1.16] — 2026-05-27

### Bundled algorithm contract

* `verse-vault-core@0.2.1` — adds `VerseRender.chapter_members` carrying the verse numbers a
  `ChapterClubList` pseudo-card asks about. Required server-side so the API actually sends the field
  on the wire; without redeploying the API, the web 0.1.15 ChapterClubList back-of-card list would
  render as an em-dash.
* `verse-vault-wasm@0.2.1` — forwards the new field on `VerseRenderWire`.

## [0.1.15] — 2026-05-26

### Added

* **Heading config split + new `HeadingPassage` card kind.** The `user_year_settings.headings`
  column is renamed to `heading_card` (controls the per-verse `VerseInHeading` "which heading is
  this verse in?" prompt), and a new `heading_passage_card` column gates the new per-heading
  `HeadingPassage` "what heading is this whole passage under?" card. Migration
  `0017_heading_card_split` UPDATE-resets every existing row's `heading_card` to 0 — the per-verse
  card is now opt-in, and the design intent is "everyone starts on the new defaults; re-enable
  per-verse from settings if you specifically want it." `heading_passage_card` defaults to 1 (on) as
  the primary heading test in the new design.
* `POST /api/years/:materialId/settings` accepts the two new keys (`headingCard`,
  `headingPassageCard`) on the request body; both default unchanged when omitted. The legacy
  `headings` key is no longer accepted — clients must send the renamed field.
* `engine.ts`'s `readMaterialConfigJson` serializes the two fields to the Rust core, which has
  consumed the new shape since `verse-vault-core@0.2.0`.

### Bundled algorithm contract

* `verse-vault-core@0.2.0` — new `CardKind::HeadingPassage` variant, split `headings` →
  `heading_card` + `heading_passage_card` on `MaterialConfig`.
* `verse-vault-wasm@0.2.0` — adds `CardKindWire::HeadingPassage`; reworks pseudo-card session
  placement so `HeadingPassage` introduces when any heading member is started (earliest such member
  as attach point) and `ChapterClubList` introduces when every chapter+tier member is started
  (latest as attach point), with one-per-kind-per-verse capping and catch-up attachment for trigger
  conditions met purely from prior Actives.

## [0.1.14] — 2026-05-25

### Changed

* **Aligned `better-auth` with the web client** (`^1.2.0` → `^1.6.5`). The web has been on 1.6.5
  since the offline-boot work; running mismatched majors on the wire surface was working only
  because the multiSession plugin happens to be stable across 1.2 → 1.6. Bumping closes the drift
  before the next plugin-affecting change hits a peer-dep surprise. No behaviour change expected;
  full test suite green on the bumped version.

### Bundled algorithm contract

* `verse-vault-core@0.1.0` — unchanged
* `verse-vault-wasm@0.1.2` — unchanged

## [0.1.13] — 2026-05-25

0.1.12's deploy failed because the multi-session entry stayed under `[Unreleased]` instead of being
promoted to a dated section (`tools/check-contract-versions.sh --ci` requires the dated section to
exist for the current `package.json` version). Code has been on master since `1ea3265`; production
goes straight from 0.1.11 → 0.1.13, bundling the changelog-promotion fix with the multi-session
entry that was supposed to ship in 0.1.12.

### Added

* **Better Auth `multiSession` plugin.** Lets one device hold cookies for several signed-in accounts
  at once. Stacks a new session cookie on each sign-in rather than replacing the previous one;
  exposes `/api/auth/multi-session/list-device-sessions`, `/api/auth/multi-session/set-active`, and
  `/api/auth/multi-session/revoke` for the picker to enumerate, swap, and individually revoke
  per-account sessions. No schema changes (existing `session` table already keyed by `token`). Older
  clients that don't know about multi-session keep working — they just see whichever single session
  the plugin reports as active.

### Bundled algorithm contract

* `verse-vault-core@0.1.0` — unchanged
* `verse-vault-wasm@0.1.2` — unchanged

## [0.1.11] — 2026-05-22

0.1.10's deploy failed because the offline-mode entries stayed under `[Unreleased]` instead of being
promoted to a dated section (the contract-version check requires the dated section to exist for the
current `package.json` version). Code has been on master since `d2f58876`; production goes straight
from 0.1.9 → 0.1.11, bundling the changelog-promotion fix with the Tauri origin allowlist.

### Added

* **Bulk renders endpoint.** `GET /api/materials/:materialId/renders` returns a JSON array of
  `{ cardId, composed, fetchedAt }` for every card in the deck. Gated on the new
  `user_materials.offline_mode` flag (403 when off — the MAUA bulk-extraction clause has wire-format
  teeth here; this is the only path a client can legitimately fetch the whole deck at once). Uses
  the new `WasmEngine.all_card_renders()` to compose every card in one engine call, grouped by
  (book, chapter) so the apibible cache is hit once per chapter regardless of card count. Each
  card's `fetchedAt` is the bulk-download timestamp; the client anchors its 30-day TTL there.
* **Offline-mode toggle.** `PATCH /api/materials/:materialId/offline-mode` flips
  `user_materials.offline_mode` (boolean body field `offlineMode`). Returns 404 for unenrolled, 400
  for non-boolean bodies. `GET /api/materials/:materialId/status` and the `/api/years` payload both
  now include the current value so the client can hydrate UI without an extra round-trip.
* **Response compression.** Hono's built-in `compress` middleware on every route. Honours
  `Accept-Encoding`, so the test harness (which doesn't send the header) keeps seeing raw JSON for
  body assertions. Drops the bulk renders payload for `nkjv-cor` from ~5 MB to ~1 MB.
* **Tauri origin allowlist.** CORS allowlist and Better Auth `trustedOrigins` accept
  `tauri://localhost` (macOS / Linux WebKit) and `https://tauri.localhost` (Windows Edge WebView2 +
  `useHttpsScheme: true`). Lets the desktop shell hit the same API as the web app for email +
  password sign-in and sync. Google OAuth follows qzr-sheet's working pattern (no special
  `redirectURI` override needed — Better Auth's defaults handle the cross-origin cookie bounce
  through the API's own callback URL); not end-to-end smoke-tested against verse-vault in this
  release, will validate during real desktop usage.

### Fixed

* CI: `deploy-api.yml`'s "Tag release" step did `git rev-parse "$tag"` against the local clone to
  decide whether to push. `actions/checkout@v4` doesn't fetch tags by default, so existing remote
  tags (e.g. `core@0.1.0` from prior deploys) looked missing — the step tried to push them and the
  remote rejected as duplicates, even though the deploy itself succeeded. Added
  `git fetch --tags --quiet origin` at the top of the step. Cosmetic in 0.1.9 (the deploy was fine;
  only the tag step went red); prevents the false-red on every future deploy.

### Bundled algorithm contract

* `verse-vault-core@0.1.0` — unchanged
* `verse-vault-wasm@0.1.2` — adds `all_card_renders()`; tightens its invariant from silent-skip to
  panic on missing verse render data

## [0.1.9] — 2026-05-21

### Fixed

* CI: `deploy-api.yml`'s `pnpm install --frozen-lockfile` failed at the "Bundle API for deploy" step
  with `ERR_PNPM_WORKSPACE_PKG_NOT_FOUND` because apps/web (resolved as part of the workspace)
  depends on `verse-vault-wasm-web@workspace:*`, and the bundler wasm-pack output at
  `crates/wasm/pkg-web/` is gitignored — not built before install ran. Mirror the deploy-web
  pattern: build both wasm-pack targets (nodejs + bundler) before `pnpm install`. 0.1.8's deploy
  never reached the VPS; 0.1.9 is the first successful deploy of the fat-client sync-protocol
  extensions documented in 0.1.8's entry below.

### Bundled algorithm contract

* `verse-vault-core@0.1.0` — unchanged from 0.1.8 (CI-only fix)
* `verse-vault-wasm@0.1.0` — unchanged from 0.1.8 (CI-only fix)

## [0.1.8] — 2026-05-21

### Added

* **Kinded sync events.** `POST /api/sync/:materialId/events` now accepts a discriminated event
  union: `{ kind: 'review', cardId, grade }` or `{ kind: 'graduate', verseId }`. Untyped events
  default to `kind: 'review'` so existing online-review callers keep working unchanged. Graduate
  events route through `engine.graduate_verse()` + a `graduatedVerses` upsert in the same
  transaction as the review-event log writes — closes the graduate-while-offline hole the previous
  thin-client `POST /api/cards/memorize/graduate` route was the only path for.
* **Out-of-order rebuild.** When a batch arrives with `timestampSecs` earlier than what's already
  applied for the same card, the server now triggers `EngineStore.rebuildFromEvents`: drops the
  cached engine, instantiates a fresh one from baseline, applies all graduations, replays every row
  in `reviewEvents` in `(timestampSecs, clientEventId)` order, and writes the resulting `testStates`
  back atomically. Response gains a `rebuilt: boolean` field so multi-device clients can replace
  their local state wholesale instead of merging. Fixes silent FSRS drift for any user with
  phone+laptop offline review sessions that synced in the "wrong" order.
* **Stale-merge preflight.** When a batch's oldest event predates more than 10 already-applied
  server events (`STALE_MERGE_THRESHOLD`), the response is a `{ needsConfirm: true, staleSummary }`
  envelope instead of an immediate merge. Client re-POSTs with `confirmMerge: true` to proceed.
  Stops months-old offline reviews from silently dragging FSRS stability down on accounts the user
  has continued to study elsewhere.
* **Clock-skew guard.** Events with `timestampSecs > server_now + 24h` are rejected with 400. A
  device with a broken RTC could otherwise wedge the user's timeline arbitrarily — the rebuild path
  would replay those events at year-2099 positions.

### Fixed

* Sync POST handler now wraps the `db.transaction` in try/catch and calls
  `deps.engines.invalidate(key)` on failure. The handler calls `engine.replay_event` /
  `engine.graduate_verse` BEFORE the transaction, so a SQLite write failure used to leave the cached
  engine ahead of `reviewEvents` + `graduatedVerses` until process restart. Real impact is small
  (production SQLite writes rarely throw, and `graduatedVerses` inserts are `onConflictDoNothing`),
  but the divergence was real and self-healing only across restarts.

### Documentation

* MAUA reference URLs (`docs.api.bible/guides/terms-of-use` → 404) replaced with the canonical
  `api.bible/terms-and-conditions#acceptable_use` clause across the schema comment, cache class
  docstring, render.ts header, `docs/persistence.md`, and `tools/README.md`.
* `EngineStore.rebuildFromEvents` ordering rationale corrected: `replay_event` is
  lifecycle-agnostic; graduations run first for parity with `EngineStore.load` (which also
  constructs the engine then applies graduations), not because `replay_event` requires Active state.
* New `NOTICE.md` carries the NKJV citation in the Starter-plan canonical form, plus the API.Bible
  attribution surface. `README.md` gains a "Third-party content" section pointing at it.

### Bundled algorithm contract

* `verse-vault-core@0.1.0` — unchanged from 0.1.7 (sync-protocol additive; no core changes)
* `verse-vault-wasm@0.1.0` — unchanged from 0.1.7 (same)

## [0.1.7] — 2026-05-21

### Fixed

* Structural deck JSONs (`data/[0-9]-*.json`) weren't reaching production. `pnpm deploy` only
  packages files under the API workspace, but the decks live at the repo root, so the bundled
  `<root>/data/<deck>.json` path resolved to `/opt/data/<deck>.json` on the VPS — a directory that
  doesn't exist. Auto-enrollment via `POST /api/years/:materialId/settings` then threw
  `Unknown material: <id>` for every deck without an inline fixture (which is all of them except
  `nkjv-cor`), surfacing as a 500. Fix is two-part: the deploy workflow now copies the deck JSONs
  into `<bundle>/data/` after `pnpm deploy`, and `materials.ts` searches the bundle-local dir first
  with a repo-root fallback so dev keeps working.

### Bundled algorithm contract

* `verse-vault-core@0.1.0` — unchanged from 0.1.6 (deploy-packaging fix)
* `verse-vault-wasm@0.1.0` — unchanged from 0.1.6 (deploy-packaging fix)

## [0.1.6] — 2026-05-21

### Fixed

* `trustedOrigins` and the Hono CORS allow-list both compared the configured `WEB_BASE_URL` verbatim
  against the browser's `Origin` header. In production `WEB_BASE_URL` is
  `https://www.versevault.ca/vv` (with subpath), but the browser always sends Origin as
  scheme+host+port only (`https://www.versevault.ca`). The mismatch would have 403'd every POST
  through Better Auth once the path issues were fixed — strip the path from `env.webOrigin` at the
  comparison sites so the equality holds.
* Pin Google OAuth's `redirectURI` to `${env.baseUrl}/api/auth/callback/google`. Better Auth's
  default redirect URI is `${baseURL}/callback/google`, which with our stripped origin-only
  `baseURL` resolves to `https://<origin>/callback/google` — missing `/api/auth/` and routed to the
  sibling qzr-api Worker instead of vv-router. The explicit override matches the URL `provision.sh`
  already tells users to register in the Google OAuth client.

### Bundled algorithm contract

* `verse-vault-core@0.1.0` — unchanged from 0.1.5 (auth-only fix)
* `verse-vault-wasm@0.1.0` — unchanged from 0.1.5 (auth-only fix)

## [0.1.5] — 2026-05-21

### Fixed

* 0.1.4's `basePath: '/api/auth'` option turned out to be a no-op for path matching — Better Auth's
  request router derives the match prefix directly from `new URL(baseURL).pathname`, ignoring the
  `basePath` option in this code path. With production `baseURL = https://www.versevault.ca/vv`, the
  match prefix became `/vv` and every incoming `/api/auth/*` request still 404'd. Pass just
  `new URL(env.baseUrl).origin` (i.e. drop the `/vv` path component) to Better Auth so the match
  prefix is empty and `/api/auth/*` is matched directly.

### Bundled algorithm contract

* `verse-vault-core@0.1.0` — unchanged from 0.1.4 (auth-only fix)
* `verse-vault-wasm@0.1.0` — unchanged from 0.1.4 (auth-only fix)

## [0.1.4] — 2026-05-20

### Fixed

* Better Auth's path matcher derived its basePath from `baseURL`, which in production is
  `https://www.versevault.ca/vv` (the SPA-facing URL). The Tunnel-fronted API actually receives
  requests at `/api/auth/*` (vv-router strips the `/vv` prefix before forwarding), so the derived
  match path `/vv/api/auth/*` never matched and every `/api/auth/*` request 404'd. Pinned
  `basePath: '/api/auth'` explicitly so the match is independent of `baseURL`'s path component.

### Bundled algorithm contract

* `verse-vault-core@0.1.0` — unchanged from 0.1.3 (auth-only fix)
* `verse-vault-wasm@0.1.0` — unchanged from 0.1.3 (auth-only fix)

## [0.1.3] — 2026-05-20

### Fixed

* CI: `pnpm deploy` in v10 now requires `--legacy` flag (or the `inject-workspace-packages=true`
  setting). Added `--legacy` to the bundle step. 0.1.3 is the first successful API deploy to the
  VPS.

### Bundled algorithm contract

* `verse-vault-core@0.1.0` — unchanged from 0.1.2 (CI-only fix)
* `verse-vault-wasm@0.1.0` — unchanged from 0.1.2 (CI-only fix)

## [0.1.2] — 2026-05-20

### Fixed

* CI: same `pnpm/action-setup@v4` version-conflict fix as the other deployables. 0.1.2 is the first
  successful API deploy to the VPS.

### Bundled algorithm contract

* `verse-vault-core@0.1.0` — unchanged from 0.1.1 (CI-only fix)
* `verse-vault-wasm@0.1.0` — unchanged from 0.1.1 (CI-only fix)

## [0.1.1] — 2026-05-20

### Added

* First production deploy to the verse-vault API host (VPS, fronted by Cloudflare Tunnel).
* Hono + Better Auth + Drizzle + better-sqlite3 stack on Node 22.
* Route groups under `/api/`: `cards`, `sync`, `materials`, `years`, `stats`, plus `/api/auth/*`
  (Better Auth) and `/health`.
* HSRS engine via `verse-vault-wasm` (per-test FSRS state, Bayesian-share decomposition).
* api.bible cache with 30-day TTL for NKJV verse text composition.
* Drizzle migrations run on every boot; forward-only.
* Litestream → Backblaze B2 continuous replication for the SQLite DB.

### Bundled algorithm contract

* `verse-vault-core@0.1.0` — algorithm/state contract
* `verse-vault-wasm@0.1.0` — JS wire-format contract

(See [`crates/core/CHANGELOG.md`](../../crates/core/CHANGELOG.md) and
[`crates/wasm/CHANGELOG.md`](../../crates/wasm/CHANGELOG.md). Fat clients that sync against this API
must ship matching `core` + `wasm` versions.)
