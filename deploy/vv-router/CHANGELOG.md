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

## [0.1.1] — 2026-05-20

### Added

* First production deploy to Cloudflare Workers.
* Edge router for `www.versevault.ca/vv/*`:
  * `/vv/api/*` → fetch to `API_HOST` (Tunnel-fronted VPS API).
  * `/vv/*` → fetch to `PAGES_HOST` (CF Pages SPA bundle).
* Strips the `/vv` prefix before forwarding so origins stay subpath-agnostic.
* `redirect: 'manual'` to preserve Better Auth's OAuth redirect chain.
