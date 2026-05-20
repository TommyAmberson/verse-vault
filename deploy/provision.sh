#!/usr/bin/env bash
#
# Provision a fresh Ubuntu 24.04 or Debian 12 box for verse-vault API hosting.
# Idempotent — safe to re-run after partial failures.
#
# Run as root on a fresh box:
#   curl -sSL https://raw.githubusercontent.com/TommyAmberson/verse-vault/master/deploy/provision.sh | bash
# Or after cloning the repo:
#   bash deploy/provision.sh
#
# Installs runtime only — no compilers, no Rust toolchain. WASM and TypeScript
# artifacts are built in CI and rsynced to the box by the deploy workflow.

set -euo pipefail

if [ "$(id -u)" -ne 0 ]; then
	echo "Run as root." >&2
	exit 1
fi

if ! command -v apt-get &>/dev/null; then
	echo "This script targets Debian/Ubuntu (apt-based)." >&2
	exit 1
fi

LITESTREAM_VERSION="${LITESTREAM_VERSION:-0.3.13}"

echo "==> Forcing NTP sync (fresh boxes often have skewed clocks)"
timedatectl set-ntp true
systemctl restart systemd-timesyncd
sleep 2
echo "    System time: $(date -u +%FT%TZ)"

echo "==> Installing base packages"
apt-get update
DEBIAN_FRONTEND=noninteractive apt-get install -y \
	curl ca-certificates git ufw unattended-upgrades

echo "==> Enabling unattended security upgrades"
dpkg-reconfigure -f noninteractive unattended-upgrades

echo "==> Installing Node 22"
if ! command -v node &>/dev/null || ! node --version | grep -q '^v22'; then
	curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
	apt-get install -y nodejs
fi
corepack enable

echo "==> Installing Litestream ${LITESTREAM_VERSION}"
if ! command -v litestream &>/dev/null; then
	curl -fsSL \
		"https://github.com/benbjohnson/litestream/releases/download/v${LITESTREAM_VERSION}/litestream-v${LITESTREAM_VERSION}-linux-amd64.deb" \
		-o /tmp/litestream.deb
	dpkg -i /tmp/litestream.deb
	rm -f /tmp/litestream.deb
fi

echo "==> Installing cloudflared"
if ! command -v cloudflared &>/dev/null; then
	curl -fsSL \
		https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64.deb \
		-o /tmp/cloudflared.deb
	dpkg -i /tmp/cloudflared.deb
	rm -f /tmp/cloudflared.deb
fi

echo "==> Creating verse-vault service account"
if ! id -u verse-vault &>/dev/null; then
	useradd --system --home /opt/verse-vault --create-home --shell /usr/sbin/nologin verse-vault
fi
mkdir -p /var/lib/verse-vault /var/log/verse-vault
chown verse-vault:verse-vault /var/lib/verse-vault /var/log/verse-vault

echo "==> Configuring firewall (SSH in, everything else denied)"
ufw allow OpenSSH
ufw default deny incoming
ufw default allow outgoing
ufw --force enable

echo ""
echo "==> Provisioning complete."
echo ""
echo "Next steps (see docs/deployment.md sections 5–6):"
echo "  1. sudo -u verse-vault cloudflared tunnel login"
echo "  2. sudo -u verse-vault cloudflared tunnel create vv-api"
echo "  3. cp <repo>/deploy/cloudflared/config.yml /etc/cloudflared/config.yml"
echo "     (and fill in the tunnel UUID + credentials path)"
echo "  4. sudo -u verse-vault cloudflared tunnel route dns vv-api vv-api.versevault.ca"
echo "  5. Install cloudflared.service + verse-vault.service systemd units"
echo "  6. Create /etc/verse-vault.env with BETTER_AUTH_SECRET + URLs"
echo "  7. Set up /etc/litestream.yml with B2 bucket + credentials"
echo "  8. First API deploy lands via the .github/workflows pipeline"
