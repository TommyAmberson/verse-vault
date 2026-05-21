#!/usr/bin/env bash
# Build the WASM bundler target for the browser fat-client.
#
# Two targets coexist in this repo:
#
#   crates/wasm/pkg/      — wasm-pack --target nodejs, consumed by packages/api
#   crates/wasm/pkg-web/  — wasm-pack --target bundler, consumed by apps/web
#
# Same Rust source, two different JS shim shapes. wasm-pack always writes
# the same name (`verse-vault-wasm`) into the generated package.json,
# which conflicts with the nodejs pkg when both live in the pnpm
# workspace. Rename the bundler output to `verse-vault-wasm-web` after
# the build so both names are distinct workspace packages.

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

wasm-pack build crates/wasm --target bundler --out-dir pkg-web "$@"

PKG_JSON="crates/wasm/pkg-web/package.json"
sed -i 's/"name": "verse-vault-wasm"/"name": "verse-vault-wasm-web"/' "$PKG_JSON"

# Sanity: confirm the rename took.
if ! grep -q '"name": "verse-vault-wasm-web"' "$PKG_JSON"; then
  echo "ERROR: failed to rename package.json in $PKG_JSON" >&2
  exit 1
fi

echo "Built crates/wasm/pkg-web (name: verse-vault-wasm-web)"
