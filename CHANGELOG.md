# Changelog

All notable changes to this project will be documented in this file.

## [1.0.0] - Unreleased

First stable release. The static labeling app (GitHub Pages) and the `signavis`
npm / PyPI packages are considered production-ready; the Tauri desktop app is
still a preview.

### Highlights
- **New spectrogram engine** — all spectrograms are computed in Rust (`aw_dsp`,
  WebAssembly in the browser) and rendered on the GPU straight from dB data,
  including PCEN, magnitude and phase. Tiled pyramid for long recordings; the
  old JS DSP engine and the v1 engine are gone.
- **Labeling workflow for Xeno-canto** — labels are uploaded as Annota-JSON
  sets: upload assistant with a live checklist, label metadata from the XC
  value lists, recording context and map, selectable live / test server,
  import of XC "Download set" files, uploads kept as snapshots.
- **Project folders** — projects live in the browser (OPFS) or in a local
  folder via the File System Access API (`signavis-project/1` format), with a
  persistent XC audio cache and Raven export.
- **Unified explorer** — local files and Xeno-canto recordings in one folder
  tree; own labels in layers, imported sets shown as read-only layers that can
  be copied to your own labels.
- **Snap to call** — box a call from a single click.
- **Zoom box and edit loupe** — drag a field to zoom time and frequency onto
  it; a magnified view (with its own fine STFT) follows the cursor while moving
  or resizing labels; Shift for fine 1/4-speed dragging.
- **Reference calls** — dockable side-by-side comparison with XC references on
  the same time scale, filter chips, pinned references, GBIF species info.
- **Bat recordings** — time expansion, heterodyne (carrier tunable on the
  spectrogram), frequency division and real-time pitch shift; bat recordings
  are detected on load and a popup offers the modes with a preview.
- **Labels tab** — source → species → label tree with playback per segment.

### Added
- Spectrogram presets with *Classic* as default plus a spectrolipi preset;
  colour schemes W/B (inverse) and SpectroFlare; auto contrast from the visible
  spectrogram; auto vertical zoom to the active frequency band on load.
- Zoom widget with separate time / frequency halves, visible span and an Auto
  button; maximum zoom raised from 450 to 2000 px/s.
- Expert mode in the display panel hides advanced spectrogram settings.
- Smooth playhead follow with look-ahead; de-jittered playback position.
- Long MP3 recordings load via chunked decoding.
- Recording quality shown as an A–E traffic light; mini map in Properties.
- Time axis shows m:ss / h:mm:ss from one minute on.
- In-app dialogs replace browser `alert` / `confirm` / `prompt`.
- `tools/demo-gifs/` — scripted Playwright recordings of the demo GIFs.

### Changed
- Left sidebar reorganised into Project · Labels · Analysis · Upload; neutral
  surfaces, button tiers and clearer section headers throughout.
- Xeno-canto ids are always stored with prefix (`XC123`).
- BirdNET detections can no longer be uploaded to Xeno-canto, only own labels.
- Licence is sent with version (CC-BY-NC-SA-4.0).
- npm package no longer ships `docs/img/`; demo GIFs are attached to the
  GitHub release instead. `@tauri-apps/plugin-dialog` is now a dev dependency.
- Release notes are taken from this changelog.

### Fixed
- Scrolling, zooming and overview dragging stay at frame rate (channel-data
  cache, no per-frame `getChannelData`).
- Time-expanded segment playback no longer ends early.
- Stale view and overview window after container resize.
- Spectrogram coordinate mapping offset by the scrollbar height.
- Waveform label dragging no longer stops when the cursor leaves the area.
- Desktop: local recordings load through the asset protocol.

## [0.7.6] - 2026-05-11

### Added
- SNR computation in the Properties panel.
- Tauri 2 desktop app with installers (AppImage, MSI, DMG) built in CI;
  optional local gRPC analysis backend with HTTP passthrough (preview).
- Multi-user platform scaffold (auth/RBAC, jobs API, worker queue) for
  testing (preview).

### Changed
- Rebranded from Audio-Workbench to **SignaVis**.
- Demo libraries migrated from `demo/lib/*.js` to TypeScript in `src/`;
  PlayerState split into dedicated controllers.

### Fixed
- Release and version-sync scripts cover the Tauri files.

## [0.6.0] - 2026-04-27

### Added
- Reference view and initial tiling support.
- MkDocs documentation site.

### Changed
- Types are generated from TypeScript; tests run with Node's strip-types.

### Fixed
- Bulk rename applies tags to all selected labels; properties panel refreshes
  after inline edits.

## [0.5.0] - 2026-04-20

### Added
- IndexedDB-backed spectrogram cache.
- Read-only / AI annotations, annotator profile, recording manager and explorer.
- Geo map modal; BirdNET area-model infobox; context menu.
- Demo footer with deployed version.

### Fixed
- Duplicate XC annotations on save and export.
- Session set id restored on reload.

## [0.4.0] - 2026-04-17

### Added
- Multi-select bulk actions for labels with spectrogram selection sync.
- ModalManager and daily tips.
- Accordion label list.

### Changed
- AudioEngine introduced; PlayerState migrated to it.
- npm publishing via OIDC trusted publishing.

## [0.3.0] - 2026-04-09

### Added
- **Vertical frequency zoom** — Shift+Wheel on spectrogram, dedicated V-slider,
  draggable frequency scrollbar, left-drag on freq axis for panning.
- **Suggestion labels** — BirdNET detections rendered with diagonal-stripe
  "construction fence" border; accept (✓) promotes to manual, discard (✕) removes.
- **Xeno-canto loading UX** — no-key modal with inline key input, topbar API key
  indicator, auto re-import on key change, URL sync.
- **Right sidebar** — collapsible spectrogram settings panel and properties panel
  (pin or hover for label detail inspection with inline editing).
- **Overview label tracks** — grouped by origin with color-coded bars.
- **Label sidebar** — hierarchical grouping by origin → species with sticky headers,
  inline editing, tag badges, confidence scores.
- **Annotation action toolbar** — draw-mode toggle, copy/paste, undo/redo buttons.
- **Language selector** moved to top bar for quick taxonomy language switching.
- **Toolbar wrapping** — toolbar now wraps to two rows instead of hiding controls
  behind a "More" button.

### Fixed
- **Label positions on window resize / monitor change** — spectrogram now redraws
  in the resize handler, keeping CoordinateSystem and annotation overlay in sync.
- **Label horizontal jitter on zoom slider** — `zoomchange` event deferred until
  canvas dimensions and coords are actually updated.
- **Middle-mouse vertical drag inversion** — corrected sign in `_updateViewportPan()`.
- **Freq axis left-drag** — new vertical panning when already vertically zoomed.

### Changed
- Time axis zoom capped at 450 px/s (was 600) for better performance.
- Preset manager redesigned from modal to inline panel.
- Generic tags system for label metadata.
- Lucide icons throughout the UI.

## [0.2.0] - 2026-03-25

### Added
- **CoordinateSystem** — single source of truth for all time↔pixel, frequency↔pixel,
  frequency↔bin, frame and client→canvas coordinate mappings (`src/coordinateSystem.js`).
- **Crosshair overlay** with toggleable time/frequency/amplitude readout on the spectrogram.
- **Non-blocking recomputing overlay** shown during spectrogram recalculation.
- **`computeTime` event** emitted after the DSP pipeline completes, reporting duration.
- **Event filter panel** in Storybook event monitor (toggleable per event type).
- **Subtle pause icon on hover** in compact/hero transport overlay while playing.
- **Extensibility API** — window functions, DSP profiles, overlap zones, toolbar groups.
- **Slide-out settings panel** replacing the old toolbar settings groups.
- **Presets + direct DSP parameters** replacing the former Mode dropdown; PCEN is now
  independently toggleable.
- **Label drag uses pixel-space deltas** for perceptually linear feel on mel scale.
- **InteractionState FSM** (`src/interactionState.js`) replacing scattered interaction flags.
- **TypeScript `checkJs`** — zero errors across all source files.
- **Dependabot** for automated dependency updates.
- **GitHub Pages CI** for demo deployment.
- **110 tests** (up from 25) — coordinate-system (44), spectrogram pipeline (20),
  transport/player state, DSP, and more.

### Fixed
- **Playhead position in waveform-only hero mode** — `_updatePlayhead()` used
  `spectrogramCanvas.width` (default 300 px) instead of `coords.timeToScrollX()`.
- **Stale CoordinateSystem after zoom** — `_updateCoords()` now called when
  `pixelsPerSecond` changes.
- **All scroll↔time math** routed through `CoordinateSystem` (5 inline calculations removed).
- **Click-to-seek in hero/transport-overlay** now uses `scrollWidth` and auto-fit-view.
- **Auto-fit-on-ready removed** in transport-overlay — restores scrolling in compact views.
- **Mel filterbank power-normalisation** (rows sum to 1) and PCEN epsilon set to 1 × 10⁻¹⁰.
- **`detectMaxFrequency`** uses 95th-percentile energy; dynamic worker timeout.
- **Spectrogram shadow artifacts** in `buildSpectrogramGrayscale` eliminated.
- **Mel-aware frequency↔pixel mapping** for frequency labels, annotation boxes and axis.
- **Crosshair coordinate mapping** corrected for overlay, readout and mel bins.
- **Three spectrogram math bugs** fixed; PCEN constant hoisted.
- **Native sample rate preserved** with dynamic max-frequency options.

### Changed
- `_clientXToTime()` delegates to `coords.scrollXToTime()` — DOM-independent and testable.
- `spectrogramMode` removed — Perch / Classic are pure presets only.
- Deprecated `ui.js` and legacy `buildSpectrogramBaseImage` wrapper removed.
- README rewritten in English, converted to AsciiDoc with TOC and feature list.
- Storybook redesigned with global file loading.
- Vite updated from 7.3.1 to 8.0.2; `actions/checkout` 4→6, `actions/setup-node` 4→6,
  `actions/setup-python` 5→6.
- Build artifacts removed from version control.

## [0.1.0] - 2026-02-19

### Added
- **External spectrogram injection API** — two new modes:
  - `setSpectrogramData(data, nFrames, nMels, opts)` — inject raw Float32 spectrogram
    data (or base64-encoded). The player applies its own colorization pipeline.
  - `setSpectrogramImage(image, opts)` — inject a pre-rendered spectrogram image
    (data-URL, URL, HTMLImageElement, or HTMLCanvasElement). Bypasses all DSP.
  - `clearExternalSpectrogram()` — re-enables auto-compute from audio.
- **Python wrapper: `spectrogram_data` / `spectrogram_image` params** on
  `render_daw_player()` — pass pre-computed spectrograms from Python directly.
- **Python `_coerce_image_to_png_bytes()`** — accepts `matplotlib.figure.Figure`,
  `PIL.Image.Image`, `numpy.ndarray` (uint8), `io.BytesIO`, and raw `bytes`.
  Drop-in replacement for BirdNET-Analyzer's matplotlib spectrogram displays.
- **Python wrapper unit tests** (`python-wrapper/tests/test_renderer.py`).

### Fixed
- `detectMaxFrequency()` now correctly uses linear bin→Hz mapping in Classic
  mode (was using Mel mapping, yielding wrong frequencies).
- Mel filterbank now receives power spectrum (mag²) instead of magnitude,
  matching PCEN's expectation.
- FFT twiddle factors (cos/sin) are precomputed and cached per FFT size,
  reducing repeated trigonometric calls.
- Progressive PCEN smooth-state accumulator is now carried across chunk
  boundaries, eliminating discontinuity artifacts.

## [0.0.9] - 2026-02-19

### Added
- **Classic spectrogram mode** (XC-style): Linear frequency axis, power→dB scaling,
  Xeno-Canto warm-body color palette. Selectable via Mode dropdown.
- **Vite build system**: Library mode producing ESM + IIFE + CSS with sourcemaps.
  IIFE build has Web Worker inlined; ESM references separate worker file.
- **`src/dsp.js`**: Single source of truth for all DSP functions (FFT, Mel scale,
  filterbank, `computeSpectrogram`). Replaces 3× duplicated code.
- **`src/spectrogram.worker.js`**: Proper module worker importing from `dsp.js`.
- **24 new tests** (25 total): DSP functions, spectrogram utilities, transport state.
- **Vite dev mode**: `npm run dev` with HMR, root `index.html` for ESM development.
- **`REFACTORING.md`**: Architecture documentation and future decomposition plan.

### Changed
- CSS scoped to `.daw-shell *` — no more global `*{}` or `body{}` resets that
  break host pages.
- All template `id="..."` replaced with `data-aw="..."` data attributes —
  multiple player instances on the same page no longer conflict.
- CSS `#id` selectors replaced with `[data-aw]` attribute selectors.
- `spectrogram.js` reduced from 1177 to ~760 lines (DSP code + cache removed).
- `_generateSpectrogram()` always computes fresh — no stale cached data.
- Bundle size reduced: ESM 200 KB, IIFE 216 KB (down from 223 KB).

### Removed
- **IndexedDB spectrogram cache**: Removed all cache logic (`openSpectrogramCacheDb`,
  `getSpectrogramCacheEntry`, `putSpectrogramCacheEntry`, `buildSpectrogramCacheKey`,
  `sha256ArrayBuffer`). Was causing stale/incorrect spectrograms.

## [0.0.1] - 2026-02-18
- Initial standalone packaging of SignaVis Player library.
- Added npm package metadata and exports for ESM, IIFE, and CSS.
- Added TypeScript definitions in `types/index.d.ts`.
- Added interactive demo in `demo/index.html`.
- Added Python wrapper skeleton for Streamlit/HTML embedding.
- Added CI workflow and publish helper scripts.
