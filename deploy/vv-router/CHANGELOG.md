# Changelog — `@verse-vault/vv-router`

All notable changes to this package are documented here, following
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Released via `.github/workflows/deploy-vv-router.yml` (Cloudflare Workers, route
`www.versevault.ca/vv/*`) on every `version` bump in `deploy/vv-router/package.json` that lands on
`master`.

The Worker is intentionally minimal edge plumbing and should change rarely once deployed — most
app-level changes don't need a bump here.

## [Unreleased]

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
