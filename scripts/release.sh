#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${ROOT_DIR}"

if [[ "${1:-}" != "" ]]; then
  printf '%s\n' "$1" > VERSION
  echo "Set VERSION to $1"
fi

bash ./scripts/sync-version.sh
bash ./scripts/check-version-sync.sh

VERSION="$(tr -d '[:space:]' < VERSION)"
TAG="v${VERSION}"

if git rev-parse "${TAG}" >/dev/null 2>&1; then
  echo "Tag ${TAG} already exists locally" >&2
  exit 1
fi

git add VERSION package.json python-wrapper/pyproject.toml demo/storybook.html
git commit -m "release: ${TAG}"
git tag "${TAG}"
git push origin main --tags

echo "Release tag pushed: ${TAG}"
