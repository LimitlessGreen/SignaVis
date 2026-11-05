#!/usr/bin/env bash
# Cut a release: bash scripts/release.sh [<version>] [--no-push]
#
# Guards: clean tree, on main, tag not yet taken, CHANGELOG section present.
# Dates the CHANGELOG section if it still says "Unreleased", syncs all
# version files, runs typecheck + tests, commits, tags and (optionally) pushes.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${ROOT_DIR}"

NEW_VERSION=""
PUSH=1
for arg in "$@"; do
  case "${arg}" in
    --no-push) PUSH=0 ;;
    -*) echo "Unknown option: ${arg}" >&2; exit 1 ;;
    *) NEW_VERSION="${arg}" ;;
  esac
done

fail() { echo "release: $*" >&2; exit 1; }

# ── Guards ──────────────────────────────────────────────────────────
BRANCH="$(git rev-parse --abbrev-ref HEAD)"
[[ "${BRANCH}" == "main" ]] || fail "must run on main (current: ${BRANCH})"
[[ -z "$(git status --porcelain)" ]] || fail "working tree not clean — commit or stash first"

if [[ -n "${NEW_VERSION}" ]]; then
  [[ "${NEW_VERSION}" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.]+)?$ ]] || fail "not a SemVer version: ${NEW_VERSION}"
  printf '%s\n' "${NEW_VERSION}" > VERSION
fi
VERSION="$(tr -d '[:space:]' < VERSION)"
TAG="v${VERSION}"
BASE="${VERSION%%-*}"

git rev-parse -q --verify "refs/tags/${TAG}" >/dev/null && fail "tag ${TAG} already exists"
grep -qE "^## \[${BASE//./\\.}\] - " CHANGELOG.md || fail "CHANGELOG.md has no '## [${BASE}]' section"

# ── Prepare ─────────────────────────────────────────────────────────
# Date the CHANGELOG section (only for final releases, not pre-releases).
if [[ "${VERSION}" == "${BASE}" ]]; then
  TODAY="$(date -u +%Y-%m-%d)"
  sed -i -E "s/^## \[${BASE//./\\.}\] - Unreleased\s*$/## [${BASE}] - ${TODAY}/" CHANGELOG.md
fi

node ./scripts/sync-version.js
if [[ "${VERSION}" == "${BASE}" ]]; then
  RELEASE_CHECK=1 bash ./scripts/check-version-sync.sh
else
  bash ./scripts/check-version-sync.sh
fi

npm run typecheck
npm test

# ── Commit, tag, push ───────────────────────────────────────────────
git add VERSION CHANGELOG.md package.json python-wrapper/pyproject.toml \
        python-wrapper/signavis/__init__.py demo/storybook.html \
        src-tauri/tauri.conf.json src-tauri/Cargo.toml src-tauri/Cargo.lock CITATION.cff
git commit -m "release: ${TAG}"
git tag "${TAG}"

if [[ "${PUSH}" == 1 ]]; then
  git push origin main "${TAG}"
  echo "Release tag pushed: ${TAG}"
else
  echo "Tagged ${TAG} locally. Push with: git push origin main ${TAG}"
fi
