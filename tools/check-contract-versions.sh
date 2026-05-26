#!/usr/bin/env bash
#
# Guard for the contract-crate versioning convention and the wider
# "package version bump requires a dated CHANGELOG section" rule.
#
# `crates/core` (algorithm + state semantics) and `crates/wasm` (JS↔Rust
# wire format) are contracts across consumers (API today, future fat
# clients). Their Cargo.toml version is the contract version; consumer
# changelogs must reference which contract versions they ship.
#
# Modes:
#   pre-commit (default): blocks
#     a) crates/<core|wasm>/src/ changes without a matching Cargo.toml
#        version bump (contract version is a compatibility signal).
#     b) any package version bump (core, wasm, api, web, vv-router)
#        without a matching dated CHANGELOG section. Catches the
#        "bumped package.json but left the entry under [Unreleased]"
#        mistake that would later fail the deploy CI check.
#   --ci <target>: blocks consumer deploy workflows. <target> is one of
#     {api, web, vv-router}; defaults to `api` for back-compat with the
#     pre-existing deploy-api.yml step. Requires the dated section to
#     exist; for api+web (which ship the contract crates), also requires
#     it to reference the current verse-vault-core / verse-vault-wasm
#     versions.
#
# Refactor that's truly a no-op? Bypass pre-commit with `--no-verify`,
# or the CI check by ensuring the changelog explicitly notes that the
# contract crate versions are unchanged from the previous release.
#
# See CLAUDE.md "Contract crate versioning" and top-level `CHANGELOG.md`.

set -euo pipefail

MODE="${1:-pre-commit}"
TARGET="${2:-}"

###############################################################################
# Helpers
###############################################################################

cargo_version() {
	grep -E '^version = ' "$1" | head -1 | sed -E 's/.*"([^"]+)".*/\1/'
}

# Return the new (staged) version line for a manifest, or empty if no
# version change was staged. Supports `Cargo.toml` (`^version = "X"`)
# and `package.json` (`^  "version": "X"`) — the only two forms we use.
staged_version() {
	local manifest=$1
	local pattern
	case "$manifest" in
		*.toml) pattern='^\+version = ' ;;
		*.json) pattern='^\+  "version":' ;;
		*) return 0 ;;
	esac
	git diff --cached --unified=0 -- "$manifest" 2>/dev/null \
		| grep -E "$pattern" | head -1 | sed -E 's/.*"([^"]+)".*/\1/'
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

# True iff the changelog has a `## [X.Y.Z]` header (i.e. promoted, not
# the bare `## [Unreleased]`) for the given version.
changelog_has_section() {
	local file=$1
	local version=$2
	local escaped
	escaped=$(printf '%s' "$version" | sed 's/\./\\./g')
	grep -qE "^## \\[$escaped\\]" "$file"
}

###############################################################################
# Pre-commit checks
###############################################################################

# Contract-crate-only: src/ touched but Cargo.toml version not bumped.
# Refactor escape valve is `git commit --no-verify`.
check_src_requires_bump() {
	local crate=$1
	local src="crates/$crate/src"
	local manifest="crates/$crate/Cargo.toml"

	if ! git diff --cached --name-only | grep -q "^$src/"; then
		return 0
	fi
	if [ -n "$(staged_version "$manifest")" ]; then
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

# Any package: version was bumped → CHANGELOG must have a dated section
# for the new version. Catches the "bumped but left under [Unreleased]"
# mistake at commit time, before the deploy CI check has to.
check_version_promotion() {
	local manifest=$1
	local changelog=$2
	local new_version
	new_version=$(staged_version "$manifest")
	if [ -z "$new_version" ]; then
		return 0
	fi
	if [ ! -f "$changelog" ]; then
		echo "::error::$changelog missing" >&2
		return 1
	fi
	if changelog_has_section "$changelog" "$new_version"; then
		return 0
	fi

	cat >&2 <<EOF

  $manifest version bumped to $new_version but $changelog has no
  dated [$new_version] section.

  Promote [Unreleased] to '[$new_version] — YYYY-MM-DD' in the same
  commit. See CLAUDE.md "Contract crate versioning".

EOF
	return 1
}

###############################################################################
# CI checks
###############################################################################

check_changelog() {
	local consumer_version=$1
	local changelog=$2
	local core_v="${3:-}"
	local wasm_v="${4:-}"

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
	if [ -n "$core_v" ]; then
		if ! echo "$section" | grep -qE "verse-vault-core@$core_v"; then
			echo "::error::$changelog [$consumer_version] doesn't reference verse-vault-core@$core_v" >&2
			failed=1
		fi
	fi
	if [ -n "$wasm_v" ]; then
		if ! echo "$section" | grep -qE "verse-vault-wasm@$wasm_v"; then
			echo "::error::$changelog [$consumer_version] doesn't reference verse-vault-wasm@$wasm_v" >&2
			failed=1
		fi
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
			check_src_requires_bump "$crate" || failed=1
		done
		check_version_promotion crates/core/Cargo.toml crates/core/CHANGELOG.md \
			|| failed=1
		check_version_promotion crates/wasm/Cargo.toml crates/wasm/CHANGELOG.md \
			|| failed=1
		check_version_promotion packages/api/package.json packages/api/CHANGELOG.md \
			|| failed=1
		check_version_promotion apps/web/package.json apps/web/CHANGELOG.md \
			|| failed=1
		check_version_promotion \
			deploy/vv-router/package.json deploy/vv-router/CHANGELOG.md \
			|| failed=1
		;;
	--ci)
		target="${TARGET:-api}"
		core_v=$(cargo_version crates/core/Cargo.toml)
		wasm_v=$(cargo_version crates/wasm/Cargo.toml)
		case "$target" in
			api)
				v=$(node -p "require('./packages/api/package.json').version")
				echo "  Verifying packages/api/CHANGELOG.md [$v] references core@$core_v, wasm@$wasm_v…"
				check_changelog "$v" packages/api/CHANGELOG.md "$core_v" "$wasm_v" \
					|| failed=1
				;;
			web)
				v=$(node -p "require('./apps/web/package.json').version")
				echo "  Verifying apps/web/CHANGELOG.md [$v] references core@$core_v, wasm@$wasm_v…"
				check_changelog "$v" apps/web/CHANGELOG.md "$core_v" "$wasm_v" \
					|| failed=1
				;;
			vv-router)
				v=$(node -p "require('./deploy/vv-router/package.json').version")
				echo "  Verifying deploy/vv-router/CHANGELOG.md has dated [$v]…"
				# Router doesn't bundle the contract crates — section-existence
				# check only.
				check_changelog "$v" deploy/vv-router/CHANGELOG.md \
					|| failed=1
				;;
			*)
				echo "Unknown --ci target: $target. Expected one of: api, web, vv-router" >&2
				exit 2
				;;
		esac
		if [ "$failed" -eq 0 ]; then
			echo "  OK."
		fi
		;;
	*)
		echo "Usage: $0 [pre-commit | --ci <api|web|vv-router>]" >&2
		exit 2
		;;
esac

exit "$failed"
