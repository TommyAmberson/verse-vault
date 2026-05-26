# Changelog — `@verse-vault/api`

All notable changes to this package are documented here, following
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Released via `.github/workflows/deploy-api.yml` (rsync to VPS, atomic symlink-flip, restart
`verse-vault.service`) on every `version` bump in `packages/api/package.json` that lands on
`master`.

## [Unreleased]

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
