#!/usr/bin/env bash
# ───────────────────────────────────────────────────────────────────────
# sync-assets.sh — Build JS/CSS and copy into the Python wrapper assets
# ───────────────────────────────────────────────────────────────────────
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${ROOT_DIR}"

ASSETS_DIR="${ROOT_DIR}/python-wrapper/audio_workbench/assets"

if [[ "${1:-}" != "--no-build" ]]; then
  echo "▸ Building JS/CSS …"
  npm run build
fi

echo "▸ Syncing dist → python-wrapper assets …"
cp dist/birdnet-player.iife.js "${ASSETS_DIR}/birdnet-player.iife.js"
cp dist/birdnet-player.css     "${ASSETS_DIR}/birdnet-player.css"

echo "✅ Assets synced. Python wrapper will use the latest build."
