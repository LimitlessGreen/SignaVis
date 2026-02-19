# Audio-Workbench – Refactoring Plan

## Completed (this session)

### 1. CSS Scoping
- Removed `* { margin:0; padding:0; box-sizing:border-box }` global reset
- Removed `body { height:100vh; overflow:hidden }` host-page override
- Scoped to `.daw-shell *` – embedding no longer breaks host layout

### 2. Multi-Instance Support
- Replaced all `id="..."` in template.js with `data-aw="..."` attributes
- Updated `_queryDom()` to use `[data-aw="..."]` selectors (already scoped to root)
- Updated 4 CSS `#id` selectors → `[data-aw="..."]` selectors
- Multiple player instances on the same page no longer conflict

### 3. Build System (Vite)
- Added `vite.config.js` with library mode (ESM + IIFE + CSS)
- `npm run build` → Vite build + type generation
- `npm run dev` → Vite dev server with HMR
- Sourcemaps generated automatically
- Worker inlined in IIFE build; separate file for ESM

### 4. DSP Code Deduplication
- Created `src/dsp.js` as single source of truth for all DSP functions
- Created `src/spectrogram.worker.js` as a proper module (imports from dsp.js)
- Removed ~340 lines of duplicated code from spectrogram.js
- Main-thread fallback now calls `computeSpectrogram()` directly from dsp.js
- spectrogram.js: 1177 → 856 lines

### 5. Tests
- Added 24 new tests (27 total, was 3)
- `tests/dsp.test.mjs` — mel scale, filterbank, FFT, computeSpectrogram
- `tests/spectrogram-utils.test.mjs` — amplitude peak, stats, cache keys

### 6. TypeScript Declarations
- Auto-generated from JSDoc via `tsc --declaration --allowJs`
- New `dsp.d.ts` with fully typed `computeSpectrogram()` interface

---

## Planned – PlayerState Decomposition

The `PlayerState.js` god-object (2423 lines, ~99 methods) should be decomposed
into focused modules. This is high-risk and requires incremental migration with
thorough manual testing.

### Target Architecture

```
PlayerState.js      (orchestrator, ~600 lines)
├── AudioEngine.js  (WaveSurfer, transport, segments, volume)
├── ViewportController.js  (zoom, scroll, follow mode, overview)
├── SpectrogramPipeline.js (compute → cache → grayscale → colorize → draw)
└── InteractionManager.js  (mouse, keyboard, touch handlers)
```

### Phase 1: AudioEngine Extraction (~530 lines)

**What moves:**
- WaveSurfer lifecycle (`_setupWaveSurfer`, create/destroy)
- Transport controls (`_togglePlayPause`, `_stopPlayback`, seek methods)
- Volume management (`_setVolume`, `_toggleMute`)
- Custom segment playback (bandpass pipeline, 10 methods)
- Audio decoding & metadata

**Interface:**
```javascript
class AudioEngine extends EventTarget {
    constructor(WaveSurferCtor)
    async loadBuffer(audioBuffer, source)
    play() / pause() / stop()
    seekToTime(t) / seekByDelta(dt) / getCurrentTime()
    setVolume(v) / toggleMute()
    playSegment(start, end, opts)
    playBandpassedSegment(start, end, fLo, fHi, opts)
    stopSegmentPlayback()
    // Events: 'ready', 'timeupdate', 'play', 'pause', 'finish',
    //         'segmentstart', 'segmentend', 'segmentloop', 'error'
}
```

**Migration steps:**
1. Create AudioEngine class with event system
2. Move state properties (wavesurfer, audioBuffer, volume, segment state)
3. Move methods one by one, replacing `this.d.xxx` with events
4. Update PlayerState to create AudioEngine and subscribe to events
5. Verify build + manual test with audio playback

### Phase 2: ViewportController Extraction (~320 lines)

**What moves:**
- Zoom/scroll (`_setPixelsPerSecond`, `_fitEntireTrackInView`, `_zoomByScale`)
- Scroll sync (`_setLinkedScrollLeft`, `_getPrimaryScrollWrapper`)
- Follow mode (`_cycleFollowMode`, `_animateFollowCatchupTo`, `_applySmoothFollow`)
- Overview navigator (7 methods)

**Interface:**
```javascript
class ViewportController {
    constructor(dom, options)
    setPixelsPerSecond(pps, anchorTime)
    fitToView(duration)
    zoomByScale(factor, anchorTime)
    centerAtTime(t)
    clientXToTime(clientX)
    syncOverviewWindow()
    // Follow-mode API
    cycleFollowMode()
    updatePlayhead(time, isPlaying)
}
```

### Phase 3: SpectrogramPipeline (optional, lower priority)

Already well-structured in `spectrogram.js`. The pipeline methods in
PlayerState (`_generateSpectrogram`, `_buildSpectrogramGrayscale`, etc.) are
thin orchestration calls that could stay in PlayerState or move to a dedicated
coordinator.

### Phase 4: InteractionManager (optional, low priority)

The `_bindEvents` method (223 lines) and handler methods (~174 lines) are
tightly coupled to DOM and other modules. Extraction benefit is marginal
compared to risk.

---

## Future Improvements

- **Minified production build**: Set `minify: true` in `vite.config.js`
- **CSS custom properties documentation**: Document the 18 theming variables
- **Accessibility audit**: ARIA roles, keyboard navigation completeness
- **Bundle analysis**: `npx vite-bundle-visualizer` for size optimization
- **E2E tests**: Playwright/Puppeteer for browser-based integration tests
