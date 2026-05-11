#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

python - "$ROOT_DIR" << 'PY'
from __future__ import annotations

import json
import os
from pathlib import Path
import re
import sys

# Prefer the stdlib `tomllib` (Python 3.11+). If not available, fall back to a
# small, robust text-parser that extracts `project.version` from `pyproject.toml`.
try:
    import tomllib  # type: ignore
except Exception:
    tomllib = None

root = Path(sys.argv[1])
version = (root / "VERSION").read_text(encoding="utf-8").strip()
pkg_version = json.loads((root / "package.json").read_text(encoding="utf-8"))["version"]

pyproject_path = root / "python-wrapper" / "pyproject.toml"
py_text = pyproject_path.read_text(encoding="utf-8")
if tomllib is not None:
    py_version = tomllib.loads(py_text)["project"]["version"]
else:
    # Fallback: locate the [project] table and read the first `version = "x"` line
    in_project = False
    py_version = None
    for line in py_text.splitlines():
        s = line.strip()
        if s.startswith("[") and s.endswith("]"):
            in_project = s == "[project]"
            continue
        if in_project and s.startswith("version"):
            m = re.match(r'version\s*=\s*"([^"]+)"', s)
            if m:
                py_version = m.group(1)
                break
    if py_version is None:
        raise SystemExit("Could not parse project.version from python-wrapper/pyproject.toml")

errors = []
if not version:
    errors.append("VERSION is empty")
if pkg_version != version:
    errors.append(f"package.json version ({pkg_version}) does not match VERSION ({version})")
if py_version != version:
    errors.append(f"python-wrapper/pyproject.toml version ({py_version}) does not match VERSION ({version})")

# Check src-tauri/tauri.conf.json
tauri_conf = root / "src-tauri" / "tauri.conf.json"
if tauri_conf.exists():
    tauri_version = json.loads(tauri_conf.read_text(encoding="utf-8")).get("version", "")
    if tauri_version != version:
        errors.append(f"src-tauri/tauri.conf.json version ({tauri_version}) does not match VERSION ({version})")

# Check src-tauri/Cargo.toml [package] version
cargo_toml = root / "src-tauri" / "Cargo.toml"
if cargo_toml.exists():
    in_pkg = False
    cargo_version = None
    for line in cargo_toml.read_text(encoding="utf-8").splitlines():
        s = line.strip()
        if s.startswith("[") and s.endswith("]"):
            in_pkg = s == "[package]"
            continue
        if in_pkg and s.startswith("version"):
            m = re.match(r'version\s*=\s*"([^"]+)"', s)
            if m:
                cargo_version = m.group(1)
                break
    if cargo_version is not None and cargo_version != version:
        errors.append(f"src-tauri/Cargo.toml version ({cargo_version}) does not match VERSION ({version})")

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
