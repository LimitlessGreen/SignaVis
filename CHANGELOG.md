# Changelog

All notable changes to this project will be documented in this file.

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
