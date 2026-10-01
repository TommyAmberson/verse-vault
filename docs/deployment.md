# Deployment

verse-vault serves the root of `www.versevault.ca`. qzr-sheet shares the host under `/qzr/*` (its
own Workers). verse-vault lived under `/vv/*` until 2026-10; old `/vv` addresses redirect to the
root, and the last section covers the move.

## Topology

```
                         www.versevault.ca
                                │
                         Cloudflare edge
    ┌───────────────────┬───────┴─────────┬──────────────────────────┐
    │                   │                 │                          │
/api/*, /vv/*     /qzr/api/*        /qzr/*, /scoresheet*       /* (everything else)
vv-router Worker  qzr-api Worker    qzr-web Worker              CF Pages project
    │             (qzr-sheet)       (qzr-sheet)                 (verse-vault-web,
    │                                                            custom domain)
    ├── /vv/*  → 308 to the same path without /vv
    │
    └── /api/* → Cloudflare Tunnel (cloudflared on VPS)
                        │
                ┌───────┴─────────┐
                │ DO droplet tor1 │
                │ node dist/…     │  → /var/lib/verse-vault/verse-vault.db
                │ better-sqlite3  │  → Litestream → Backblaze B2
                │ Litestream      │
                └─────────────────┘
```

Why this shape:

* **CF Pages** handles the SPA build + edge cache for free, bound to the hostname as a custom
  domain. More specific Worker routes win over it, so qzr's `/qzr/*` and the routes below carve out
  of the root.
* **CF Worker** (`vv-router`) is a few lines of glue: it sends `/api/*` to the Tunnel with the path
  unchanged and redirects the old `/vv` addresses.
* **CF Tunnel** removes the VPS from the public internet. No DNS A record leaks the IP, no inbound
  ports, no Caddy to configure. The Tunnel daemon (`cloudflared`) makes an outbound connection to
  CF's edge and pulls request traffic through it.
* **VPS** runs only the Node API + SQLite. The engine's path enumeration exceeds CF Workers' CPU
  budget (see `docs/architecture.md`), so it can't live at the edge. Everything else can.

## Host sizing

Production runs on a DigitalOcean `s-1vcpu-512mb-10gb` droplet in `tor1` (Toronto), $4/mo. Builds
happen in CI (see `.github/workflows/deploy-api.yml`) and the box only rsyncs the pre-built
`dist/` + `node_modules/` bundle, so it never needs a Rust toolchain or the memory to run
`wasm-pack`. Per-user `WasmEngine` cache memory (a few MB each) is the sizing bottleneck, not
request CPU — 512 MB comfortably handles single-user + a handful of friends.

Toronto location keeps sign-in latency low for CA users; the flashcard review path is fully local
after the initial API round-trip. Migration to a different provider is a few hours via
`litestream restore`.

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
> **All of sections 1-6 below are automated by `deploy/provision.sh`** (seven phases: packages,
> service account, Tunnel, SSH deploy key + systemd units, env file with auto-generated
> `BETTER_AUTH_SECRET`, interactive secret prompts for BIBLE_API_KEY + Google OAuth, and Litestream
> setup). From a fresh box as root:
>
> ```bash
> curl -sSL https://raw.githubusercontent.com/TommyAmberson/verse-vault/master/deploy/provision.sh | bash
> ```
>
> Idempotent — re-run later to add anything you initially skipped (Litestream, OAuth, etc.). The
> manual sections below document the equivalents in case you want to understand each phase or run
> one standalone; CI handles every subsequent deploy.

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
API_BASE_URL=https://www.versevault.ca
WEB_BASE_URL=https://www.versevault.ca

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

**`provision.sh` phase 7 covers this interactively** — if you ran the script in §1, this is already
done (or you entered blank at the bucket-name prompt and skipped). Re-run `provision.sh` to add
Litestream later; it'll detect the missing config and prompt. To do it manually instead:

```bash
curl -sSL https://raw.githubusercontent.com/TommyAmberson/verse-vault/master/deploy/litestream.yml \
  -o /etc/litestream.yml
chmod 600 /etc/litestream.yml
sudoedit /etc/litestream.yml      # fill in the four <…> placeholders
systemctl enable --now litestream
```

Don't curl the template file over a config `provision.sh` already wrote — the template has
placeholders; the script-written config has real values. Pick one path.

Restore on a fresh box (before first service start):

```bash
sudo -u verse-vault litestream restore -o /var/lib/verse-vault/verse-vault.db \
  s3://<bucket>/verse-vault.db
```

#### Verification

A backup chain that's never been restored isn't a backup — it's a hope. Two helper scripts in
`deploy/` exercise this.

**`restore-drill.sh`** — proves the B2 chain restores cleanly. Downloads the latest snapshot to a
temp file, runs `PRAGMA integrity_check`, and diffs row counts on the load-bearing tables (`user`,
`user_materials`, `graph_snapshots`, `review_events`, `test_states`) against the live DB. The
restored DB should be within `ROW_COUNT_TOLERANCE` (default 50) of live — the gap reflects writes
landing locally between the most recent WAL ship and `now`. Run once after Litestream setup, and
re-run after B2 credential rotations, big migrations, or whenever you want fresh confirmation:

```bash
curl -sSL https://raw.githubusercontent.com/TommyAmberson/verse-vault/master/deploy/restore-drill.sh \
  | sudo bash
```

**`litestream-health.sh`** — quick liveness check. `systemctl is-active`, time since the last
successful WAL ship (parsed from journalctl), and the most recent B2 snapshot inventory. Operator-
runnable; cron-able later. Fails non-zero if the daemon is down, no WAL has shipped in the last
`MAX_WAL_AGE_SECS` (default 3600), or B2 listing errors:

```bash
sudo bash deploy/litestream-health.sh
```

Neither script writes to B2 or mutates the live DB — both read-only against the live system. They
ship in the repo so re-pulling on a fresh box gives you the verification surface alongside the
service itself.

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
builds with `VITE_API_BASE=https://www.versevault.ca` (and the default `/` base), and runs
`wrangler pages deploy`. `workflow_dispatch` is the manual escape hatch for the first deploy.

Pages assigns a `*.pages.dev` hostname (e.g. `verse-vault-web.pages.dev`). In the dashboard, add
`www.versevault.ca` as a custom domain on the project (Workers & Pages → `verse-vault-web` → Custom
domains). A hostname can be bound to only one Pages project.

### 2. CF Worker (`vv-router`)

The Worker source is at `deploy/vv-router/` (a workspace member, so it's covered by the root
`pnpm install`). Push a `version` bump in `deploy/vv-router/package.json` to master and the
`.github/workflows/deploy-vv-router.yml` workflow ships it (uses `CLOUDFLARE_API_TOKEN` +
`CLOUDFLARE_ACCOUNT_ID` from repo secrets). Locally: `pnpm --filter @verse-vault/vv-router deploy`.

The routes (`www.versevault.ca/api`, `/api/*`, `/vv`, `/vv/*`) are declared in `wrangler.toml`, so
the deploy registers them. Cloudflare refuses a route another Worker already holds. The Worker has
two responsibilities:

1. **`/api/*`** → fetch `https://vv-api.versevault.ca${path}` (the Tunnel-fronted API), path
   unchanged.
2. **`/vv`, `/vv/*`** → `308` to the same path without `/vv`, query kept, so bookmarks and in-flight
   POSTs from before the move still land.

### 3. SPA subpath wiring (one-time code change)

Three small tweaks let the SPA work under any subpath, controlled by build-time env vars:

* **`apps/web/vite.config.ts`**: `base: process.env.VITE_BASE_PATH ?? '/'`
* **`apps/web/src/router/index.ts`**: `createWebHistory(import.meta.env.BASE_URL)`
* **`apps/web/src/api.ts`**: replace the singleton at the bottom with
  `createApiClient(import.meta.env.VITE_API_BASE ?? 'http://localhost:3000')`

These default to root-relative URLs, so local dev (`pnpm dev:web`) keeps working without setting
either env var. Production serves from the root, so it only sets `VITE_API_BASE`. A subpath deploy
would set `VITE_BASE_PATH` too.

Add `apps/web/public/_redirects` with the SPA fallback rule:

```
/* /index.html 200
```

### 4. OAuth callback URLs

For Google: register `https://www.versevault.ca/api/auth/callback/google` in the OAuth console.
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

* DigitalOcean s-1vcpu-512mb-10gb (tor1): $4/mo USD (~$5.50 CAD).
* CF Pages + Workers + Tunnel: free at this scale.
* Backblaze B2 (Litestream): cents per month.
* Total: ~$5/mo on top of existing domain.

## Moving from `/vv` to the root (2026-10)

verse-vault was served under `/vv/*` by vv-router while qzr-sheet held the root. qzr moved under
`/qzr/` first (qzr-sheet `specs/001-qzr-subpath`); then verse-vault took the root. Merging the
verse-vault PR deploys the SPA and vv-router at the same time, so the root can't change hands
atomically: steps 3-5 leave parts of the site broken for a few minutes. Run them back to back at a
quiet time. The switch, in order, with what is broken after each step:

1. **Google console**: add `https://www.versevault.ca/api/auth/callback/google` to verse-vault's
   OAuth client, keeping the `/vv/...` one until the switch is done. Nothing changes yet.
2. **qzr-sheet**: merge its switch-day PR and wait for its deploys. It drops `qzr-api`'s `/api/*`
   route, which vv-router can't claim until then, and redirects qzr's old `/scoresheet*` into
   `/qzr/`. Broken: only qzr's old root portal, which is being retired. verse-vault at `/vv/` still
   works.
3. **VPS `/etc/verse-vault.env`**: `API_BASE_URL` and `WEB_BASE_URL` to `https://www.versevault.ca`,
   then `sudo systemctl restart verse-vault`. Broken: Google sign-in, whose callback now points at
   the root `/api`, which nothing routes yet. Email sign-in and sync still work through `/vv/api`.
4. **Merge the verse-vault PR** (web 0.10.0, vv-router 0.2.0, api 0.1.44) and watch `deploy-web`.
   Broken from here until step 5: `/vv/*` either serves the new root build under the old prefix or
   redirects to a root that is still qzr's old site.
5. **Pages custom domain**, as soon as `deploy-web` is green: remove `www.versevault.ca` from
   qzr-sheet's `versevault-www` project and add it to `verse-vault-web`. The root now serves
   verse-vault, and the gaps from steps 3 and 4 close once vv-router's deploy has finished too.
6. **Check**: `/` serves verse-vault, `/vv/review` redirects to `/review`, `/api/health` is not the
   SPA, Google sign-in completes, an old qzr meet link (`/<slug>`) lands on `/qzr/<slug>`.
7. **Later**: remove the `/vv/api/auth/callback/google` URI.
