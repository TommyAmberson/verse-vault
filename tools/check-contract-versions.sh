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
#     a) crates/<core|wasm>/src/ changes on a branch whose Cargo.toml
#        version still matches the version where the branch left master.
#        One bump per pull request covers every crate change in it.
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
#   --pr <base>: the PR-level twin of (a), run by CI against the base the
#     PR merges into. Catches a missing bump that skipped the hook
#     (`--no-verify`, or commits rewritten by rebase or cherry-pick, which
#     don't run pre-commit).
#
# Refactor that's truly a no-op? Bypass pre-commit with `--no-verify`,
# or the CI check by ensuring the changelog explicitly notes that the
# contract crate versions are unchanged from the previous release.
#
# See CONTRIBUTING.md "Contract crate versioning" and top-level `CHANGELOG.md`.

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

# Version a manifest declares at a git ref, or in the index when <ref> is
# empty. The first matching line is the package's own version in both
# forms. awk reads to EOF for the same SIGPIPE reason as below.
version_at() {
	local ref=$1
	local manifest=$2
	git show "$ref:$manifest" 2>/dev/null | awk '
		!v && (/^version = / || /^  "version":/) { v = $0 }
		END { if (v) { n = split(v, part, "\""); print part[n - 1] } }
	'
}

# The commit where the current branch left master. Uses whichever of
# origin/master and master forked most recently, so a stale ref can't
# hide a bump master already made. Prints nothing if neither exists.
branch_base() {
	local base="" ref mb
	for ref in origin/master master; do
		git rev-parse -q --verify "$ref^{commit}" >/dev/null || continue
		mb=$(git merge-base HEAD "$ref" 2>/dev/null) || continue
		if [ -z "$base" ] || git merge-base --is-ancestor "$base" "$mb"; then
			base=$mb
		fi
	done
	echo "$base"
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

# True iff the changelog at <ref> (the index when empty) has a dated
# `## [X.Y.Z] - YYYY-MM-DD` header (i.e. promoted, not the bare
# `## [Unreleased]`) for the given version. Reading the index rather than
# the working tree means an unstaged section doesn't pass. The version is matched literally, so semver build metadata
# (`+`) isn't read as regex. awk reads to EOF: an early-exiting `grep -q`
# would SIGPIPE `git show` on a large changelog, which pipefail reads as a
# miss.
changelog_has_section() {
	local ref=$1
	local file=$2
	local version=$3
	git show "$ref:$file" 2>/dev/null | awk -v ver="$version" '
		index($0, "## [" ver "] ") == 1 && $0 ~ /[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]$/ { found = 1 }
		END { exit !found }
	'
}

###############################################################################
# Pre-commit checks
###############################################################################

# Contract-crate-only: src/ touched, but the branch hasn't bumped the
# crate since it left master. The bump may sit in this commit or any
# earlier one on the branch. Refactor escape valve is `--no-verify`.
check_src_requires_bump() {
	local crate=$1
	local src="crates/$crate/src"
	local manifest="crates/$crate/Cargo.toml"

	if ! git diff --cached --name-only | grep -q "^$src/"; then
		return 0
	fi

	local base base_v new_v
	base=$(branch_base)
	if [ -z "$base" ]; then
		# No master to compare against: fall back to this commit alone.
		[ -n "$(staged_version "$manifest")" ] && return 0
		base_v="(no master found)"
	else
		base_v=$(version_at "$base" "$manifest")
		new_v=$(version_at "" "$manifest")
		[ "$new_v" != "$base_v" ] && return 0
	fi

	cat >&2 <<EOF

  $src/ has staged changes, but $manifest "version" is still
  $base_v, the version this branch started from.

  '$crate' is a contract crate: its version is a compatibility signal
  across consumers. Bump it once on this branch if the change has any
  observable effect on memory model, scheduling, or wire format, with a
  dated CHANGELOG section. Later commits on the branch extend that
  section instead of bumping again.

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
	if changelog_has_section "" "$changelog" "$new_version"; then
		return 0
	fi

	cat >&2 <<EOF

  $manifest version bumped to $new_version but $changelog has no
  dated [$new_version] section.

  Promote [Unreleased] to '[$new_version] - YYYY-MM-DD' in the same
  commit. See CONTRIBUTING.md "Contract crate versioning".

EOF
	return 1
}

###############################################################################
# CI checks
###############################################################################

# PR-level twin of check_src_requires_bump: <base> is the commit the PR
# merges into, HEAD the PR (in CI, the merge of the two).
check_pr_bump() {
	local crate=$1
	local base=$2
	local src="crates/$crate/src"
	local manifest="crates/$crate/Cargo.toml"
	local changelog="crates/$crate/CHANGELOG.md"

	if git diff --quiet "$base" HEAD -- "$src"; then
		return 0
	fi

	local base_v head_v
	base_v=$(version_at "$base" "$manifest")
	head_v=$(version_at HEAD "$manifest")
	if [ "$head_v" = "$base_v" ]; then
		echo "::error::$src changed but $manifest is still $base_v; bump it once in this PR" >&2
		return 1
	fi
	if ! changelog_has_section HEAD "$changelog" "$head_v"; then
		echo "::error::$changelog has no dated [$head_v] section" >&2
		return 1
	fi
	echo "  $crate: $base_v -> $head_v, changelog dated. OK."
}

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
	--pr)
		base="${TARGET:-}"
		if [ -z "$base" ]; then
			echo "Usage: $0 --pr <base-ref>" >&2
			exit 2
		fi
		for crate in core wasm; do
			check_pr_bump "$crate" "$base" || failed=1
		done
		;;
	*)
		echo "Usage: $0 [pre-commit | --ci <api|web|vv-router> | --pr <base-ref>]" >&2
		exit 2
		;;
esac

exit "$failed"
