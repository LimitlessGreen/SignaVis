# Python / Gradio / Streamlit Integration Guide

Audio-Workbench kann in Python-Anwendungen über seinen IIFE-Bundle eingebettet werden.
Alle relevanten Typen sind in `types/index.d.ts` exportiert.

---

## Bundle-Format

```
dist/birdnet-player.iife.js   ← für <script>-Tags in Gradio/Streamlit HTML
dist/birdnet-player.esm.js    ← für ES-Module-Umgebungen
dist/birdnet-player.css       ← Stylesheet (immer einbinden)
```

Das IIFE-Bundle exportiert `window.BirdNETPlayerModule` mit allen Klassen.

---

## Minimal-Beispiel (Gradio Custom Component)

```python
import gradio as gr

with gr.Blocks() as demo:
    gr.HTML("""
    <link rel="stylesheet" href="/static/birdnet-player.css">
    <script src="/static/birdnet-player.iife.js"></script>
    <div id="player-root"></div>
    <script>
      const { BirdNETPlayer, MockAudioEngine, InMemoryStorageAdapter } = window.BirdNETPlayerModule;

      // Headless-Modus: kein echtes WaveSurfer nötig
      // const engine = new MockAudioEngine();

      // Normaler Modus mit echtem Audio:
      const player = new BirdNETPlayer(
        document.getElementById('player-root'),
        { showFileOpen: false, viewMode: 'spectrogram' }
      );

      // Warte auf Initialisierung
      player.ready.then(() => {
        // Audiodaten von Python-Server laden
        player.loadUrl('/audio/recording.wav');
      });
    </script>
    """)
```

---

## Events für Python → JavaScript

```javascript
// Alle Events die BirdNETPlayer emittiert:
player.on('annotationcreate', (e) => {
  const ann = e.detail.annotation;
  // { id, start, end, species, color, tags, ... }
  // → via postMessage, Gradio component update oder fetch() an Python-Server senden
  fetch('/api/annotation', {
    method: 'POST',
    body: JSON.stringify(ann),
    headers: { 'Content-Type': 'application/json' },
  });
});

player.on('labelsync', () => {
  // Alle Labels haben sich geändert
});

player.on('undochange', (e) => {
  // e.detail.canUndo, e.detail.canRedo
});
```

## JavaScript → Python Events

```javascript
// Annotationen aus Python-Backend laden:
const response = await fetch('/api/annotations/recording-123');
const labels = await response.json();
player.setSpectrogramLabels(labels);

// Vorberechnetes Spektrogramm injizieren (kein DSP im Browser nötig):
const spectroResponse = await fetch('/api/spectrogram/recording-123');
const spectroData = await spectroResponse.arrayBuffer();
await player.setSpectrogramData(
  new Float32Array(spectroData),
  nFrames,
  nMels,
  { mode: 'mel', sampleRate: 32000 }
);
```

---

## Headless-Modus (kein Audio, nur UI)

Für Fälle wo Python die DSP-Verarbeitung übernimmt und nur das UI-Overlay benötigt wird:

```javascript
import { MockAudioEngine, InMemoryStorageAdapter } from './dist/birdnet-player.esm.js';

const engine  = new MockAudioEngine();
const storage = new InMemoryStorageAdapter({ 'aw-favourite-preset': 'perch' });

const player = new BirdNETPlayer(container, {
  engine,   // kein WaveSurfer, kein AudioContext
  storage,  // kein localStorage
});

await player.ready;

// Fake-Audio laden (kein echter ArrayBuffer nötig für UI-Tests)
await engine.loadFromUrl('placeholder://');

// Spektrogramm direkt injizieren (von Python berechnet)
await player.setSpectrogramData(floatArray, 6000, 160, { mode: 'mel' });
```

---

## Wichtige Public-API-Methoden

| Methode | Beschreibung |
|---|---|
| `loadUrl(url)` | Audio-URL laden (http, blob:, data:) |
| `setSpectrogramData(data, nFrames, nMels, opts)` | Float32Array-Spektrogramm injizieren |
| `setSpectrogramImage(image, opts)` | Fertig gerendertes Bild injizieren |
| `setAnnotations(annotations)` | Waveform-Annotationen setzen |
| `setSpectrogramLabels(labels)` | Spektrogramm-Labels setzen |
| `setLabelTaxonomy(taxonomy)` | Label-Kategorien definieren |
| `setLabelSuggestionProvider(fn)` | Suggestion-Callback registrieren |
| `setSpeciesBar(name, opts)` | Artenleiste setzen |
| `setBackgroundSpecies(species)` | Hintergrundarten für Suche |
| `player.on(event, callback)` | Event-Listener registrieren |
| `player.undo() / player.redo()` | Undo/Redo |
| `destroy()` | Player aufräumen |

---

## Bekannte Einschränkungen

- **Bandpass-Segment-Playback** erfordert `AudioContext` — nicht im Headless-Modus verfügbar.
- **WaveSurfer** kann via `options.WaveSurfer` injiziert oder über CDN geladen werden.
- **CORS**: Audio-URLs müssen CORS-Header senden oder über einen Proxy geladen werden.
