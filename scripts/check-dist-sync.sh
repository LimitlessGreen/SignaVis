#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${ROOT_DIR}"

BASE_REF="${1:-}"
if [[ -z "${BASE_REF}" ]]; then
  if git rev-parse --verify origin/main >/dev/null 2>&1; then
    BASE_REF="origin/main"
  elif git rev-parse --verify HEAD~1 >/dev/null 2>&1; then
    BASE_REF="HEAD~1"
  else
    echo "dist sync check skipped: no base ref available"
    exit 0
  fi
fi

CHANGED_FILES="$(git diff --name-only "${BASE_REF}...HEAD")"
if [[ -z "${CHANGED_FILES}" ]]; then
  echo "dist sync check passed: no file changes vs ${BASE_REF}"
  exit 0
fi

if grep -qE '^src/' <<< "${CHANGED_FILES}"; then
  if ! grep -qE '^dist/' <<< "${CHANGED_FILES}"; then
    echo "dist sync check failed: src/ changed but dist/ did not." >&2
    echo "Changed files vs ${BASE_REF}:" >&2
    echo "${CHANGED_FILES}" >&2
    echo "Run your build pipeline and commit updated dist artifacts." >&2
    exit 1
  fi
fi

echo "dist sync check passed"
