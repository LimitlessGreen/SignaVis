#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VERSION_FILE="${ROOT_DIR}/VERSION"

if [[ ! -f "${VERSION_FILE}" ]]; then
  echo "VERSION file not found at ${VERSION_FILE}" >&2
  exit 1
fi

VERSION="$(tr -d '[:space:]' < "${VERSION_FILE}")"
if [[ -z "${VERSION}" ]]; then
  echo "VERSION file is empty" >&2
  exit 1
fi

python - "$ROOT_DIR" "$VERSION" << 'PY'
from __future__ import annotations

import json
from pathlib import Path
import sys

root = Path(sys.argv[1])
version = sys.argv[2]

package_json = root / "package.json"
pyproject = root / "python-wrapper" / "pyproject.toml"

pkg = json.loads(package_json.read_text(encoding="utf-8"))
pkg["version"] = version
package_json.write_text(json.dumps(pkg, indent=2, ensure_ascii=True) + "\n", encoding="utf-8")

lines = pyproject.read_text(encoding="utf-8").splitlines(keepends=True)
in_project = False
updated = False
for i, line in enumerate(lines):
    stripped = line.strip()
    if stripped.startswith("[") and stripped.endswith("]"):
        in_project = stripped == "[project]"
        continue
    if in_project and line.startswith("version = "):
        lines[i] = f'version = "{version}"\n'
        updated = True
        break

if not updated:
    raise SystemExit("Could not find project.version in python-wrapper/pyproject.toml")

pyproject.write_text("".join(lines), encoding="utf-8")

# Sync storybook badge
import re
storybook = root / "demo" / "storybook.html"
if storybook.exists():
    html = storybook.read_text(encoding="utf-8")
    html = re.sub(
        r'<span class="badge">v[^<]*</span>',
        f'<span class="badge">v{version}</span>',
        html,
    )
    storybook.write_text(html, encoding="utf-8")

print(f"Synced package versions to {version}")
PY
