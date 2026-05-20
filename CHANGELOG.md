# Changelog

verse-vault uses **per-package versioning**. Each unit that's either independently deployed _or_
serves as a cross-process contract has its own changelog, colocated with its `package.json` /
`Cargo.toml`.

## Deployable packages

These each have a CI workflow that ships them on `version` bump:

* [`apps/web/CHANGELOG.md`](apps/web/CHANGELOG.md) — Vue SPA → Cloudflare Pages
  (`.github/workflows/deploy-web.yml`)
* [`deploy/vv-router/CHANGELOG.md`](deploy/vv-router/CHANGELOG.md) — edge router Worker → Cloudflare
  Workers (`.github/workflows/deploy-vv-router.yml`)
* [`packages/api/CHANGELOG.md`](packages/api/CHANGELOG.md) — Node API → VPS via Cloudflare Tunnel
  (`.github/workflows/deploy-api.yml`)

Each deploy is independent: a bump to one `package.json` triggers only that package's workflow.

## Contract crates

These aren't independently deployed; they ship inside the API binary today and inside future fat
clients. Their versions are **contracts** across consumers — a mismatch between the version a client
ships and the version the server runs is a real compatibility signal.

* [`crates/core/CHANGELOG.md`](crates/core/CHANGELOG.md) — algorithm/state contract. Same version
  means same memory model + scheduling semantics.
* [`crates/wasm/CHANGELOG.md`](crates/wasm/CHANGELOG.md) — JS wire-format contract. Same version
  means same JSON shapes across the WASM boundary.

Deployable packages that bundle the contract crates reference them in a "Bundled algorithm contract"
subsection of their changelog entries. Today this is only `packages/api` — the web SPA is a thin
client (no embedded WASM) and `vv-router` is pure TypeScript edge code. When fat clients ship
(browser-side WASM in `apps/web`, Tauri, CLI), each will add the same subsection naming the contract
versions it bundles, and a mismatch with the server's versions becomes a real compatibility signal.

## Not separately versioned

* `crates/sim/` — simulation binary, dev tool only, not shipped to any consumer. Its history is
  tracked in git.
* `tools/` — Python content pipeline, run locally as needed.
