
> ⚠️ **Early development — Unstable**
>
> This project is in active early development. APIs, features, and build artifacts may change or break without notice. You're encouraged to try it and provide feedback, but do not expect a stable release or backward compatibility yet. If you require stability, pin to a specific commit or wait for an official release. Contributions and bug reports are welcome.

# audio-workbench

<p align="center">
  <img src="docs/img/screenshot.png" alt="Audio Workbench Screenshot" width="900" />
</p>

<p align="center">
  <a href="https://limitlessgreen.github.io/Audio-Workbench/">
    <img src="https://img.shields.io/badge/Live%20Demo-Open-brightgreen" alt="Live Demo" />
  </a>
  <a href="https://limitlessgreen.github.io/Audio-Workbench/demo/labeling-app.html?xcid=1">
    <img src="https://img.shields.io/badge/Labeling%20App-Open-blue" alt="Labeling App" />
  </a>
  <br />
  <strong><a href="https://limitlessgreen.github.io/Audio-Workbench/">▶ Live demo — Open in browser (GitHub Pages)</a></strong>
  <br />
  <strong><a href="https://limitlessgreen.github.io/Audio-Workbench/demo/labeling-app.html?xcid=1">🏷 Labeling App — BirdNET detection, annotation & Xeno-canto integration</a></strong>
</p>

[![CI](https://github.com/LimitlessGreen/Audio-Workbench/actions/workflows/ci.yml/badge.svg)](https://github.com/LimitlessGreen/Audio-Workbench/actions/workflows/ci.yml)
[![NPM](https://img.shields.io/npm/v/audio-workbench.svg)](https://www.npmjs.com/package/audio-workbench)
[![PyPI](https://img.shields.io/pypi/v/audio-workbench.svg)](https://pypi.org/project/audio-workbench/)
[![License](https://img.shields.io/badge/license-AGPL--3.0--only-blue.svg)](https://github.com/LimitlessGreen/Audio-Workbench/blob/main/LICENSE)

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
- **Vertical frequency zoom** — Shift+Wheel, dedicated V-slider, draggable scrollbar, freq-axis drag
- **Label annotations** — draw, drag, resize time×frequency boxes on the spectrogram
- **Label taxonomy** — customizable species presets with colors and keyboard shortcuts
- **Suggestion labels** — BirdNET detections shown with distinct "construction-fence" styling; accept (✓) to promote to manual or discard (✕)
- **Bandpass-filtered playback** — isolate and play back a specific time×frequency region via Web Audio
- **Xeno-canto integration** — search, preview and import recordings; auto-enrich labels with XC metadata
- **External spectrogram injection** — supply pre-computed Float32 data or a rendered image
- **Settings side-panel** — FFT size, max frequency, color scheme, display gain, auto contrast, zoom
- **Properties panel** — pin or hover to inspect label details; inline editing
- **Crosshair overlay** — real-time time + frequency readout
- **Compact preview modes** — hero transport, overlay mode, small embeds
 - **~231 tests** (as of 2026-04-14) — DSP, spectrogram utils, coordinate system, interaction state, transport state

## Install

```bash
npm i audio-workbench
```

Note: audio-workbench expects `wavesurfer.js` as a peer dependency (v7). Install it with:

```bash
npm i wavesurfer.js@^7
```

Or include `wavesurfer.js` from a CDN in the browser:

```html
<script src="https://unpkg.com/wavesurfer.js@7"></script>
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

## Development & Release

Supported Node versions for CI: 18, 20, 22.

Local development:

```bash
npm ci
npm run typecheck
npm test
npm run build
npm run build:css
# Inspect what would be published
npm pack --dry-run
```

Publishing via CI:

- The CI workflow runs on push and for tags; it publishes when a tag matching `v*` is pushed.
- To enable automatic publishing to npm, add an `NPM_TOKEN` secret in GitHub repository settings (Settings → Secrets → Actions → `NPM_TOKEN`).
- Create and push a semver tag to trigger a release:

```bash
git tag -a v0.3.1 -m "release v0.3.1"
git push origin v0.3.1
```


The release job will build artifacts, publish to npm and PyPI, and create a GitHub Release including built files.

How to create tokens & add GitHub secrets

- NPM (automation token): create an automation token on https://www.npmjs.com/settings/<your-username>/tokens (Create New Token → Automation). Copy the token and add it to your repository secrets as `NPM_TOKEN` (Settings → Secrets → Actions → New repository secret). You can also set it via the GitHub CLI:

```bash
gh secret set NPM_TOKEN --body 'PASTE_TOKEN_HERE' -R owner/repo
```

- PyPI: create an API token on https://pypi.org/manage/account/#api-tokens and add it as `PYPI_API_TOKEN` in repository secrets. The CI uses this secret when uploading the Python package.

Packaging notes:

- The package includes model files under `models/` (e.g., `models/birdnet-v2.4/`) — verify with `npm pack --dry-run`.

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

- **[Live Demo (GitHub Pages)](https://limitlessgreen.github.io/Audio-Workbench/)** — component storybook with configurable stories
- **[Labeling App](https://limitlessgreen.github.io/Audio-Workbench/demo/labeling-app.html?xcid=1)** — full-featured annotation tool with BirdNET detection, Xeno-canto integration, label management and spectrogram settings (`demo/labeling-app.html`)
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
