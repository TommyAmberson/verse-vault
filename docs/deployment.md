# Deployment

verse-vault co-hosts under `www.versevault.ca/vv/*` alongside qzr-sheet at the apex. The plan is to
migrate qzr-sheet to its own domain later and split verse-vault back onto subdomains
(`app.versevault.ca` + `api.versevault.ca`); the cleanup section at the bottom covers what changes
then.

## Topology

```
                    www.versevault.ca
                           │
                    Cloudflare edge
     ┌─────────────────────┼───────────────────────────┐
     │                     │                           │
/api/*  → qzr-api      /vv/*  → vv-router Worker    /*  → qzr-sheet
Worker (existing)            │                       Pages (existing)
                             │
             ┌───────────────┴────────────────┐
             │                                │
     /vv/api/*                          /vv/*  (everything else)
             │                                │
     Cloudflare Tunnel                  CF Pages project
     (cloudflared on VPS)               (verse-vault-web)
             │
     ┌───────┴─────────┐
     │ Hetzner CX11    │
     │ node dist/…     │  → /var/lib/verse-vault/verse-vault.db
     │ better-sqlite3  │  → Litestream → Backblaze B2
     │ Litestream      │
     └─────────────────┘
```

Why this shape:

* **CF Pages** handles the SPA build + edge cache for free. Auto-deploys on git push.
* **CF Worker** is ~30 lines of glue. Stripping the `/vv` prefix at the edge means the VPS API
  doesn't know it's hosted under a subpath — it stays portable for the future subdomain cutover.
* **CF Tunnel** removes the VPS from the public internet. No DNS A record leaks the IP, no inbound
  ports, no Caddy to configure. The Tunnel daemon (`cloudflared`) makes an outbound connection to
  CF's edge and pulls request traffic through it.
* **VPS** runs only the Node API + SQLite. The engine's path enumeration exceeds CF Workers' CPU
  budget (see `docs/architecture.md`), so it can't live at the edge. Everything else can.

## Host sizing

A Hetzner CX11 (€4.51/mo, 2 vCPU / 2 GB) is plenty for single-user + a handful of friends. The
bottleneck is per-user `WasmEngine` cache memory (a few MB each), not request CPU.

Debian 12 or Ubuntu 24.04. Instructions assume `apt`.

## VPS setup

### 1. Packages + service account

```bash
sudo apt update
sudo apt install -y curl ca-certificates build-essential git

# Node 22 LTS
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs
sudo corepack enable

# Rust toolchain (for the WASM crate build step)
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs \
  | sudo RUSTUP_HOME=/opt/rust CARGO_HOME=/opt/rust sh -s -- -y
sudo ln -s /opt/rust/bin/* /usr/local/bin/

# Litestream
LITESTREAM_VERSION=0.3.13
curl -L "https://github.com/benbjohnson/litestream/releases/download/v${LITESTREAM_VERSION}/litestream-v${LITESTREAM_VERSION}-linux-amd64.deb" \
  -o /tmp/litestream.deb
sudo dpkg -i /tmp/litestream.deb

# cloudflared
curl -L https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64.deb \
  -o /tmp/cloudflared.deb
sudo dpkg -i /tmp/cloudflared.deb

# Service account + paths
sudo useradd --system --home /opt/verse-vault --create-home --shell /usr/sbin/nologin verse-vault
sudo mkdir -p /var/lib/verse-vault /var/log/verse-vault
sudo chown verse-vault:verse-vault /var/lib/verse-vault /var/log/verse-vault
```

### 2. Clone + build the API

```bash
sudo -u verse-vault git clone https://github.com/<owner>/verse-vault.git /opt/verse-vault/app
cd /opt/verse-vault/app

sudo -u verse-vault cargo install wasm-pack
sudo -u verse-vault pnpm install --frozen-lockfile
sudo -u verse-vault wasm-pack build crates/wasm --target nodejs --out-dir pkg
sudo -u verse-vault pnpm --filter @verse-vault/api... build
```

### 3. Environment file

```bash
sudo install -m 640 -o root -g verse-vault /dev/null /etc/verse-vault.env
sudoedit /etc/verse-vault.env
```

Required minimum:

```ini
# Random 64-byte hex string; never check this in.
BETTER_AUTH_SECRET=<openssl rand -hex 64>

# Public-facing base URLs (what browsers + OAuth providers see). The VPS
# itself never serves these directly — they describe the edge.
API_BASE_URL=https://www.versevault.ca/vv
WEB_BASE_URL=https://www.versevault.ca/vv

DATABASE_PATH=/var/lib/verse-vault/verse-vault.db
PORT=3000
```

Optional:

```ini
GOOGLE_CLIENT_ID=...
GOOGLE_CLIENT_SECRET=...

# Without these, /api/cards/:id returns structural metadata only
BIBLE_API_KEY=...
NKJV_BIBLE_ID=de4e12af7f28f599-02

# american | british | canadian (default canadian)
RENDER_DIALECT=canadian
```

### 4. systemd unit

```bash
sudo cp /opt/verse-vault/app/deploy/verse-vault.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now verse-vault
sudo systemctl status verse-vault
```

The unit binds to `127.0.0.1:3000` only — the only way in is through the Tunnel. Drizzle migrations
run on each boot (`runMigrations` in `packages/api/src/index.ts`), so first start initialises the
DB.

### 5. Cloudflare Tunnel

```bash
sudo -u verse-vault cloudflared tunnel login           # prints a URL — open it in a local browser to authorise the box
sudo -u verse-vault cloudflared tunnel create vv-api
sudo cp /opt/verse-vault/app/deploy/cloudflared/config.yml /etc/cloudflared/config.yml
sudoedit /etc/cloudflared/config.yml                   # paste in the tunnel UUID + credentials path
sudo -u verse-vault cloudflared tunnel route dns vv-api vv-api.versevault.ca
sudo cp /opt/verse-vault/app/deploy/cloudflared/cloudflared.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now cloudflared
```

After this `vv-api.versevault.ca` resolves through CF and reaches the VPS via the Tunnel. The VPS
still has no public ports open — `ufw default deny incoming` is fine.

### 6. Litestream

```bash
sudo cp /opt/verse-vault/app/deploy/litestream.yml /etc/litestream.yml
sudoedit /etc/litestream.yml      # bucket + B2 keys
sudo systemctl enable --now litestream
```

Restore on a fresh box (before first service start):

```bash
sudo -u verse-vault litestream restore -o /var/lib/verse-vault/verse-vault.db \
  s3://<bucket>/verse-vault.db
```

## Cloudflare edge setup

### 1. CF Pages project for the SPA

Deploys are driven by `.github/workflows/deploy-web.yml`, which builds on the runner and pushes via
`wrangler pages deploy` (so CF Pages' native git integration is **not** enabled — we gate releases
on `version` bumps in `apps/web/package.json` instead of every push).

One-time setup (run locally, with `wrangler` logged into the same CF account):

```bash
pnpm dlx wrangler pages project create verse-vault-web \
  --production-branch master \
  --compatibility-date 2026-05-01
```

In GitHub repo settings → Secrets and variables → Actions, add:

* `CLOUDFLARE_API_TOKEN` — token with **Pages: Edit** + **Workers Scripts: Edit** + **Account
  Settings: Read** (Profile → API Tokens → Create Token).
* `CLOUDFLARE_ACCOUNT_ID` — `92302b1ae0bb49089e62d3a5af313e41`.

To ship: bump `version` in `apps/web/package.json` on master. The workflow detects the change,
builds with `VITE_BASE_PATH=/vv/` + `VITE_API_BASE=/vv/api`, and runs `wrangler pages deploy`.
`workflow_dispatch` is the manual escape hatch for the first deploy.

Pages assigns a `*.pages.dev` hostname (e.g. `verse-vault-web.pages.dev`). The Worker will proxy to
that hostname; no custom domain on the Pages project itself.

### 2. CF Worker (`vv-router`)

The Worker source is at `deploy/vv-router/` (a workspace member, so it's covered by the root
`pnpm install`). Deploy it locally:

```bash
# Edit deploy/vv-router/wrangler.toml: set PAGES_HOST = "<your-pages-project>.pages.dev"
pnpm install --frozen-lockfile
pnpm --filter @verse-vault/vv-router deploy
```

Or push a `version` bump in `deploy/vv-router/package.json` to master and the
`.github/workflows/deploy-vv-router.yml` workflow ships it (uses `CLOUDFLARE_API_TOKEN` +
`CLOUDFLARE_ACCOUNT_ID` from repo secrets).

The route `www.versevault.ca/vv/*` is declared in `wrangler.toml`, so the deploy registers it
automatically. The Worker has two responsibilities:

1. **`/vv/api/*`** → fetch `https://vv-api.versevault.ca${path-without-/vv}` (the Tunnel-fronted
   API). Stripping the `/vv` prefix here means the VPS API code stays unaware of the subpath.
2. **`/vv/*`** → fetch `https://${PAGES_HOST}${path-without-/vv}` (the SPA bundle). The Pages
   project's `_redirects` provides the SPA fallback to `/index.html`.

### 3. SPA subpath wiring (one-time code change)

Three small tweaks let the SPA work under any subpath, controlled by build-time env vars:

* **`apps/web/vite.config.ts`**: `base: process.env.VITE_BASE_PATH ?? '/'`
* **`apps/web/src/router/index.ts`**: `createWebHistory(import.meta.env.BASE_URL)`
* **`apps/web/src/api.ts`**: replace the singleton at the bottom with
  `createApiClient(import.meta.env.VITE_API_BASE ?? 'http://localhost:3000')`

These default to root-relative URLs, so local dev (`pnpm dev:web`) keeps working without setting
either env var. The Pages build command sets them for production.

Add `apps/web/public/_redirects` with the SPA fallback rule:

```
/* /index.html 200
```

### 4. OAuth callback URLs

For Google: register `https://www.versevault.ca/vv/api/auth/callback/google` in the OAuth console.
Verify the exact path by checking what the API logs when a sign-in flow fails — Better Auth prints
the expected callback in its error.

## Updating

API changes (VPS side):

```bash
sudo -u verse-vault /opt/verse-vault/app/deploy/deploy.sh
```

What it does: `git pull`, `pnpm install --frozen-lockfile`, rebuild WASM, `tsc`,
`systemctl restart verse-vault`. Migrations run on the restart.

Web changes: push to the deploy branch. CF Pages rebuilds and ships within a couple of minutes.

Worker changes:

```bash
cd deploy/vv-router && pnpm wrangler deploy
```

## Operating notes

* Logs: `journalctl -u verse-vault -f` (API), `journalctl -u cloudflared -f` (Tunnel), CF dashboard
  → Workers → vv-router → logs (edge).
* DB inspection: `sqlite3 /var/lib/verse-vault/verse-vault.db` (use `.open -readonly` while the
  service is running; WAL mode handles concurrent reads).
* Roll back API: `git -C /opt/verse-vault/app checkout <previous-sha>` then re-run `deploy.sh`.
  Migrations are forward-only — rolling back across a migration boundary needs a Litestream restore.

## Costs (May 2026)

* Hetzner CX11: €4.51/mo (~$5).
* CF Pages + Workers + Tunnel: free at this scale.
* Backblaze B2 (Litestream): cents per month.
* Total: ~$5/mo on top of existing domain.

## Future: cutting over to subdomains

When qzr-sheet moves off `versevault.ca`, the subpath plumbing comes out:

1. **Worker**: delete `vv-router` and its `/vv/*` route.
2. **DNS**: add CNAMEs `app.versevault.ca` → `verse-vault-web.pages.dev` and `api.versevault.ca` →
   the Tunnel hostname.
3. **Pages**: bind the custom domain `app.versevault.ca` to the Pages project. Drop the
   `VITE_BASE_PATH` env var (defaults back to `/`); set `VITE_API_BASE=https://api.versevault.ca`.
   Trigger a rebuild.
4. **Tunnel**: `cloudflared tunnel route dns vv-api api.versevault.ca`.
5. **VPS `/etc/verse-vault.env`**:
   ```ini
   API_BASE_URL=https://api.versevault.ca
   WEB_BASE_URL=https://app.versevault.ca
   ```
   Restart the service.
6. **OAuth consoles**: update callback URLs to the new domain.
