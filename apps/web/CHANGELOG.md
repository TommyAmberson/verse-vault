# Changelog — `@verse-vault/web`

All notable changes to this package are documented here, following
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Released via `.github/workflows/deploy-web.yml` (Cloudflare Pages, `verse-vault-web`) on every
`version` bump in `apps/web/package.json` that lands on `master`.

## [Unreleased]

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
