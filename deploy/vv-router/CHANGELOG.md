# Changelog — `@verse-vault/vv-router`

All notable changes to this package are documented here, following
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Released via `.github/workflows/deploy-vv-router.yml` (Cloudflare Workers, routes
`www.versevault.ca/vv*` and `www.versevault.ca/api*`) on every `version` bump in
`deploy/vv-router/package.json` that lands on `master`.

The Worker is intentionally minimal edge plumbing and should change rarely once deployed — most
app-level changes don't need a bump here.

## [Unreleased]

## [0.2.0] - 2026-10-01

MINOR: verse-vault moves from `/vv/` to the root of www.versevault.ca, so the Worker stops serving
the app and becomes the root's API router plus a redirect for old addresses.

### Changed

* `/api` and `/api/*` go to the Tunnel-fronted API (`API_HOST`) with the path unchanged. The routes
  were qzr-api's until qzr moved under `/qzr/`; Cloudflare refuses a route another Worker holds, so
  deploy this only after qzr-api has dropped `/api/*`.
* `/vv` and `/vv/*` answer `308` to the same path without the prefix, query kept. 308 rather than
  301 so a POST keeps its method and body.
* The SPA is no longer proxied: the Pages project serves the root as a custom domain. `PAGES_HOST`
  is gone.

## [0.1.4] — 2026-05-21

### Fixed

* Bare `/vv` (no trailing slash) wasn't matched by the single `/vv/*` Worker route, so the request
  fell through to the qzr-sheet Pages catch-all at `/*`. qzr-sheet's SPA loaded, its Vue Router
  didn't know `/vv`, and the user was bounced to apex — looking like "going to `/vv` redirects to
  the apex." Added a second route pattern (`/vv` exactly) and a 301 in the Worker that sends `/vv` →
  `/vv/` so the SPA always loads under its proper base path.

## [0.1.3] — 2026-05-20

### Fixed

* CI: dropped `cloudflare/wrangler-action@v3`; deploys via `pnpm exec wrangler deploy` from
  `deploy/vv-router` directly (the dir has wrangler as a workspace devDependency). 0.1.3 is the
  first successful Worker deploy.

## [0.1.2] — 2026-05-20

### Fixed

* CI: same `pnpm/action-setup@v4` version-conflict fix as the other deployables (see top-level
  `CHANGELOG.md`). 0.1.2 is the first successful deploy of the Worker.

## [0.1.1] — 2026-05-20

### Added

* First production deploy to Cloudflare Workers.
* Edge router for `www.versevault.ca/vv/*`:
  * `/vv/api/*` → fetch to `API_HOST` (Tunnel-fronted VPS API).
  * `/vv/*` → fetch to `PAGES_HOST` (CF Pages SPA bundle).
* Strips the `/vv` prefix before forwarding so origins stay subpath-agnostic.
* `redirect: 'manual'` to preserve Better Auth's OAuth redirect chain.
