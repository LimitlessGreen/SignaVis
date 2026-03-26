#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

python - "$ROOT_DIR" << 'PY'
from __future__ import annotations

import json
import os
from pathlib import Path
import sys
import tomllib

root = Path(sys.argv[1])
version = (root / "VERSION").read_text(encoding="utf-8").strip()
pkg_version = json.loads((root / "package.json").read_text(encoding="utf-8"))["version"]
py_version = tomllib.loads((root / "python-wrapper" / "pyproject.toml").read_text(encoding="utf-8"))["project"]["version"]

errors = []
if not version:
    errors.append("VERSION is empty")
if pkg_version != version:
    errors.append(f"package.json version ({pkg_version}) does not match VERSION ({version})")
if py_version != version:
    errors.append(f"python-wrapper/pyproject.toml version ({py_version}) does not match VERSION ({version})")

# Check storybook badge
import re
storybook = root / "demo" / "storybook.html"
if storybook.exists():
    html = storybook.read_text(encoding="utf-8")
    m = re.search(r'<span class="badge">v([^<]*)</span>', html)
    if m and m.group(1) != version:
        errors.append(f"demo/storybook.html badge (v{m.group(1)}) does not match VERSION ({version})")

# On GitHub tag builds, ensure tag and version match exactly: vX.Y.Z <-> X.Y.Z
gh_ref_type = os.getenv("GITHUB_REF_TYPE", "")
gh_ref_name = os.getenv("GITHUB_REF_NAME", "")
if gh_ref_type == "tag" and gh_ref_name:
    expected_tag = f"v{version}"
    if gh_ref_name != expected_tag:
        errors.append(f"Git tag ({gh_ref_name}) does not match VERSION tag ({expected_tag})")

if errors:
    print("Version sync check failed:")
    for err in errors:
        print(f"- {err}")
    raise SystemExit(1)

print(f"Version sync check passed ({version})")
PY
