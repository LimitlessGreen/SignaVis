
# SignaVis

<p align="center">
  <img src="https://raw.githubusercontent.com/LimitlessGreen/SignaVis/main/docs/img/screenshot.png" alt="SignaVis Screenshot" width="900" />
</p>

<div align="center">
<table align="center" cellpadding="12" cellspacing="0" style="border:1px solid #e1e4e8;background:#f6f8fa;border-radius:6px;">
  <tr>
    <td align="center">
      <h3>💡 Try it — Demo</h3>
      <p>Interactive demo and a full labeling app (BirdNET detection &amp; annotation). Try them in your browser:</p>
      <p>
        <a href="https://limitlessgreen.github.io/SignaVis/"><img src="https://img.shields.io/badge/Live%20Demo-%E2%96%B6%20Open-brightgreen?style=for-the-badge" alt="Live Demo"/></a>
        <a href="https://limitlessgreen.github.io/SignaVis/demo/labeling-app.html?xcid=1"><img src="https://img.shields.io/badge/Labeling%20App-%E2%96%B6%20Open-blue?style=for-the-badge" alt="Labeling App"/></a>
      </p>
      <p>
        <a href="https://github.com/LimitlessGreen/SignaVis/actions/workflows/ci.yml"><img src="https://github.com/LimitlessGreen/SignaVis/actions/workflows/ci.yml/badge.svg" alt="CI"/></a>
        <a href="https://www.npmjs.com/package/signavis"><img src="https://img.shields.io/npm/v/signavis.svg" alt="NPM"/></a>
        <a href="https://pypi.org/project/signavis/"><img src="https://img.shields.io/pypi/v/signavis.svg" alt="PyPI"/></a>
        <a href="https://github.com/LimitlessGreen/SignaVis/blob/main/LICENSE"><img src="https://img.shields.io/badge/license-AGPL--3.0--only-blue.svg" alt="License"/></a>
      </p>
    </td>
  </tr>
</table>
</div>

DAW-like audio player (waveform + spectrogram + transport controls) as a standalone library — built for bioacoustic analysis, annotation, and embedding.

## Table of contents

- [Highlights](#-highlights)
- [Labeling app](#labeling-app)
- [Install](#install)
- [Quickstart](#quickstart)
- [Player Options](#player-options)
- [Usage Examples](#usage-examples)
- [Demos](#demos)
- [Python wrapper](#python-wrapper)
- [Development & releases](#development--releases)
- [Contributing](#contributing)
- [License](#license)

## ✨ Highlights

- **Fast, accurate spectrograms** — computed in Rust/WebAssembly and rendered on the GPU; presets, colour schemes, auto contrast, PCEN, log frequency
- **Synced waveform + spectrogram** with smooth zoom, scroll and playhead follow — also for long recordings
- **Label annotation** — draw, move, resize, undo/redo; *snap to call* boxes a call from a single click; zoom box and edit loupe for precise edges
- **BirdNET suggestions** — accept or discard detections in one click
- **Xeno-canto integration** — import recordings and their annotation sets, compare with reference calls, upload your labels as Annota-JSON sets
- **Projects** — stored in the browser or in a local folder (File System Access API), Raven export
- **Bat recordings** — time expansion, heterodyne, frequency division and pitch shift
- **Embeddable** — npm package (ESM / IIFE) and a Python wrapper for Jupyter, Streamlit and Gradio

## Labeling app

The [labeling app](https://limitlessgreen.github.io/SignaVis/demo/labeling-app.html?xcid=1) runs entirely in the browser — no install, no server.

| | |
|---|---|
| **Overview** — load a recording, zoom and play<br><img src="https://github.com/LimitlessGreen/SignaVis/releases/download/demo-media/overview.gif" alt="Overview" width="420"/> | **Labeling** — draw and name labels<br><img src="https://github.com/LimitlessGreen/SignaVis/releases/download/demo-media/labeling.gif" alt="Labeling" width="420"/> |
| **Snap to call** — one click boxes the call<br><img src="https://github.com/LimitlessGreen/SignaVis/releases/download/demo-media/snap.gif" alt="Snap to call" width="420"/> | **Zoom box & loupe** — precise box edges<br><img src="https://github.com/LimitlessGreen/SignaVis/releases/download/demo-media/magnifier.gif" alt="Zoom box and loupe" width="420"/> |
| **Display** — presets, colour schemes, contrast<br><img src="https://github.com/LimitlessGreen/SignaVis/releases/download/demo-media/display.gif" alt="Display settings" width="420"/> | |

The same UI is available as a desktop app (Tauri, preview) — installers are attached to each [release](https://github.com/LimitlessGreen/SignaVis/releases).

## Install

```bash
npm i signavis
```

Note: signavis expects `wavesurfer.js` as a peer dependency (v7). Install it with:

```bash
npm i wavesurfer.js@^7
```

Or include `wavesurfer.js` from a CDN in the browser:

```html
<script src="https://unpkg.com/wavesurfer.js@7"></script>
```

Or for Python:

```bash
pip install signavis
```

See [PyPI](https://pypi.org/project/signavis) and the [python-wrapper/README.md](python-wrapper/README.md) for full Python usage.

## Quickstart
```js
import { BirdNETPlayer } from 'signavis'
import 'signavis/style'

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
import { BirdNETPlayer } from 'signavis'
import 'signavis/style'

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
import { BirdNETPlayer } from 'signavis'
import 'signavis/style'

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
import { BirdNETPlayer } from 'signavis'
import 'signavis/style'

const root = ref(null)
let player

onMounted(() => { player = new BirdNETPlayer(root.value) })
onBeforeUnmount(() => player?.destroy())
```

### Svelte
```svelte
<script>
  import { onMount } from 'svelte'
  import { BirdNETPlayer } from 'signavis'
  import 'signavis/style'

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
<script src="https://unpkg.com/signavis/dist/birdnet-player.iife.js"></script>
<link rel="stylesheet" href="https://unpkg.com/signavis/dist/birdnet-player.css" />
<div id="player"></div>
<script>
  const player = new BirdNETPlayerModule.BirdNETPlayer(document.getElementById('player'))
</script>
```

### Streamlit (Python)
```python
from signavis import render_daw_player
import streamlit.components.v1 as components

components.html(render_daw_player(audio_bytes), height=620, scrolling=False)
```

### Jupyter Notebook
```python
from IPython.display import HTML
from signavis import render_daw_player

HTML(render_daw_player(audio_bytes))
```

## Demos

- **[Live Demo (GitHub Pages)](https://limitlessgreen.github.io/SignaVis/)** — component storybook with configurable stories
- **[Labeling App](https://limitlessgreen.github.io/SignaVis/demo/labeling-app.html?xcid=1)** — full-featured annotation tool with BirdNET detection, Xeno-canto integration, label management and spectrogram settings (`demo/labeling-app.html`)
- **[Google Colab Demo Notebook](https://colab.research.google.com/github/LimitlessGreen/SignaVis/blob/main/python-wrapper/demo_colab.ipynb) [![Open In Colab](https://colab.research.google.com/assets/colab-badge.svg)](https://colab.research.google.com/github/LimitlessGreen/SignaVis/blob/main/python-wrapper/demo_colab.ipynb)**
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
pip install signavis
```

Docs & PyPI: https://pypi.org/project/signavis

## Development & releases

```bash
npm ci
npm run dev          # Vite dev server, labeling app at /demo/labeling-app.html
npm run typecheck
npm test
npm run build        # library + types into dist/ and types/
npm pack --dry-run   # inspect what would be published
```

Releases are cut with `bash scripts/release.sh <version>` (e.g. `1.0.1` or `1.1.0-rc.1`): it syncs the version across
`package.json`, `pyproject.toml` and the Tauri files, commits, tags and pushes. The tag triggers CI, which publishes
to npm (trusted publishing; pre-releases under the `next` dist-tag) and PyPI and creates a GitHub release with the
notes from [CHANGELOG.md](CHANGELOG.md) and the desktop installers.

The npm package includes the BirdNET model under `models/` (~79 MB). Demo GIFs are recorded with
`npm run demo:gifs` (see [tools/demo-gifs](tools/demo-gifs/README.md)) and attached to the `demo-media` release.

## Contributing

See the repository on GitHub and open issues/PRs: https://github.com/LimitlessGreen/SignaVis

## License

GNU AGPL-3.0
