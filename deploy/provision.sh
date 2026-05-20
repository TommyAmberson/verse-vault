#!/usr/bin/env bash
#
# Provision a fresh Ubuntu 24.04 or Debian 12 box for verse-vault API hosting,
# bring up the Cloudflare Tunnel, and wire up the GitHub Actions deploy key.
#
# Idempotent — safe to re-run after partial failures. Existing tunnels, keys,
# and accounts are detected and reused.
#
# Run as root on a fresh box:
#   curl -sSL https://raw.githubusercontent.com/TommyAmberson/verse-vault/master/deploy/provision.sh | bash
# Or after cloning:
#   bash deploy/provision.sh
#
# Phases:
#   1. Base system (NTP, Node 22, litestream, cloudflared, ufw)
#   2. Service account + paths
#   3. Cloudflare Tunnel — pauses for browser auth
#   4. CI deploy key + sudoers + systemd unit
#   5. API env file (auto-generates BETTER_AUTH_SECRET; Bible API key
#      left as optional commented-out line)
#   6. Optional Google OAuth prompt — paste client id/secret or enter
#      to skip (re-run later to add)
#
# When this finishes, the only remaining manual steps are:
#   - Paste 2 values into GitHub Actions secrets (VPS_HOST + VPS_SSH_KEY)
#   - Trigger the deploy-api workflow (workflow_dispatch or version bump)
#
# Litestream backups, Google OAuth, and api.bible are all optional follow-ups.

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
TUNNEL_NAME="${TUNNEL_NAME:-vv-api}"
TUNNEL_HOSTNAME="${TUNNEL_HOSTNAME:-vv-api.versevault.ca}"
PUBLIC_BASE_URL="${PUBLIC_BASE_URL:-https://www.versevault.ca/vv}"
RAW_URL_BASE="https://raw.githubusercontent.com/TommyAmberson/verse-vault/master/deploy"

###############################################################################
# Phase 1: Base system
###############################################################################

echo "==[1/4]==== Base system =================================="

echo "  -> NTP sync"
timedatectl set-ntp true
systemctl restart systemd-timesyncd
sleep 2
echo "     System time: $(date -u +%FT%TZ)"

echo "  -> apt update + base packages"
apt-get update
DEBIAN_FRONTEND=noninteractive apt-get install -y \
	curl ca-certificates git ufw unattended-upgrades

echo "  -> Enabling unattended security upgrades"
dpkg-reconfigure -f noninteractive unattended-upgrades

echo "  -> Node 22"
if ! command -v node &>/dev/null || ! node --version | grep -q '^v22'; then
	curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
	apt-get install -y nodejs
fi
corepack enable

echo "  -> Litestream ${LITESTREAM_VERSION}"
if ! command -v litestream &>/dev/null; then
	curl -fsSL \
		"https://github.com/benbjohnson/litestream/releases/download/v${LITESTREAM_VERSION}/litestream-v${LITESTREAM_VERSION}-linux-amd64.deb" \
		-o /tmp/litestream.deb
	dpkg -i /tmp/litestream.deb
	rm -f /tmp/litestream.deb
fi

echo "  -> cloudflared"
if ! command -v cloudflared &>/dev/null; then
	curl -fsSL \
		https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64.deb \
		-o /tmp/cloudflared.deb
	dpkg -i /tmp/cloudflared.deb
	rm -f /tmp/cloudflared.deb
fi

###############################################################################
# Phase 2: Service account + firewall
###############################################################################

echo ""
echo "==[2/4]==== Service account + paths ======================"

echo "  -> verse-vault service account"
if ! id -u verse-vault &>/dev/null; then
	# /bin/bash from the start so CI can SSH in to run rsync + restart.
	# The actual security boundary is key-only SSH + ufw + the limited
	# sudoers rule installed in phase 4.
	useradd --system --home /opt/verse-vault --create-home --shell /bin/bash verse-vault
else
	chsh -s /bin/bash verse-vault
fi
mkdir -p /var/lib/verse-vault /var/log/verse-vault /opt/verse-vault/releases
chown verse-vault:verse-vault /var/lib/verse-vault /var/log/verse-vault /opt/verse-vault/releases

echo "  -> Firewall (SSH in, everything else denied)"
ufw allow OpenSSH
ufw default deny incoming
ufw default allow outgoing
ufw --force enable

###############################################################################
# Phase 3: Cloudflare Tunnel
###############################################################################

echo ""
echo "==[3/4]==== Cloudflare Tunnel ============================"
echo ""
echo "  About to run 'cloudflared tunnel login'."
echo "  It will print a URL — open that URL on your workstation,"
echo "  log into Cloudflare, and authorise the versevault.ca zone."
echo "  Execution resumes automatically when you confirm."
echo ""

if [ -f /opt/verse-vault/.cloudflared/cert.pem ]; then
	echo "  -> Tunnel cert already exists; skipping login"
else
	cd /opt/verse-vault
	sudo -u verse-vault -H cloudflared tunnel login
fi

if sudo -u verse-vault -H cloudflared tunnel list -o json 2>/dev/null \
	| grep -q "\"name\":\"$TUNNEL_NAME\""; then
	echo "  -> Tunnel '$TUNNEL_NAME' already exists; reusing"
else
	echo "  -> Creating tunnel '$TUNNEL_NAME'"
	cd /opt/verse-vault && sudo -u verse-vault -H cloudflared tunnel create "$TUNNEL_NAME"
fi

# Pull the UUID from the credentials file name in ~/.cloudflared/
TUNNEL_UUID=$(basename /opt/verse-vault/.cloudflared/*.json .json | head -1)
echo "     Tunnel UUID: $TUNNEL_UUID"

echo "  -> Fetching config + systemd unit templates"
mkdir -p /etc/cloudflared
curl -fsSL "$RAW_URL_BASE/cloudflared/config.yml" -o /etc/cloudflared/config.yml
curl -fsSL "$RAW_URL_BASE/cloudflared/cloudflared.service" \
	-o /etc/systemd/system/cloudflared.service
sed -i "s|<UUID>|$TUNNEL_UUID|g" /etc/cloudflared/config.yml

echo "  -> Routing DNS: $TUNNEL_HOSTNAME -> $TUNNEL_NAME"
cd /opt/verse-vault && sudo -u verse-vault -H \
	cloudflared tunnel route dns "$TUNNEL_NAME" "$TUNNEL_HOSTNAME" \
	|| echo "     (route may already exist; continuing)"

echo "  -> Enabling cloudflared.service"
systemctl daemon-reload
systemctl enable --now cloudflared
sleep 2
if ! systemctl is-active cloudflared > /dev/null; then
	echo "     cloudflared failed to start. journalctl -u cloudflared -n 30:"
	journalctl -u cloudflared --no-pager -n 30 || true
	exit 1
fi

###############################################################################
# Phase 4: CI deploy key + sudoers + verse-vault unit
###############################################################################

echo ""
echo "==[4/4]==== CI deploy key + systemd unit ================="

KEY_PATH=/opt/verse-vault/.ssh/deploy_key

echo "  -> SSH directory"
sudo -u verse-vault -H mkdir -p /opt/verse-vault/.ssh
chmod 700 /opt/verse-vault/.ssh

if [ -f "$KEY_PATH" ]; then
	echo "  -> Deploy key already exists; reusing"
else
	echo "  -> Generating ed25519 deploy key"
	sudo -u verse-vault -H ssh-keygen -t ed25519 -f "$KEY_PATH" -N "" \
		-C "github-actions-deploy@verse-vault-api"
fi

echo "  -> Authorising deploy key for inbound SSH"
sudo -u verse-vault -H cp "$KEY_PATH.pub" /opt/verse-vault/.ssh/authorized_keys
chmod 600 /opt/verse-vault/.ssh/authorized_keys

echo "  -> Sudoers rule (verse-vault → limited systemctl)"
cat > /etc/sudoers.d/verse-vault <<'EOF'
verse-vault ALL=(ALL) NOPASSWD: /usr/bin/systemctl restart verse-vault, /usr/bin/systemctl is-active verse-vault, /usr/bin/systemctl status verse-vault
EOF
chmod 440 /etc/sudoers.d/verse-vault
visudo -cf /etc/sudoers.d/verse-vault > /dev/null
echo "     sudoers syntax OK"

echo "  -> verse-vault.service (passive — won't start until first deploy)"
curl -fsSL "$RAW_URL_BASE/verse-vault.service" \
	-o /etc/systemd/system/verse-vault.service
systemctl daemon-reload

###############################################################################
# Phase 5: API env file
###############################################################################

echo ""
echo "==[5/5]==== API environment file ========================="

ENV_FILE=/etc/verse-vault.env

if [ -f "$ENV_FILE" ]; then
	echo "  -> $ENV_FILE already exists; leaving it alone"
	echo "     (delete it and re-run this script to regenerate)"
else
	echo "  -> Writing $ENV_FILE (auto-generated BETTER_AUTH_SECRET)"
	install -m 640 -o root -g verse-vault /dev/null "$ENV_FILE"
	cat > "$ENV_FILE" <<EOF
# Generated by provision.sh on $(date -u +%FT%TZ).
# BETTER_AUTH_SECRET is a one-shot random; rotating it logs every user out.

BETTER_AUTH_SECRET=$(openssl rand -hex 64)

API_BASE_URL=$PUBLIC_BASE_URL
WEB_BASE_URL=$PUBLIC_BASE_URL

DATABASE_PATH=/var/lib/verse-vault/verse-vault.db
PORT=3000

# Optional — uncomment + fill in to enable each feature.
# Google OAuth (Better Auth):
#GOOGLE_CLIENT_ID=
#GOOGLE_CLIENT_SECRET=

# api.bible cache (NKJV verse text in card renders):
#BIBLE_API_KEY=
NKJV_BIBLE_ID=de4e12af7f28f599-02

# american | british | canadian (default canadian if unset)
RENDER_DIALECT=canadian
EOF
	chmod 640 "$ENV_FILE"
	chown root:verse-vault "$ENV_FILE"
fi

###############################################################################
# Phase 6: Optional OAuth prompt
###############################################################################

echo ""
echo "==[6/6]==== Google OAuth (optional) ======================"
echo ""
echo "  Needed for 'Sign in with Google'. Skip to defer — you can edit"
echo "  $ENV_FILE and restart the service later."
echo ""

if grep -qE "^GOOGLE_CLIENT_ID=." "$ENV_FILE" 2>/dev/null; then
	echo "  -> Already configured in $ENV_FILE; skipping prompt"
elif ! [ -r /dev/tty ]; then
	echo "  -> No TTY available (non-interactive run); skipping"
else
	# `< /dev/tty` because stdin is the curl pipe when invoked as
	# `curl ... | bash`, not the terminal.
	printf "  GOOGLE_CLIENT_ID (enter to skip): "
	read google_id < /dev/tty

	if [ -z "$google_id" ]; then
		echo "  -> Skipping Google OAuth"
	else
		printf "  GOOGLE_CLIENT_SECRET (hidden): "
		stty -echo < /dev/tty
		read google_secret < /dev/tty
		stty echo < /dev/tty
		printf "\n"

		if [ -z "$google_secret" ]; then
			echo "  -> Empty secret; not setting client ID either"
		else
			# Escape sed-meaningful chars in the values (typical Google
			# creds don't include any of these, but defensive).
			esc_id=$(printf '%s' "$google_id" | sed 's|[&\\|]|\\&|g')
			esc_secret=$(printf '%s' "$google_secret" | sed 's|[&\\|]|\\&|g')
			sed -i -E "s|^#?GOOGLE_CLIENT_ID=$|GOOGLE_CLIENT_ID=${esc_id}|" "$ENV_FILE"
			sed -i -E "s|^#?GOOGLE_CLIENT_SECRET=$|GOOGLE_CLIENT_SECRET=${esc_secret}|" "$ENV_FILE"

			echo "  -> Configured in $ENV_FILE"
			echo ""
			echo "  Register this callback URL in your Google Cloud Console OAuth client:"
			echo "    $PUBLIC_BASE_URL/api/auth/callback/google"

			# If the service is already running (re-run after a previous deploy),
			# restart it to pick up the new env.
			if systemctl is-active --quiet verse-vault; then
				systemctl restart verse-vault
				echo "  -> Restarted verse-vault to pick up new env"
			fi
		fi
	fi
fi

###############################################################################
# Done — print what's left
###############################################################################

PUBLIC_IP=$(curl -sf https://api.ipify.org || echo '<your public IPv4>')

echo ""
echo "=========================================================="
echo "Provisioning complete."
echo "=========================================================="
echo ""
echo "Two things left to do, in your browser:"
echo ""
echo "  (1) Add these to GitHub repo Settings -> Secrets and variables -> Actions:"
echo ""
echo "        VPS_HOST     = $PUBLIC_IP"
echo "        VPS_SSH_KEY  = (paste the private key below)"
echo ""
echo "============================ BEGIN private key ============================"
cat "$KEY_PATH"
echo "============================= END private key ============================="
echo ""
echo "  (2) Trigger the first deploy:"
echo "        GitHub -> Actions -> 'Deploy API to VPS' -> Run workflow (master)"
echo "        OR bump packages/api/package.json version and push to master."
echo ""
echo "After (1), clear scrollback (Ctrl-L then Cmd-K / Ctrl-Shift-K)."
echo ""
echo "Optional follow-ups (all deferrable — API works without them):"
echo "  - Edit /etc/verse-vault.env to add GOOGLE_CLIENT_ID/SECRET (Google OAuth)"
echo "  - Edit /etc/verse-vault.env to add BIBLE_API_KEY (NKJV text in cards)"
echo "  - Fetch deploy/litestream.yml + fill in B2 creds + 'systemctl enable --now litestream'"
