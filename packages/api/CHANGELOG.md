# Changelog — `@verse-vault/api`

All notable changes to this package are documented here, following
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Released via `.github/workflows/deploy-api.yml` (rsync to VPS, atomic symlink-flip, restart
`verse-vault.service`) on every `version` bump in `packages/api/package.json` that lands on
`master`.

## [Unreleased]

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
