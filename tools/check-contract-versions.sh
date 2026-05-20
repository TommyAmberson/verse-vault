#!/usr/bin/env bash
#
# Two-mode guard for the "contract crate" versioning convention.
#
# `crates/core` (algorithm + state semantics) and `crates/wasm` (JS↔Rust
# wire format) are contracts across consumers (API today, future fat
# clients). Their Cargo.toml version is the contract version; consumer
# changelogs must reference which contract versions they ship.
#
# Modes:
#   pre-commit (default): blocks commits that touch crates/<core|wasm>/src/
#     without a matching Cargo.toml version bump. Run as part of the
#     simple-git-hooks pre-commit chain.
#   --ci: blocks consumer deploy workflows when the consumer's CHANGELOG
#     doesn't reference the current contract crate versions for the
#     current consumer version. Catches "bumped core but forgot to
#     update the API changelog's Bundled algorithm contract subsection."
#
# Refactor that's truly a no-op? Bypass pre-commit with `--no-verify`,
# or the CI check by ensuring the changelog explicitly notes that the
# contract crate versions are unchanged from the previous release.
#
# See CLAUDE.md "Contract crate versioning" and top-level `CHANGELOG.md`.

set -euo pipefail

MODE="${1:-pre-commit}"

###############################################################################
# Mode 1: pre-commit
###############################################################################

check_staged() {
	local crate=$1
	local src="crates/$crate/src"
	local manifest="crates/$crate/Cargo.toml"

	if ! git diff --cached --name-only | grep -q "^$src/"; then
		return 0
	fi

	# Anchored to `^\+version = ` so dep version edits (which sit indented
	# under [dependencies]) don't satisfy the check.
	if git diff --cached --unified=0 -- "$manifest" 2>/dev/null \
		| grep -qE '^\+version = '; then
		return 0
	fi

	cat >&2 <<EOF

  $src/ has staged changes but $manifest "version" is unchanged.

  '$crate' is a contract crate — its version is a compatibility signal
  across consumers. Bump it if this change has any observable effect on
  memory model, scheduling, or wire format, and add a CHANGELOG entry.

  Refactor with no observable behaviour change? Bypass with --no-verify.

EOF
	return 1
}

###############################################################################
# Mode 2: --ci
###############################################################################

cargo_version() {
	grep -E '^version = ' "$1" | head -1 | sed -E 's/.*"([^"]+)".*/\1/'
}

# Extract the section of a Keep-a-Changelog file for a specific version.
changelog_section() {
	local file=$1
	local version=$2
	awk -v ver="$version" '
		$0 ~ "^## \\[" ver "\\]" { flag=1; next }
		$0 ~ "^## \\[" && flag { exit }
		flag { print }
	' "$file"
}

check_changelog() {
	local consumer_name=$1
	local consumer_version=$2
	local changelog=$3
	local core_v=$4
	local wasm_v=$5

	if [ ! -f "$changelog" ]; then
		echo "::error::$changelog missing" >&2
		return 1
	fi

	local section
	section=$(changelog_section "$changelog" "$consumer_version")
	if [ -z "$section" ]; then
		echo "::error::$changelog has no entry for [$consumer_version]" >&2
		return 1
	fi

	local failed=0
	if ! echo "$section" | grep -qE "verse-vault-core@$core_v"; then
		echo "::error::$changelog [$consumer_version] doesn't reference verse-vault-core@$core_v" >&2
		failed=1
	fi
	if ! echo "$section" | grep -qE "verse-vault-wasm@$wasm_v"; then
		echo "::error::$changelog [$consumer_version] doesn't reference verse-vault-wasm@$wasm_v" >&2
		failed=1
	fi
	return $failed
}

###############################################################################
# Dispatch
###############################################################################

failed=0
case "$MODE" in
	pre-commit)
		for crate in core wasm; do
			check_staged "$crate" || failed=1
		done
		;;
	--ci)
		core_v=$(cargo_version crates/core/Cargo.toml)
		wasm_v=$(cargo_version crates/wasm/Cargo.toml)
		api_v=$(node -p "require('./packages/api/package.json').version")

		echo "  Current contract versions: core@$core_v, wasm@$wasm_v"
		echo "  Verifying packages/api/CHANGELOG.md [$api_v] references both…"
		check_changelog "api" "$api_v" packages/api/CHANGELOG.md "$core_v" "$wasm_v" \
			|| failed=1

		# When fat clients land (apps/web ships verse-vault-wasm directly,
		# Tauri ships both), add the same check for their CHANGELOGs.

		if [ "$failed" -eq 0 ]; then
			echo "  OK."
		fi
		;;
	*)
		echo "Usage: $0 [pre-commit | --ci]" >&2
		exit 2
		;;
esac

exit "$failed"
