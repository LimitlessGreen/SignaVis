
# audio-workbench

<p align="center">
  <a href="https://limitlessgreen.github.io/Audio-Workbench/">
    <img src="https://img.shields.io/badge/Live%20Demo-Open-brightgreen" alt="Live Demo" />
  </a>
  <br />
  <strong><a href="https://limitlessgreen.github.io/Audio-Workbench/">▶ Live demo — Open in browser (GitHub Pages)</a></strong>
</p>

![CI](https://github.com/LimitlessGreen/Audio-Workbench/actions/workflows/ci.yml/badge.svg)
![NPM](https://img.shields.io/npm/v/audio-workbench.svg)
![PyPI](https://img.shields.io/pypi/v/audio-workbench.svg)
![License](https://img.shields.io/badge/license-MIT-blue.svg)

DAW-like audio player (waveform + spectrogram + transport controls) as a standalone library — built for bioacoustic analysis, annotation, and embedding.

## Table of contents

- [Features](#features)
- [Install](#install)
- [Quickstart](#quickstart)
- [Player Options](#player-options)
- [Usage Examples](#usage-examples)
- [API](#api)
- [Demos](#demos)
- [Python wrapper](#python-wrapper)
- [Contributing](#contributing)
- [License](#license)

## Features

- **Dual spectrogram presets** — Perch (mel + PCEN) and Classic (linear + dB)
- **Waveform + spectrogram** rendered side-by-side with synchronized scrolling and zoom
- **Label annotations** — draw, drag, resize time×frequency boxes on the spectrogram
- **Label taxonomy** — customizable species presets with colors and keyboard shortcuts
- **Bandpass-filtered playback** — isolate and play back a specific time×frequency region via Web Audio
- **External spectrogram injection** — supply pre-computed Float32 data or a rendered image
- **Settings side-panel** — FFT size, max frequency, color scheme, display gain, auto contrast, zoom
- **Crosshair overlay** — real-time time + frequency readout
- **Compact preview modes** — hero transport, overlay mode, small embeds
- **110+ tests** — DSP, spectrogram utils, coordinate system, interaction state, transport state

## Install

```bash
npm i audio-workbench
```

Or for Python:

```bash
pip install audio-workbench
```

See [PyPI](https://pypi.org/project/audio-workbench) and the [python-wrapper/README.md](python-wrapper/README.md) for full Python usage.

## Quickstart

```js
import { BirdNETPlayer } from 'audio-workbench'
import 'audio-workbench/style'

const player = new BirdNETPlayer(document.getElementById('player'))
await player.ready
```

## Player Options

| Option | Type | Default | Description |
|---|---|---|---|
| `viewMode` | string | `'both'` | `'both'`, `'waveform'`, `'spectrogram'` — visible analysis views |
| `transportStyle` | string | `'default'` | `'default'`, `'hero'` — transport button style |
| `transportOverlay` | boolean | `false` | Centered play overlay, no toolbar height |
| `showFileOpen` | boolean | `true` | Show Open button and file input |
| `showTransport` | boolean | `true` | Show transport controls (play/pause/stop) |
| `showTime` | boolean | `true` | Show time display |
| `showVolume` | boolean | `true` | Show volume controls |
| `showViewToggles` | boolean | `true` | Show Follow/Loop/Fit/Reset buttons |
| `showZoom` | boolean | `true` | Show zoom slider |
| `showFFTControls` | boolean | `true` | Show FFT size, max frequency, color scheme |
| `showDisplayGain` | boolean | `true` | Show floor/ceiling sliders, auto contrast |
| `showStatusbar` | boolean | `true` | Show bottom status bar |
| `showOverview` | boolean | `true` | Show overview navigator |
| `showWaveformTimeline` | boolean | `true` | Show bottom timeline in waveform view |
| `compactToolbar` | string | `'auto'` | `'auto'`, `'on'`, `'off'` — responsive toolbar compaction |
| `labelTaxonomy` | array | see docs | Custom label presets (name, color, shortcut) |
| ... | ... | ... | ... |

See the [API section](#api) for usage examples and more details.

## Usage Examples

### ESM (Vite / Vanilla)
```js
import { BirdNETPlayer } from 'audio-workbench'
import 'audio-workbench/style'

const player = new BirdNETPlayer(document.getElementById('player'))
await player.ready
```

### Load from URL
```js
await player.loadUrl('/audio/birdsong.mp3')
player.play()
```

### File Input
```js
const input = document.querySelector('#audio')
input.addEventListener('change', async () => {
  const file = input.files?.[0]
  if (!file) return
  await player.loadFile(file)
})
```

### React
```jsx
import { useEffect, useRef } from 'react'
import { BirdNETPlayer } from 'audio-workbench'
import 'audio-workbench/style'

export default function Player() {
  const ref = useRef(null)
  useEffect(() => {
    if (!ref.current) return
    const p = new BirdNETPlayer(ref.current)
    return () => p.destroy()
  }, [])
  return <div ref={ref} />
}
```

### Vue
```js
import { onMounted, onBeforeUnmount, ref } from 'vue'
import { BirdNETPlayer } from 'audio-workbench'
import 'audio-workbench/style'

const root = ref(null)
let player

onMounted(() => { player = new BirdNETPlayer(root.value) })
onBeforeUnmount(() => player?.destroy())
```

### Svelte
```svelte
<script>
  import { onMount } from 'svelte'
  import { BirdNETPlayer } from 'audio-workbench'
  import 'audio-workbench/style'

  let el
  let player
  onMount(() => {
    player = new BirdNETPlayer(el)
    return () => player.destroy()
  })
</script>

<div bind:this={el}></div>
```

### CDN / IIFE
```html
<script src="https://unpkg.com/wavesurfer.js@7"></script>
<script src="https://unpkg.com/audio-workbench/dist/birdnet-player.iife.js"></script>
<link rel="stylesheet" href="https://unpkg.com/audio-workbench/dist/birdnet-player.css" />
<div id="player"></div>
<script>
  const player = new BirdNETPlayerModule.BirdNETPlayer(document.getElementById('player'))
</script>
```

### Streamlit (Python)
```python
from audio_workbench import render_daw_player
import streamlit.components.v1 as components

components.html(render_daw_player(audio_bytes), height=620, scrolling=False)
```

### Jupyter Notebook
```python
from IPython.display import HTML
from audio_workbench import render_daw_player

HTML(render_daw_player(audio_bytes))
```

## Demos

- **[Live Demo (GitHub Pages)](https://limitlessgreen.github.io/Audio-Workbench/)**
- **[Google Colab Demo Notebook](https://colab.research.google.com/github/LimitlessGreen/Audio-Workbench/blob/main/python-wrapper/demo_colab.ipynb) [![Open In Colab](https://colab.research.google.com/assets/colab-badge.svg)](https://colab.research.google.com/github/LimitlessGreen/Audio-Workbench/blob/main/python-wrapper/demo_colab.ipynb)**
- **Streamlit:**
  ```bash
  streamlit run python-wrapper/demo_streamlit.py
  ```
- **Gradio:**
  ```bash
  pip install gradio
  python python-wrapper/demo_gradio.py
  ```

## Python wrapper

The Python wrapper allows embedding the player in Streamlit, Jupyter, and Gradio. See [python-wrapper/README.md](python-wrapper/README.md) for full usage, options, and advanced features.

Install:
```bash
pip install audio-workbench
```

Docs & PyPI: https://pypi.org/project/audio-workbench

## Contributing

See the repository on GitHub and open issues/PRs: https://github.com/LimitlessGreen/Audio-Workbench

## License

GNU AGPL-3.0

## Quickstart

```js
import { BirdNETPlayer } from 'audio-workbench'
import 'audio-workbench/style'

const player = new BirdNETPlayer(document.getElementById('player'))
await player.ready
```

## Package Contents

- `dist/birdnet-player.esm.js` — ESM build
- `dist/birdnet-player.iife.js` — IIFE build
- `dist/birdnet-player.css` — Styles
- `types/` — TypeScript declarations

## Python wrapper

Install via pip:

```bash
pip install audio-workbench
```

Docs & PyPI: https://pypi.org/project/audio-workbench

## Contributing

See the repository on GitHub and open issues/PRs: https://github.com/LimitlessGreen/Audio-Workbench

## License

AGPL-3.0-only
# audio-workbench

DAW-like audio player (waveform + spectrogram + transport controls) as a standalone library — built for bioacoustic analysis, annotation, and embedding.

## Install

```bash
npm i audio-workbench
```

WaveSurfer.js is loaded automatically via CDN — no extra install needed.

### Package Contents

- `dist/birdnet-player.esm.js` — ESM build (Web Worker as separate file)
- `dist/birdnet-player.iife.js` — CDN/IIFE build (Worker inlined)
- `dist/birdnet-player.css` — Styles
- `types/` — Auto-generated TypeScript declarations
- `src/dsp.js` — DSP core (FFT, mel filterbank, spectrogram)

## Quickstart

```js
import { BirdNETPlayer } from 'audio-workbench'
import 'audio-workbench/style'

const player = new BirdNETPlayer(document.getElementById('player'))
await player.ready
```

## Usage Examples

### ESM (Vite / Vanilla)
```js
import { BirdNETPlayer } from 'audio-workbench'
import 'audio-workbench/style'

const player = new BirdNETPlayer(document.getElementById('player'))
await player.ready
```

### Load from URL
```js
await player.loadUrl('/audio/birdsong.mp3')
player.play()
```

### File Input
```js
const input = document.querySelector('#audio')
input.addEventListener('change', async () => {
  const file = input.files?.[0]
  if (!file) return
  await player.loadFile(file)
})
```

### React
```jsx
import { useEffect, useRef } from 'react'
import { BirdNETPlayer } from 'audio-workbench'
import 'audio-workbench/style'

export default function Player() {
  const ref = useRef(null)
  useEffect(() => {
    if (!ref.current) return
    const p = new BirdNETPlayer(ref.current)
    return () => p.destroy()
  }, [])
  return <div ref={ref} />
}
```

### Vue
```js
import { onMounted, onBeforeUnmount, ref } from 'vue'
import { BirdNETPlayer } from 'audio-workbench'
import 'audio-workbench/style'

const root = ref(null)
let player

onMounted(() => { player = new BirdNETPlayer(root.value) })
onBeforeUnmount(() => player?.destroy())
```

### Svelte
```svelte
<script>
  import { onMount } from 'svelte'
  import { BirdNETPlayer } from 'audio-workbench'
  import 'audio-workbench/style'

  let el
  let player
  onMount(() => {
    player = new BirdNETPlayer(el)
    return () => player.destroy()
  })
</script>

<div bind:this={el}></div>
```

### CDN / IIFE
```html
<script src="https://unpkg.com/wavesurfer.js@7"></script>
<script src="https://unpkg.com/audio-workbench/dist/birdnet-player.iife.js"></script>
<link rel="stylesheet" href="https://unpkg.com/audio-workbench/dist/birdnet-player.css" />
<div id="player"></div>
<script>
  const player = new BirdNETPlayerModule.BirdNETPlayer(document.getElementById('player'))
</script>
```

### Streamlit (Python)
```python
from audio_workbench import render_daw_player
import streamlit.components.v1 as components

components.html(render_daw_player(audio_bytes), height=620, scrolling=False)
```

### Jupyter Notebook
```python
from IPython.display import HTML
from audio_workbench import render_daw_player

HTML(render_daw_player(audio_bytes))
```

### Electron / Tauri WebView
```js
import { BirdNETPlayer } from 'audio-workbench'
import 'audio-workbench/style'

const p = new BirdNETPlayer(document.getElementById('player'))
await p.loadUrl('file:///absolute/path/to/audio.wav')
```

## API

```ts
new BirdNETPlayer(container: HTMLElement, options?)
player.ready: Promise<BirdNETPlayer>
player.loadUrl(url: string): Promise<void>
player.loadFile(file: File): Promise<void>
player.currentTime: number
player.duration: number
player.play(): void
player.pause(): void
player.stop(): void
player.togglePlayPause(): void
player.destroy(): void
```

### Bandpass-Filtered Segment Playback

```ts
player.playBandpassedSegment(
  startSec: number, endSec: number,
  freqMinHz: number, freqMaxHz: number
): void
```

Plays back only the audio within the given time and frequency range using a Web Audio bandpass filter. Useful for isolating individual bird calls from a recording.

### Label Taxonomy

```ts
player.getLabelTaxonomy(): Array<{ name: string; color?: string; shortcut?: string }>
player.setLabelTaxonomy(items: Array<{ name: string; color?: string; shortcut?: string }>): void
player.applyTaxonomyToLabel(id: string, shortcutOrIndex: string | number): boolean
player.renameLabel(id: string, name: string): boolean
```

Default taxonomy: Bird Call (`1`), Song (`2`), Chirp (`3`), Noise (`4`). Fully customizable — set your own species list with colors and keyboard shortcuts.

### External Spectrogram Injection

```ts
// Inject raw Float32 spectrogram data — player applies its own colorization
player.setSpectrogramData(
  data: Float32Array | ArrayBuffer | string,  // string = base64
  nFrames: number, nMels: number,
  options?: { mode?: 'perch' | 'classic', sampleRate?: number }
): Promise<void>

// Inject a pre-rendered spectrogram image — bypasses all DSP
player.setSpectrogramImage(
  image: string | HTMLImageElement | HTMLCanvasElement,  // string = data-URL or URL
  options?: { sampleRate?: number }
): Promise<void>

// Re-enable auto-computation from audio
player.clearExternalSpectrogram(): Promise<void>
```

### Viewport Configuration

```ts
player.getPlaybackViewportConfig(): object
player.setPlaybackViewportConfig(config: object): object
```

### Event Listener

```ts
player.on(event: string, callback: Function): void
```

## Events

The player emits events via `player.on(event, callback)`:

| Event | Description |
|-------|-------------|
| `ready` | Audio decoded and spectrogram rendered |
| `timeupdate` | Playback position changed |
| `seek` | User seeked to a new position |
| `error` | Error during loading or processing |
| `progress` | Spectrogram computation progress (0–1) |
| `computeTime` | Spectrogram computation finished (duration in ms) |
| `selection` | User selected a time range on the spectrogram |
| `zoomchange` | Zoom level (pixels per second) changed |
| `viewresize` | Player container was resized |
| `spectrogramscalechange` | Max frequency or scale changed |
| `transportstatechange` | Transport state transition (play/pause/stop) |
| `transporttransitionblocked` | Invalid transport transition attempted |
| `followmodechange` | Follow mode changed (Free/Follow/Smooth) |
| `followconfigchange` | Follow configuration updated |
| `segmentplaystart` | Segment or bandpass playback started |
| `segmentplayend` | Segment playback ended |
| `segmentloop` | Segment looped |
| `labeltaxonomyapply` | Taxonomy preset applied to a label |

## Spectrogram Presets

Two spectrogram presets are available, selectable via the settings panel:

| Preset | Frequency Axis | Normalization | Default Color Scheme |
|--------|---------------|---------------|----------------------|
| **Perch** (default) | Mel scale (logarithmic) | PCEN (Per-Channel Energy Normalization) | Grayscale |
| **Classic** (XC-style) | Linear (direct FFT bins) | Power → dB | Xeno-Canto Warm-Body |

The Classic preset produces spectrograms visually matching [xeno-canto.org](https://xeno-canto.org).

## Settings Panel

A collapsible side panel provides full control over spectrogram rendering:

- **Presets** — Perch / Classic toggle
- **FFT** — Size (1024 / 2048 / 4096), max frequency (2 kHz–16 kHz), color scheme (6+ options)
- **Display Gain** — Floor / ceiling sliders, auto contrast
- **Zoom** — Pixels-per-second slider
- **Transport** — Volume, loop, fit-to-view controls

## Crosshair

Toggle the crosshair button to show a real-time overlay displaying the exact time and frequency at the mouse position. Coordinates are mel-aware — frequency readout matches the current scale (mel or linear).

## Label Editing

- Double-click a label to open the inline editor.
- Suggestions are based on previously used label names (reusable label library).
- Color is editable directly via a color picker in the inline editor.
- `Enter` saves, `Esc` discards.
- Taxonomy shortcuts with `1..9`: click a label to focus it, then press the shortcut key.
- Label dragging uses pixel-space deltas — dragging feels perceptually linear on both mel and linear scales.

## Follow Modes

- The follow button cycles: `Free` → `Follow` → `Smooth`.
- `Smooth` scrolls continuously instead of jumping to center.
- Follow/Smooth behavior is configurable (constructor + runtime):

```js
const player = new BirdNETPlayer(el, {
  followCatchupDurationMs: 280,
  followCatchupSeekDurationMs: 420,
  smoothLerp: 0.16,
  smoothSeekLerp: 0.07
})

player.setPlaybackViewportConfig({ smoothSeekFocusMs: 1700 })
```

## Compact Preview Modes

For small embeds, reduce the DAW layout to a minimal preview:

```js
const player = new BirdNETPlayer(el, {
  viewMode: 'spectrogram', // 'both' | 'waveform' | 'spectrogram'
  transportStyle: 'hero',  // large centered play button
  transportOverlay: true,  // overlayed, no toolbar height
  showWaveformTimeline: false,
  showOverview: false,
  showFileOpen: false,
  showStatusbar: false,
  showTime: false,
  showVolume: false
})
```

## Debug Performance Overlay

Enable the runtime performance overlay with:

- URL parameter: `?perf=1` (e.g. `demo/index.html?perf=1`)
- Constructor option: `new BirdNETPlayer(el, { enablePerfOverlay: true })`

Displays FPS, long frames, event rates, and transport state transitions.

## Tests

```bash
npm test          # 110 tests (DSP, Spectrogram Utils, Coordinate System,
                  #            Interaction State, Transport State)
```

Tests use Node.js native test runner (`node:test` + `node:assert/strict`).

## Build

```bash
npm run build     # Vite build (ESM + IIFE + CSS + sourcemaps + TypeScript declarations)
npm run dev       # Vite dev server with HMR (http://localhost:5173)
npm run typecheck # TypeScript type checking (checkJs)
```

The build uses [Vite](https://vitejs.dev/) in library mode:
- ESM build: Worker as a separate file
- IIFE build: Worker inlined (no extra network request)
- CSS extracted automatically
- Sourcemaps for both formats
- TypeScript declarations auto-generated from JSDoc

## Demos

| Demo | Mode | Start |
|------|------|-------|
| `http://localhost:5173/` | Dev (ESM, HMR) | `npm run dev` |
| `demo/index.html` | Production (IIFE from dist/) | Open file directly |
| `demo/storybook.html` | Interactive Stories | `npm run dev` |

The Storybook demo is also deployed to **GitHub Pages** on every push to `main`.

## Architecture

```
src/
├── BirdNETPlayer.js       Public API facade
├── PlayerState.js         Central state machine & orchestration
├── dsp.js                 DSP core (FFT, mel filterbank, PCEN, spectrogram)
├── spectrogram.js         Pipeline: compute → grayscale → GPU-colorize → render
├── spectrogram.worker.js  Web Worker (imports dsp.js)
├── coordinateSystem.js    Coordinate conversions (time↔pixel, freq↔pixel, mel-aware)
├── annotations.js         Spectrogram labels (draw, edit, drag, resize)
├── interactionState.js    Interaction FSM (idle, pan, drag, resize modes)
├── transportState.js      Transport FSM (stopped, playing, paused transitions)
├── template.js            HTML template (data-aw attributes, multi-instance safe)
├── player.css             Styles (CSS custom properties, scoped to .daw-shell)
├── waveform.js            Waveform rendering
├── gestures.js            Touch / mouse interaction layer
├── app.js                 Dev-mode entry point
├── constants.js           Configuration & defaults
├── utils.js               Utility functions
└── vite-env.d.ts          Vite environment types
```

## CI / CD

- **CI** (`.github/workflows/ci.yml`): Typecheck → Tests → Build → Version sync → Python validation (Node 22, Python 3.11)
- **GitHub Pages** (`.github/workflows/pages.yml`): Deploys `demo/storybook.html` on every push to `main`
- **Dependabot** (`.github/dependabot.yml`): Weekly updates for npm, pip, and GitHub Actions

## Release Runbook

Install git hooks (one-time):

```bash
npm run hooks:install
```

0. Set up npm Trusted Publishing (one-time):
   - npm package `audio-workbench` → Settings → Trusted publisher
   - GitHub owner/org: `limitlessgreen`, Repository: `Audio-Workbench`
   - Workflow file: `.github/workflows/ci.yml`

1. Bump version in `VERSION` only (single source of truth):

```bash
echo "X.Y.Z" > VERSION
npm run version:sync
npm run version:check
```

2. Verify build + packaging locally:

```bash
npm test
npm pack
cd python-wrapper
python -m pip install --upgrade build twine
python -m build
python -m twine check dist/*
```

3. Update `CHANGELOG.md`.

4. Create commit + tag (automated):

```bash
bash ./scripts/release.sh X.Y.Z
```

5. Publishing runs via GitHub Actions on tag `v*`:
   - npm: `publish-npm` job
   - PyPI: `publish-pypi` job

6. Optional manual fallback:

```bash
npm publish --access public
cd python-wrapper
python -m twine upload dist/*
```

## License

GNU AGPL-3.0
