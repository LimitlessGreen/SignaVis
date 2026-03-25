# Changelog

All notable changes to this project will be documented in this file.

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
- Initial standalone packaging of Audio Workbench Player library.
- Added npm package metadata and exports for ESM, IIFE, and CSS.
- Added TypeScript definitions in `types/index.d.ts`.
- Added interactive demo in `demo/index.html`.
- Added Python wrapper skeleton for Streamlit/HTML embedding.
- Added CI workflow and publish helper scripts.
