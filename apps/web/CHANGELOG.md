# Changelog — `@verse-vault/web`

All notable changes to this package are documented here, following
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Released via `.github/workflows/deploy-web.yml` (Cloudflare Pages, `verse-vault-web`) on every
`version` bump in `apps/web/package.json` that lands on `master`.

## [Unreleased]

## [0.1.7] — 2026-05-21

### Added

* **Fat-client engine.** ReviewView, MemorizeView, MaterialView, and StatsView now drive the WASM
  engine locally. Each grade runs `engine.replay_event` in-browser and queues an event to IndexedDB;
  the background flush ships them to `POST /api/sync/:materialId/events` on a 5 s debounce + on tab
  hide. No more network round-trip per card. Per-card render output caches in IDB (MAUA-compliant
  30-day TTL); the engine sources next-card decisions locally so review feels instant.
* `verse-vault-wasm-web` workspace package (wasm-pack `--target bundler` output) — same Rust source
  as the API's nodejs target, different JS shim. Vite emits the .wasm asset (~117 KB gzipped) as
  part of the build.
* `useEngine` composable + `engineStore` module-singleton owning per-material `WasmEngine` instances
  across navigations. Multi-material capable for MemorizeView's cross-year sessions.
* `getSyncState` + `postSyncEvents` methods on the API client wrapping the new server endpoints.
* `MaterialConfig` (newScope, reviewScope, clubCardScope, chapterListScope, headings, ftv) now
  threads through to the client engine; `MaterialView.onSave` invalidates the cached engine + render
  cache for the affected material so the next view visit rebuilds with fresh settings.

### Fixed

* `StatsView` no longer hardcodes `MATERIAL_ID = 'nkjv-cor'` — fetches stats per enrolled year via
  `getYears` and renders one card per year, sorted by total reviews. Single-year failures degrade
  gracefully via `Promise.allSettled` rather than blanking the whole page.
* Stale-merge `needsConfirm` responses no longer trigger an unbounded re-POST loop. The
  `engineStore` module now tracks a per-material `staleGate`; flushes for gated materials no-op
  until a `confirmMerge: true` flush succeeds or `clearStaleGate(materialId)` is called by the
  discard path.
* Render cache skips IDB writes when the server returns `composed: null` (the BIBLE_API_KEY-unset
  fallback path), so a misconfigured first request can't wedge the cache with empty composed HTML
  for the full 30-day TTL.

### Build

* `tools/build-wasm-web.sh` runs `wasm-pack build crates/wasm --target bundler --out-dir pkg-web`
  and renames the output package to `verse-vault-wasm-web` so both bundler + nodejs targets can
  coexist in the pnpm workspace.
* `vite-plugin-wasm` + `vite-plugin-top-level-await` handle the bundler-target import; build target
  bumped to `es2022` to compile the wasm-bindgen TLA shim cleanly.
* `.github/workflows/deploy-web.yml` installs the Rust toolchain + wasm-pack before `pnpm install`
  so the workspace `verse-vault-wasm-web` package exists when pnpm resolves the apps/web dependency.

### Documentation

* New top-level `NOTICE.md` carries the NKJV citation in the Starter-plan canonical form + the
  API.Bible attribution surface. `README.md` gains a "Third-party content" section pointing at it.
* MAUA URL fixes — see `packages/api/CHANGELOG.md` 0.1.8 for the matching server-side cleanup.

### Bundled algorithm contract

* `verse-vault-core@0.1.0` — unchanged
* `verse-vault-wasm@0.1.0` / `verse-vault-wasm-web@0.1.0` — same crate, two pkg targets

## [0.1.6] — 2026-05-21

### Fixed

* Production-only URL plumbing audit. Two issues:
  1. **API client double-pathed every request.** `VITE_API_BASE` was `/vv/api`, but every path
     passed to the api client already starts with `/api/` — so the final URLs became
     `/vv/api/api/cards/...` and 404'd the entire (non-auth) API surface in production. Confirmed by
     curl: `/vv/api/api/me` → 404, `/vv/api/me` → 401.
  2. **Better Auth client's `withPath` skips the `/api/auth` auto-append** when the baseURL has any
     path component (and `/vv` counts), so route calls were landing at `/vv/sign-up/email` (405)
     instead of `/vv/api/auth/sign-up/email`.

  Fix: `VITE_API_BASE` is now the subpath-only prefix (`/vv`) without `/api`. The api client adds
  `/api/...` itself, and `useAuth.ts` adds `/api/auth` explicitly for Better Auth.

## [0.1.5] — 2026-05-21

### Fixed

* 0.1.4 stripped `/api` off `VITE_API_BASE` to derive the Better Auth client `baseURL`, yielding
  `/vv` in production. Better Auth's `createAuthClient` validates that string with `new URL(...)`,
  which rejects relative paths (`Invalid base URL: /vv`) and the SPA crashed on first render.
  Resolve the relative path against `window.location.origin` before passing it in.

## [0.1.4] — 2026-05-20

### Fixed

* Better Auth client's `baseURL` came from `VITE_API_URL` (legacy env var) and fell back to
  `http://localhost:3000` in production because CI only sets `VITE_API_BASE`. The deployed SPA was
  therefore calling `localhost` for every auth request. Switched to deriving the auth base from
  `VITE_API_BASE` (the same env var the API client reads) by stripping the trailing `/api`.

## [0.1.3] — 2026-05-20

### Fixed

* CI: dropped `cloudflare/wrangler-action@v3` (its self-install path runs `pnpm add wrangler@<v>` at
  the workspace root, which pnpm v10 rejects without `-w`). Now publishes via
  `pnpm dlx wrangler@3 pages deploy ...` directly. 0.1.2 never reached production for the same
  family of pnpm-v10 CI breakage; 0.1.3 is the first successful deploy.

## [0.1.2] — 2026-05-20

### Fixed

* CI: `pnpm/action-setup@v4` errored on redundant version pin (both `with: version: 10` and
  `package.json`'s `packageManager: pnpm@10.7.0`). Dropped the `with` arg; 0.1.1 never reached
  production because of this, so 0.1.2 is the first successful deploy.

## [0.1.1] — 2026-05-20

### Added

* First production deploy to Cloudflare Pages.
* Vue 3 thin client: review, memorize, stats, material, sign-in views.
* Better Auth integration (email/password + Google OAuth via `authClient`).
* Subpath-aware build via `VITE_BASE_PATH` + `VITE_API_BASE` env vars.
* `_redirects` SPA fallback for CF Pages.
