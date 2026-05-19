#!/usr/bin/env bash
#
# Idempotent VPS deploy for the verse-vault API: pull, rebuild, restart.
# The SPA is hosted on Cloudflare Pages and rebuilds automatically on git
# push, so this script only touches the Node API.
#
#   sudo -u verse-vault /opt/verse-vault/app/deploy/deploy.sh

set -euo pipefail

APP_DIR="${APP_DIR:-/opt/verse-vault/app}"
SERVICE="${SERVICE:-verse-vault}"

cd "$APP_DIR"

echo "==> Pulling latest commits"
git pull --ff-only

echo "==> Installing dependencies"
pnpm install --frozen-lockfile

echo "==> Building WASM bindings"
# crates/wasm/pkg is a workspace dep of @verse-vault/api.
wasm-pack build crates/wasm --target nodejs --out-dir pkg

echo "==> Building API"
pnpm --filter @verse-vault/api... build

echo "==> Restarting $SERVICE"
sudo systemctl restart "$SERVICE"

echo "==> Done. Tail logs with: journalctl -u $SERVICE -f"
