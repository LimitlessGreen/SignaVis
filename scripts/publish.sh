#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

cd "${ROOT_DIR}"
echo "==> Checking version sync"
bash ./scripts/check-version-sync.sh

echo "==> Running sync build"
bash ./scripts/build.sh

echo "==> Packing npm artifact"
npm pack

echo "==> Publishing npm package"
npm publish --access public

echo "==> Building Python package"
cd python-wrapper
python -m pip install --upgrade build twine
python -m build
python -m twine check dist/*

echo "==> Publishing Python package"
python -m twine upload dist/*

echo "✅ Publish complete"
