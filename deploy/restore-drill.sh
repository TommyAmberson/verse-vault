#!/usr/bin/env bash
#
# Restore drill: download the latest snapshot from B2 to a temp file via
# `litestream restore`, validate the restored DB, and compare row counts
# against the live DB. Proves the backup chain is actually restorable —
# the classic litestream bear-trap is replicating for months and never
# verifying restore until you need it in a crisis.
#
# Run as root on the VPS:
#     sudo bash deploy/restore-drill.sh
#
# Re-run after B2 credential rotations, big migrations, or whenever you
# want fresh confirmation that the backup chain is healthy.
#
# Env overrides (rarely needed):
#     LITESTREAM_CONFIG (default: /etc/litestream.yml)
#     VV_DB_PATH        (default: /var/lib/verse-vault/verse-vault.db)
#
# Exit codes:
#     0 — restore succeeded, integrity_check ok, row counts within tolerance
#     1 — usage / preflight failure (missing config, can't run as root, etc.)
#     2 — restore or validation failure
#
set -euo pipefail

LITESTREAM_CONFIG="${LITESTREAM_CONFIG:-/etc/litestream.yml}"
VV_DB_PATH="${VV_DB_PATH:-/var/lib/verse-vault/verse-vault.db}"
# Row counts on the restored DB are compared against the live DB. New
# writes between the last WAL ship and "now" mean the restored count is
# slightly behind — allow this many extra rows on the live side without
# failing. 50 covers ~5 min of moderate review traffic (sync-interval is
# 10s by default, so the gap should usually be < 10s).
ROW_COUNT_TOLERANCE="${ROW_COUNT_TOLERANCE:-50}"

# Tables we expect to be non-empty in any actively-used deployment.
LOAD_BEARING_TABLES=(user user_materials graph_snapshots review_events test_states)

usage_fail() {
    echo "FAIL: $1" >&2
    exit 1
}

if [ ! -r "$LITESTREAM_CONFIG" ]; then
    usage_fail "cannot read $LITESTREAM_CONFIG — run as root or set LITESTREAM_CONFIG"
fi

if [ ! -r "$VV_DB_PATH" ]; then
    usage_fail "cannot read live DB at $VV_DB_PATH — set VV_DB_PATH if it's elsewhere"
fi

for cmd in litestream sqlite3; do
    if ! command -v "$cmd" >/dev/null; then
        usage_fail "$cmd not found on PATH"
    fi
done

TMPDIR=$(mktemp -d -t vv-restore-drill.XXXXXX)
trap 'rm -rf "$TMPDIR"' EXIT
RESTORED="$TMPDIR/restored.db"

echo "==[1/4]== Restoring from B2"
echo "  Source:      $VV_DB_PATH (via $LITESTREAM_CONFIG)"
echo "  Destination: $RESTORED"
if ! litestream restore -config "$LITESTREAM_CONFIG" -o "$RESTORED" "$VV_DB_PATH"; then
    echo "FAIL: litestream restore returned non-zero" >&2
    exit 2
fi
if [ ! -s "$RESTORED" ]; then
    echo "FAIL: restored file is missing or empty" >&2
    exit 2
fi
RESTORED_SIZE=$(stat -c%s "$RESTORED")
LIVE_SIZE=$(stat -c%s "$VV_DB_PATH")
echo "  Restored size: $RESTORED_SIZE bytes (live: $LIVE_SIZE)"

echo ""
echo "==[2/4]== PRAGMA integrity_check on restored DB"
INTEGRITY=$(sqlite3 "$RESTORED" "PRAGMA integrity_check")
if [ "$INTEGRITY" != "ok" ]; then
    echo "FAIL: integrity_check returned:" >&2
    echo "$INTEGRITY" >&2
    exit 2
fi
echo "  ok"

echo ""
echo "==[3/4]== Row counts (restored vs live; tolerance ±$ROW_COUNT_TOLERANCE)"
printf "  %-20s %10s %10s %10s\n" "table" "restored" "live" "drift"
printf "  %-20s %10s %10s %10s\n" "-----" "--------" "----" "-----"
FAILURES=0
for table in "${LOAD_BEARING_TABLES[@]}"; do
    R=$(sqlite3 "$RESTORED" "SELECT count(*) FROM $table" 2>/dev/null || echo "MISSING")
    L=$(sqlite3 "$VV_DB_PATH" "SELECT count(*) FROM $table" 2>/dev/null || echo "MISSING")
    if [ "$R" = "MISSING" ]; then
        printf "  %-20s %10s %10s %10s\n" "$table" "MISSING" "$L" "—"
        FAILURES=$((FAILURES + 1))
        continue
    fi
    if [ "$L" = "MISSING" ]; then
        printf "  %-20s %10s %10s %10s\n" "$table" "$R" "MISSING" "—"
        continue
    fi
    DRIFT=$((L - R))
    printf "  %-20s %10s %10s %+10d\n" "$table" "$R" "$L" "$DRIFT"
    if [ "$DRIFT" -lt 0 ]; then
        echo "    -> WARN: restored is AHEAD of live by $((-DRIFT)) rows (B2 has data the box lost?)" >&2
    elif [ "$DRIFT" -gt "$ROW_COUNT_TOLERANCE" ]; then
        echo "    -> FAIL: drift exceeds tolerance ±$ROW_COUNT_TOLERANCE" >&2
        FAILURES=$((FAILURES + 1))
    fi
done

echo ""
echo "==[4/4]== Snapshot inventory in B2"
litestream snapshots -config "$LITESTREAM_CONFIG" "$VV_DB_PATH" 2>&1 | tail -10 | sed 's/^/  /'

echo ""
if [ "$FAILURES" -gt 0 ]; then
    echo "FAIL: $FAILURES table(s) failed validation" >&2
    exit 2
fi
echo "OK: restore drill passed"
