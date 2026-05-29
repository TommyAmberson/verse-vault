#!/usr/bin/env bash
#
# Quick health check on the litestream daemon. Reports systemd status,
# time since the last WAL ship, and the most recent B2 snapshot.
# Operator-runnable; suitable for cron + journald alerting later.
#
# Exit codes:
#     0 — daemon active, last WAL ship within MAX_WAL_AGE_SECS
#     1 — daemon not active, no recent WAL ship, or B2 snapshot listing failed
#
set -euo pipefail

LITESTREAM_CONFIG="${LITESTREAM_CONFIG:-/etc/litestream.yml}"
VV_DB_PATH="${VV_DB_PATH:-/var/lib/verse-vault/verse-vault.db}"
# A WAL ship older than this is suspicious. 1 hour comfortably bridges
# normal idle periods (no DB writes → no WAL ships) without masking
# silent breakage like B2 creds expiring.
MAX_WAL_AGE_SECS="${MAX_WAL_AGE_SECS:-3600}"

FAILED=0

echo "==[1/3]== systemd unit state"
if systemctl is-active --quiet litestream; then
    echo "  active"
else
    echo "  FAIL: litestream service is not active"
    systemctl status litestream --no-pager -l | sed 's/^/    /' | head -15
    FAILED=1
fi

echo ""
echo "==[2/3]== Time since last WAL ship"
# `wal segment written` is litestream's "successful upload to replica"
# log line. Pull the most recent within MAX_WAL_AGE_SECS to bound the
# journalctl scan.
LOOKBACK="$((MAX_WAL_AGE_SECS + 60)) seconds ago"
LAST_LINE=$(journalctl -u litestream --since "$LOOKBACK" --no-pager 2>/dev/null \
    | grep -F "wal segment written" \
    | tail -1 || true)

if [ -z "$LAST_LINE" ]; then
    echo "  WARN: no successful WAL ship in the last $((MAX_WAL_AGE_SECS / 60)) minutes"
    echo "        (normal if the DB is idle; concerning if review traffic is happening)"
else
    LAST_TS=$(printf '%s' "$LAST_LINE" | grep -oE 'time=[^ ]+' | head -1 | cut -d= -f2 || true)
    if [ -n "$LAST_TS" ]; then
        NOW_EPOCH=$(date -u +%s)
        # `date -d` on Debian/Ubuntu reads RFC3339 fine.
        LAST_EPOCH=$(date -u -d "$LAST_TS" +%s 2>/dev/null || echo "")
        if [ -n "$LAST_EPOCH" ]; then
            AGE=$((NOW_EPOCH - LAST_EPOCH))
            echo "  Last WAL ship: $LAST_TS ($AGE s ago)"
            if [ "$AGE" -gt "$MAX_WAL_AGE_SECS" ]; then
                echo "  FAIL: exceeds MAX_WAL_AGE_SECS=$MAX_WAL_AGE_SECS"
                FAILED=1
            fi
        else
            echo "  Last WAL ship: $LAST_TS (couldn't parse age)"
        fi
    else
        echo "  Last WAL ship line (unparsed):"
        printf '    %s\n' "$LAST_LINE"
    fi
fi

echo ""
echo "==[3/3]== B2 snapshots (most recent first)"
if SNAPS=$(litestream snapshots -config "$LITESTREAM_CONFIG" "$VV_DB_PATH" 2>&1); then
    printf '%s\n' "$SNAPS" | tail -5 | sed 's/^/  /'
else
    echo "  FAIL: litestream snapshots failed:"
    printf '%s\n' "$SNAPS" | sed 's/^/    /'
    FAILED=1
fi

echo ""
if [ "$FAILED" -eq 0 ]; then
    echo "OK: litestream healthy"
else
    echo "FAIL: see issues above" >&2
fi
exit "$FAILED"
