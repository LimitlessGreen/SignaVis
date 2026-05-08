# Deployment Modes & Migration Path

SignaVis supports three distinct deployment modes. They share the same
codebase and the same labeling UI; only the runtime backing changes. The
browser/static mode is **always** kept functional so the demo on GitHub Pages
remains reachable without any server or native install.

---

## Mode overview

| Mode | Who runs it | Analysis | Project storage | Suitable for |
|---|---|---|---|---|
| **Browser / static** | GitHub Pages, any static host | local WASM / none | `localStorage` / IndexedDB | Public demo, quick evaluation |
| **Desktop (no gRPC)** | Tauri native app | — | Platform app-data (JSON files) | Offline labeling without AI |
| **Desktop + gRPC** | Tauri native app (`--features grpc`) | local gRPC service → optional HTTP passthrough | Platform app-data | Full offline AI analysis or forwarded to BirdNET server |

---

## Mode 1 – Browser / static (GH Pages)

No build flags, no native runtime. The app is served as a plain static bundle.

```
npm run build          # produces dist/
# deploy dist/ to GitHub Pages / any CDN
```

The labeling app at `demo/labeling-app.html` (and the Vite-built bundle) uses
runtime checks (`window.__TAURI_INTERNALS__`) to detect whether Tauri is present.
When it is **not** present:

- `getDesktopRuntimeInfo()` returns `{ grpcEnabled: false, grpcAddr: null, analysisHttpEndpoint: null }`
- `createAnalysisBackend` will **not** use `TauriGrpcAnalysisBackend`
- All desktop-only code paths are unreachable; no import errors are thrown

No changes to `demo/labeling-app.html` are needed when deploying to GitHub Pages.
The static path is the **default**; desktop features are additive.

---

## Mode 2 – Desktop (without gRPC)

Standard Tauri build. Enables native project persistence; analysis features that
require the gRPC bridge are unavailable (commands return an explanatory error).

```
npm run desktop:dev     # development
npm run desktop:build   # distributable
```

---

## Mode 3 – Desktop + gRPC

Tauri build with the `grpc` Cargo feature. Starts an internal gRPC server on
`127.0.0.1:50051` (configurable). The labeling app detects the running server via
`get_desktop_runtime_info` and automatically switches the analysis backend to
`TauriGrpcAnalysisBackend`.

```
npm run desktop:dev:grpc            # development (stub responses)
npm run desktop:build -- --features grpc   # distributable with gRPC
```

### Environment variables (gRPC mode)

| Variable | Default | Purpose |
|---|---|---|
| `AW_GRPC_ADDR` | `127.0.0.1:50051` | Bind address for the internal gRPC server |
| `AW_ANALYSIS_HTTP_ENDPOINT` | _(unset)_ | Base URL of an external HTTP analysis backend; when unset, stub responses are returned |
| `AW_ANALYSIS_HTTP_TIMEOUT_MS` | `15000` | Request timeout for HTTP passthrough in milliseconds |
| `RUST_LOG` | `info` | Log filter for structured tracing output (e.g. `debug`, `warn`, `signavis_lib=debug`) |

### With a BirdNET backend

Point the passthrough at a running BirdNET Analyzer HTTP server:

```
AW_ANALYSIS_HTTP_ENDPOINT=http://127.0.0.1:8787 \
  npm run desktop:dev:grpc
```

The internal gRPC service will forward all analysis calls (`/analysis/load`,
`/analysis/location`, `/analysis/analyze`, `/analysis/species`) to that endpoint.

---

## Migration path

### Static → Desktop (no gRPC)

1. Install the Rust toolchain and Tauri CLI (see `DEVELOPER.md`).
2. Run `npm run desktop:dev` or distribute with `npm run desktop:build`.
3. Project files previously stored in `localStorage` are **not** automatically
   migrated; export/import via the UI before switching.

### Desktop → Desktop + gRPC (stub mode)

1. Rebuild with `--features grpc`: `npm run desktop:dev:grpc`.
2. In the labeling app, set the BirdNET backend mode to **Server** and leave the
   endpoint field empty. The gRPC bridge is used automatically.
3. Stub responses are returned for analysis calls until a real backend is connected.

### Desktop + gRPC → External BirdNET backend

1. Start a BirdNET Analyzer HTTP server (see `BirdNET-Analyzer/` or the Python
   wrapper in `python-wrapper/`).
2. Set `AW_ANALYSIS_HTTP_ENDPOINT` to the server base URL.
3. Restart the desktop app; the gRPC service will forward all analysis calls.

### Reverting to browser/static

The static mode is never removed; simply deploy `demo/labeling-app.html` or the
Vite bundle without any Tauri wrapper. All desktop-only code paths are guarded by
`isTauri()` / `getDesktopRuntimeInfo()` runtime checks and are inert in a browser.

---

## Architecture diagram

```
┌─────────────────────────────────────────────────────┐
│                  labeling-app.html                  │
│  (TypeScript frontend – same code in all modes)     │
│                                                     │
│  createAnalysisBackend({ mode, endpoint?,           │
│                          useTauriGrpc? })           │
│        │                                            │
│        ├─ mode='local'  → LocalAnalysisBackend      │
│        ├─ mode='server' + endpoint                  │
│        │       → HttpAnalysisBackend(endpoint)      │
│        └─ mode='server' + useTauriGrpc=true         │
│                → TauriGrpcAnalysisBackend ──┐       │
└────────────────────────────────────────────│────────┘
                                             │ Tauri IPC
                           ┌─────────────────▼───────────────┐
                           │   src-tauri  (Rust, grpc feat)  │
                           │                                 │
                           │  grpc_analysis_*  IPC commands  │
                           │           │                     │
                           │  internal gRPC server           │
                           │  (tonic, 127.0.0.1:50051)       │
                           │           │                     │
                           │  AnalysisServiceState           │
                           │    ├─ AW_ANALYSIS_HTTP_ENDPOINT │
                           │    │    set → HTTP passthrough  │
                           │    └─ unset → stub responses    │
                           └─────────────────────────────────┘
                                         │
                             (optional passthrough)
                                         │
                           ┌─────────────▼───────────────────┐
                           │  BirdNET Analyzer HTTP server   │
                           │  (Python, external process)     │
                           └─────────────────────────────────┘
```

---

## Static GH Pages guarantee

The browser path is the **default** and is protected by:

1. **No build-time desktop imports** in `demo/labeling-app.html` – Tauri modules
   are imported dynamically only after `isTauri()` returns `true`.
2. **`getDesktopRuntimeInfo()` fallback** – returns a safe `grpcEnabled: false`
   object when Tauri is not detected.
3. **`createAnalysisBackend` guard** – `useTauriGrpc` is only `true` when
   `canUseDesktopGrpc` (derived from `grpcEnabled`) is `true`; the browser
   never receives `TauriGrpcAnalysisBackend`.
4. **CI** – the `npm run build` and `npm test` steps run without any Rust/Tauri
   toolchain and must stay green.
