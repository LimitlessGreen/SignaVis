Developer Guide

Prerequisites
- Node.js (16+ recommended) and npm/yarn
- Git

Setup
1. Install dependencies:

   npm ci

2. Prepare repository (build css & install git hooks):

   npm run prepare

   The `prepare` script runs the CSS build and will attempt to install the repository git hooks by setting `core.hooksPath` to `githooks/`.

Git hooks
- Hooks live in the `githooks/` directory and are installed for the repository by the `prepare` step.
- The `pre-push` hook runs `npm run typecheck` and `npm test` before allowing a push.
- If you don't want automatic hook installation, run `git config core.hooksPath githooks` manually.

Syncing versions
- To sync the version from the `VERSION` file into `package.json` and `python-wrapper/pyproject.toml`, run:

   npm run version:sync

- This updates the files but does not create commits or tags. Commit the changes and create the release tag manually:

   git add -A
   git commit -m "chore(release): <version>"
   git tag -a v<version> -m "Release v<version>"
   git push origin main && git push origin v<version>

Release & publishing
- CI (GitHub Actions) performs the actual build and publish on tags; local scripts are intended to make local development consistent.

Useful scripts
- `npm run typecheck` — run the TypeScript checker (no emit)
- `npm test` — run the test suite
- `npm run sync:assets` — sync static assets (uses existing script)
- `npm run version:sync` — sync version from `VERSION` into project files
- `npm run mock-server` — start the mock HTTP analysis server for local E2E testing

Desktop app (Tauri)
- Requires the Rust toolchain: https://rustup.rs/
  ```
  curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
  rustup target add aarch64-apple-darwin  # macOS M-chip (if applicable)
  ```
- Install Tauri CLI and JS dependencies after Rust is available:
  ```
  npm install
  cargo install tauri-cli --version "^2"
  ```
- Start dev server with hot-reload:
  ```
  npm run desktop:dev
  ```
- Start desktop dev mode with internal gRPC server enabled:
  ```
  npm run desktop:dev:grpc
  ```
- Optional: route gRPC AnalysisService calls to an external HTTP backend:
  ```
  AW_ANALYSIS_HTTP_ENDPOINT=http://127.0.0.1:8787 npm run desktop:dev:grpc
  ```
  - `AW_ANALYSIS_HTTP_ENDPOINT`: base URL for `/analysis/*` passthrough endpoints.
  - `AW_ANALYSIS_HTTP_TIMEOUT_MS`: request timeout in milliseconds (default: `15000`).
  - `AW_GRPC_ADDR`: bind address for the internal gRPC server (default in script: `127.0.0.1:50051`).
- Build distributable:
  ```
  npm run desktop:build
  ```
- Project files are stored in the platform app-data directory:
  - Linux:   `~/.local/share/io.github.limitlessgreen.audio-workbench/projects/`
  - macOS:   `~/Library/Application Support/io.github.limitlessgreen.audio-workbench/projects/`
  - Windows: `%APPDATA%\io.github.limitlessgreen.audio-workbench\projects\`

Notes
- The new `scripts/sync-version.js` is a Node replacement for the previous shell+Python script and is cross-platform.
- If you prefer Husky for hooks, it's compatible with this approach; we chose a small repo-managed `githooks/` folder and `git config core.hooksPath` to keep installs simple.

If anything in this guide is unclear or you'd like a different hooks strategy (e.g., Husky), tell me and I'll adjust.