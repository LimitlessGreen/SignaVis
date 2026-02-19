# audio-workbench

DAW-ähnlicher Audio-Player (Waveform + Spektrogramm + Transport Controls) als eigenständige Library.

## Install

```bash
npm i audio-workbench
```

WaveSurfer.js wird automatisch per CDN geladen — kein extra Install nötig.

## Paketinhalt

- `dist/birdnet-player.esm.js` (ESM, Web Worker als separate Datei)
- `dist/birdnet-player.iife.js` (CDN/IIFE, Worker inlined)
- `dist/birdnet-player.css` (Styles)
- `types/index.d.ts` (TypeScript)
- `src/dsp.js` (DSP-Kernfunktionen: FFT, Mel-Filterbank, Spektrogramm)

## Quickstart

```js
import { BirdNETPlayer } from 'audio-workbench'
import 'audio-workbench/style'

const player = new BirdNETPlayer(document.getElementById('player'))
await player.ready
```

## 10 Usage Examples

### 1) ESM (Vite/Vanilla)
```js
import { BirdNETPlayer } from 'audio-workbench'
import 'audio-workbench/style'

const player = new BirdNETPlayer(document.getElementById('player'))
await player.ready
```

### 2) ESM + URL laden
```js
await player.loadUrl('/audio/birdsong.mp3')
player.play()
```

### 3) ESM + File Input
```js
const input = document.querySelector('#audio')
input.addEventListener('change', async () => {
  const file = input.files?.[0]
  if (!file) return
  await player.loadFile(file)
})
```

### 4) React
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

### 5) Vue
```js
import { onMounted, onBeforeUnmount, ref } from 'vue'
import { BirdNETPlayer } from 'audio-workbench'
import 'audio-workbench/style'

const root = ref(null)
let player

onMounted(() => { player = new BirdNETPlayer(root.value) })
onBeforeUnmount(() => player?.destroy())
```

### 6) Svelte
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

### 7) CDN / IIFE (Vanilla)
```html
<script src="https://unpkg.com/wavesurfer.js@7"></script>
<script src="https://unpkg.com/audio-workbench/dist/birdnet-player.iife.js"></script>
<link rel="stylesheet" href="https://unpkg.com/audio-workbench/dist/birdnet-player.css" />
<div id="player"></div>
<script>
  const player = new BirdNETPlayerModule.BirdNETPlayer(document.getElementById('player'))
</script>
```

### 8) Streamlit (Python)
```python
from audio_workbench import render_daw_player
import streamlit as st
import streamlit.components.v1 as components

components.html(render_daw_player(audio_bytes), height=620, scrolling=False)
```

### 9) Jupyter Notebook
```python
from IPython.display import HTML
from audio_workbench import render_daw_player

HTML(render_daw_player(audio_bytes))
```

### 10) Electron / Tauri WebView
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
player.playBandpassedSegment(startSec: number, endSec: number, freqMinHz: number, freqMaxHz: number): void
player.renameLabel(id: string, name: string): boolean
player.getLabelTaxonomy(): Array<{ name: string; color?: string; shortcut?: string }>
player.setLabelTaxonomy(items: Array<{ name: string; color?: string; shortcut?: string }>): void
player.applyTaxonomyToLabel(id: string, shortcutOrIndex: string | number): boolean
player.getPlaybackViewportConfig(): object
player.setPlaybackViewportConfig(config: object): object
player.destroy(): void
```

## Spektrogramm-Modi

Der Player bietet zwei Spektrogramm-Modi, wählbar über das Mode-Dropdown:

| Modus | Frequenzachse | Normalisierung | Farbpalette |
|-------|---------------|----------------|-------------|
| **Perch** (Standard) | Mel-Skala (logarithmisch) | PCEN (Per-Channel Energy Normalization) | Grayscale / frei wählbar |
| **Classic** (XC-Stil) | Linear (direkte FFT-Bins) | Power → dB-Skala | Xeno-Canto Warm-Body / frei wählbar |

Der Classic-Modus erzeugt Spektrogramme die optisch den Darstellungen auf [xeno-canto.org](https://xeno-canto.org) entsprechen.

## Debug Performance Overlay

Aktiviere das Laufzeit-Overlay mit:

- URL: `?perf=1` (z. B. `demo/index.html?perf=1`)
- oder Option: `new BirdNETPlayer(el, { enablePerfOverlay: true })`

Das Overlay zeigt u. a. FPS, Long-Frames, Eventraten und Transport-State-Transitions.

## Label Editing

- Doppelklick auf ein Label öffnet einen Inline-Editor.
- Vorschläge basieren auf bereits verwendeten Label-Namen (wiederverwendbare Label-Library).
- Farbe ist im Inline-Editor direkt per Color-Picker editierbar.
- `Enter` speichert, `Esc` verwirft.
- Taxonomy-Presets mit `1..9` sind unterstützt:
  erst Label fokussieren (anklicken), dann Shortcut drücken.

## Follow Modes

- Follow-Button schaltet zyklisch: `Free` → `Follow` → `Smooth`.
- `Smooth` fährt kontinuierlich mit, statt in Sprüngen zu zentrieren.
- Follow/Smooth Verhalten ist konfigurierbar (Constructor + Runtime):

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

Für kleine Embeds kannst du den DAW-Look auf ein Vorschaufenster reduzieren:

```js
const player = new BirdNETPlayer(el, {
  viewMode: 'spectrogram', // 'both' | 'waveform' | 'spectrogram'
  transportStyle: 'hero',  // großer Play-Button
  transportOverlay: true,  // zentriert, ohne Toolbar-Höhe
  showWaveformTimeline: false,
  showOverview: false,
  showFileOpen: false,
  showStatusbar: false,
  showTime: false,
  showVolume: false
})
```

## Tests

```bash
npm test          # 25 Tests (DSP, Spectrogram Utils, Transport State)
```

## Build

```bash
npm run build     # Vite build (ESM + IIFE + CSS + Sourcemaps + TypeScript)
npm run dev       # Vite dev server mit HMR (öffnet http://localhost:5173)
```

Der Build nutzt [Vite](https://vitejs.dev/) im Library-Mode:
- ESM-Build: Worker als separate Datei
- IIFE-Build: Worker inlined (kein zusätzlicher Netzwerk-Request)
- CSS wird automatisch extrahiert
- Sourcemaps für beide Formate
- TypeScript Declarations aus JSDoc generiert

## Demos

| Demo | Modus | Starten |
|------|-------|---------|
| `http://localhost:5173/` | Dev (ESM, HMR) | `npm run dev` |
| `demo/index.html` | Produktion (IIFE aus dist/) | Datei direkt öffnen |
| `demo/storybook.html` | Interactive Stories | `npm run dev` |

## Architektur

```
src/
├── BirdNETPlayer.js    Public API Facade
├── PlayerState.js      Zentraler State & Orchestrierung
├── dsp.js              DSP-Kernfunktionen (FFT, Mel, Filterbank)
├── spectrogram.js      Pipeline: Compute → Grayscale → GPU-Colorize → Render
├── spectrogram.worker.js  Web Worker (importiert dsp.js)
├── template.js         HTML-Template (data-aw Attribute, multi-instance-fähig)
├── player.css          Styles (CSS Custom Properties, scoped auf .daw-shell)
├── annotations.js      Amplitude + Spektrogramm Labels
├── waveform.js         Waveform-Rendering
├── gestures.js         Touch/Mouse Interaction
├── utils.js            Hilfsfunktionen
└── constants.js        Konfiguration & Defaults
```

## Release Runbook

Git hooks einmalig installieren:

```bash
npm run hooks:install
```

0. Einmalig npm Trusted Publishing einrichten:
- npm Package `audio-workbench` -> `Settings` -> `Trusted publisher`
- GitHub owner/org: `limitlessgreen`
- Repository: `Audio-Workbench`
- Workflow file: `.github/workflows/ci.yml`

1. Version nur in `VERSION` erhöhen (Single Source of Truth):

```bash
echo "X.Y.Z" > VERSION
npm run version:sync
npm run version:check
```

2. Build + Packaging lokal prüfen:

```bash
npm test
npm pack
cd python-wrapper
python -m pip install --upgrade build twine
python -m build
python -m twine check dist/*
```

3. Changelog aktualisieren (`CHANGELOG.md`).

4. Commit + Tag erstellen (automatisiert):

```bash
bash ./scripts/release.sh X.Y.Z
```

5. Veröffentlichung läuft über GitHub Actions bei Tag `v*`:
- npm: `publish-npm`
- PyPI: `publish-pypi`

6. Optional manueller Fallback:

```bash
npm publish --access public
cd python-wrapper
python -m twine upload dist/*
```

## License

GNU AGPL-3.0
