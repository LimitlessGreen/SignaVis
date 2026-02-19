#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
PARENT_DIR="$(cd "${ROOT_DIR}/.." && pwd)"

PARENT_SRC="${PARENT_DIR}/src/player"
PARENT_DIST="${PARENT_DIR}/dist"

if [[ -d "${PARENT_SRC}" && -d "${PARENT_DIST}" ]]; then
  echo "==> Legacy sync mode: parent project detected (${PARENT_DIR})"
  mkdir -p "${ROOT_DIR}/src" "${ROOT_DIR}/dist"
  rm -rf "${ROOT_DIR}/src"/* "${ROOT_DIR}/dist"/*
  cp -a "${PARENT_SRC}/." "${ROOT_DIR}/src/"
  cp -a "${PARENT_DIST}/." "${ROOT_DIR}/dist/"
  echo "✅ src/dist synchronized from parent"
else
  echo "==> Standalone mode: using in-repo src/dist (no parent sync)"
  if [[ ! -f "${ROOT_DIR}/src/BirdNETPlayer.js" ]]; then
    echo "❌ Missing ${ROOT_DIR}/src/BirdNETPlayer.js" >&2
    exit 1
  fi
  if [[ ! -f "${ROOT_DIR}/dist/birdnet-player.esm.js" || ! -f "${ROOT_DIR}/dist/birdnet-player.iife.js" ]]; then
    echo "❌ Missing dist bundles. Commit/generate dist artifacts before release." >&2
    exit 1
  fi
fi

echo "==> Generating type declarations"
node ./scripts/generate-types.js
echo "✅ Build complete ($(date '+%Y-%m-%d %H:%M:%S'))"
