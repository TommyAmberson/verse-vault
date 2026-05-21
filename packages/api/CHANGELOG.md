# Changelog — `@verse-vault/api`

All notable changes to this package are documented here, following
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Released via `.github/workflows/deploy-api.yml` (rsync to VPS, atomic symlink-flip, restart
`verse-vault.service`) on every `version` bump in `packages/api/package.json` that lands on
`master`.

## [Unreleased]

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
