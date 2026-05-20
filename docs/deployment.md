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
     │ Hetzner CX23    │
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

A Hetzner CX23 (€4.49/mo, 2 vCPU / 4 GB / 40 GB SSD, EU region) is plenty for single-user + a
handful of friends and the cheapest VPS that comfortably runs the Rust + wasm-pack build on the box.
The bottleneck is per-user `WasmEngine` cache memory (a few MB each), not request CPU. The ARM
equivalent (CAX11, Ampere, €4.99/mo) also works — all our deps have arm64 builds — but x86 is the
more boring choice for the first deploy.

EU location adds ~100ms latency vs a Toronto provider but it's invisible for flashcard review — the
slowest network round-trip a user hits is OAuth sign-in (once per session), and even that's well
under a second. Migration to a Canadian host later is a few hours via `litestream restore`.

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

> ### Or just run the provisioning script
>
> Sections 1 above is automated by `deploy/provision.sh`. From a fresh box as root:
>
> ```bash
> curl -sSL https://raw.githubusercontent.com/TommyAmberson/verse-vault/master/deploy/provision.sh | bash
> ```
>
> Sections 2 (env file) through 5 (Litestream) still need manual setup; the CI workflow then handles
> every subsequent deploy.

### 2. Environment file

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

### 3. systemd unit

Fetch the unit file from the branch (or master once merged) and register it. **Don't enable
`--now`** yet — the API binary won't exist on the box until the first CI deploy lands.

```bash
curl -sSL https://raw.githubusercontent.com/TommyAmberson/verse-vault/master/deploy/verse-vault.service \
  -o /etc/systemd/system/verse-vault.service
systemctl daemon-reload
```

The unit runs `node dist/index.js` as the `verse-vault` user with
`WorkingDirectory=/opt/verse-vault/app` (a symlink the CI workflow flips between releases). Hono
binds 0.0.0.0:3000; the only path in is the Cloudflare Tunnel proxying to 127.0.0.1:3000 because
`ufw` blocks everything else inbound. Drizzle migrations run on each boot (`runMigrations` in
`packages/api/src/index.ts`).

### 4. Cloudflare Tunnel

`cloudflared tunnel login` writes a temp key to the current directory and the cert to
`~/.cloudflared/`. The `verse-vault` user can't write to `/root`, and `sudo -u` doesn't set `HOME`
by default, so both `cd /opt/verse-vault` and the `-H` flag are required:

```bash
cd /opt/verse-vault && sudo -u verse-vault -H cloudflared tunnel login    # prints a URL — open it in a local browser to authorise the box
sudo -u verse-vault -H cloudflared tunnel create vv-api      # note the UUID it prints

# Fetch templates from the repo (no clone needed on the box)
mkdir -p /etc/cloudflared
curl -sSL https://raw.githubusercontent.com/TommyAmberson/verse-vault/master/deploy/cloudflared/config.yml \
  -o /etc/cloudflared/config.yml
curl -sSL https://raw.githubusercontent.com/TommyAmberson/verse-vault/master/deploy/cloudflared/cloudflared.service \
  -o /etc/systemd/system/cloudflared.service

# Substitute the UUID into config.yml (replace `<UUID>` — the literal placeholder)
TUNNEL_UUID=$(basename /opt/verse-vault/.cloudflared/*.json .json)
sed -i "s|<UUID>|$TUNNEL_UUID|g" /etc/cloudflared/config.yml

sudo -u verse-vault -H cloudflared tunnel route dns vv-api vv-api.versevault.ca
systemctl daemon-reload
systemctl enable --now cloudflared
```

After this `vv-api.versevault.ca` resolves through CF and reaches the VPS via the Tunnel. The VPS
still has no public ports open — `ufw default deny incoming` is fine.

### 5. Litestream

```bash
curl -sSL https://raw.githubusercontent.com/TommyAmberson/verse-vault/master/deploy/litestream.yml \
  -o /etc/litestream.yml
sudoedit /etc/litestream.yml      # bucket + B2 keys
systemctl enable --now litestream
```

Restore on a fresh box (before first service start):

```bash
sudo -u verse-vault litestream restore -o /var/lib/verse-vault/verse-vault.db \
  s3://<bucket>/verse-vault.db
```

### 6. SSH deploy key for CI

The `.github/workflows/deploy-api.yml` workflow SSHes in as `verse-vault` and runs `rsync` plus a
few shell commands. This is **phase 4 of `provision.sh`** — if you ran the provisioning script in
§1, this is already done. To do it standalone (or to rotate the key later), re-run `provision.sh`:

```bash
curl -sSL https://raw.githubusercontent.com/TommyAmberson/verse-vault/master/deploy/provision.sh | bash
```

It's idempotent — already-completed phases are skipped. Phase 4 specifically:

1. Switches `verse-vault`'s shell from `nologin` → `/bin/bash` so SSH command execution works
2. Generates an ed25519 deploy keypair in `/opt/verse-vault/.ssh/` (idempotent — won't overwrite
   existing)
3. Authorises the public key for inbound SSH as `verse-vault`
4. Installs a sudoers rule letting `verse-vault` run
   `systemctl restart|is-active|status verse-vault` without a password (and nothing else)
5. Creates `/opt/verse-vault/releases/` owned by `verse-vault`
6. Prints the private key for you to paste into the GitHub Actions secret

Then in **GitHub repo Settings → Secrets and variables → Actions**, add:

* `VPS_SSH_KEY` — paste the private key from the script's output
* `VPS_HOST` — the VPS's public IPv4 (the script also prints this for you)

(The same `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` secrets are already configured for the
web + worker workflows.)

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

All three deploys are version-gated CI workflows. Bump the relevant `package.json` version on master
and the matching workflow detects the change, builds, and ships:

| Bump                            | Workflow                                 | Target                  |
| ------------------------------- | ---------------------------------------- | ----------------------- |
| `apps/web/package.json`         | `.github/workflows/deploy-web.yml`       | CF Pages                |
| `deploy/vv-router/package.json` | `.github/workflows/deploy-vv-router.yml` | CF Worker (`vv-router`) |
| `packages/api/package.json`     | `.github/workflows/deploy-api.yml`       | VPS (rsync + restart)   |

`workflow_dispatch` is the manual escape hatch on each workflow — useful for the first deploy and
for retries when nothing in the diff actually changed (e.g., re-running after a transient CI flake).

The API workflow builds the WASM + TypeScript artifacts on the GitHub runner, runs
`pnpm --filter @verse-vault/api deploy --prod` to bundle a self-contained directory (no workspace
links left), rsyncs to `/opt/verse-vault/releases/<sha>/` on the VPS, atomically flips the
`/opt/verse-vault/app` symlink, and restarts `verse-vault.service`. Old releases are pruned to the
last 5 for rollback headroom.

A health check (`curl https://vv-api.versevault.ca/health`) gates the workflow as success — if the
API doesn't come up within 45 s after restart, the workflow fails and the previous release stays in
place (because the symlink was already flipped, you'd have to roll back manually by repointing
`/opt/verse-vault/app` at the prior release dir). Worth tightening later with a true blue/green
setup, but adequate for now.

## Operating notes

* Logs: `journalctl -u verse-vault -f` (API), `journalctl -u cloudflared -f` (Tunnel), CF dashboard
  → Workers → vv-router → logs (edge).
* DB inspection: `sqlite3 /var/lib/verse-vault/verse-vault.db` (use `.open -readonly` while the
  service is running; WAL mode handles concurrent reads).
* Roll back API: `/opt/verse-vault/app` is a symlink the deploy workflow flips. Point it at a
  previous release dir and restart:
  ```bash
  sudo -u verse-vault ln -sfn /opt/verse-vault/releases/<previous-sha> /opt/verse-vault/app.tmp
  sudo -u verse-vault mv -T /opt/verse-vault/app.tmp /opt/verse-vault/app
  sudo systemctl restart verse-vault
  ```
  Migrations are forward-only — rolling back across a migration boundary needs a Litestream restore.

## Costs (May 2026)

* Hetzner CX23 (EU): €4.49/mo (~$4.85 USD / ~$6.70 CAD).
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
