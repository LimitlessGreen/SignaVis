# Python integration (Jupyter, Streamlit, Gradio, Widgets)

This page documents the Python integration provided by the `audio-workbench` package: how to embed the BirdNET DAW player in Jupyter/Colab, Streamlit, Gradio and how to use the interactive widget API.

## Installation

Install the package from PyPI:

```bash
pip install audio-workbench
```

Optional extras:

```bash
pip install "audio-workbench[streamlit]"
pip install "audio-workbench[gradio]"
```

For widget support (Jupyter interactive widget) install `anywidget` and its backends:

```bash
pip install anywidget ipywidgets
```

## Quickstart — embeddable iframe (Jupyter / Streamlit / Gradio)

The primary convenience function is `render_daw_player(audio_bytes, **options)`. It returns an embeddable HTML `iframe` string.

Jupyter example:

```python
from audio_workbench import render_daw_player
from IPython.display import HTML

with open('myfile.wav', 'rb') as f:
    audio = f.read()

HTML(render_daw_player(audio, viewMode='spectrogram'))
```

Streamlit example (use `components.html`):

```python
import streamlit as st
import streamlit.components.v1 as components
from audio_workbench import render_daw_player

uploaded = st.file_uploader('Audio', type=['wav','mp3'])
if uploaded:
    html = render_daw_player(uploaded.read(), iframe_height=620, viewMode='both')
    components.html(html, height=640, scrolling=False)
```

## Convenience helpers

- `Player(audio, **options)` — simple notebook-friendly wrapper that displays automatically when returned from a cell.
- `show(audio, **options)` — convenience wrapper that calls IPython display for you.
- `generate_spectrogram_image(audio_bytes, **kwargs)` — convenience helper using `librosa` + `matplotlib` to produce a PNG spectrogram ready to pass as `spectrogram_image`.

## Spectrogram injection: `spectrogram_data` vs `spectrogram_image`

- `spectrogram_data`: pass a 2D NumPy float32 array (nFrames × nMels). The wrapper encodes it in a compact base64 float32 payload and the JS player will apply colorization.
- `spectrogram_image`: pass a pre-rendered image (PNG bytes, data-URL, matplotlib Figure, PIL Image, or numpy uint8 array). When using an image you must also provide `sample_rate`, `freq_range` and optionally `freq_scale` so the player can map pixels → Hz correctly.

Use `generate_spectrogram_image()` to create a PNG and meta dict from audio bytes:

```python
from audio_workbench import generate_spectrogram_image, render_daw_player

img_bytes, meta = generate_spectrogram_image(audio_bytes, sr=32000, n_mels=128)
html = render_daw_player(audio_bytes, spectrogram_image=img_bytes, sample_rate=meta['sample_rate'], freq_range=meta['freq_range'], freq_scale=meta['freq_scale'])
```

## Interactive widget (Jupyter) — `AudioWorkbenchWidget`

If `anywidget` is installed you can use `AudioWorkbenchWidget` for a full-featured bidirectional integration.

Basic usage:

```python
from audio_workbench import AudioWorkbenchWidget

w = AudioWorkbenchWidget(audio_bytes, viewMode='both')
w  # display in notebook cell
```

Key Python → JS methods:

- `w.call(method, *args)` — call an arbitrary player method (e.g. `'play'`, `'pause'`).
- `w.play()`, `w.pause()`, `w.stop()` — convenience controls.
- `w.set_annotations(list_of_dicts)` — replace waveform annotations from Python.
- `w.set_spectrogram_labels(list_of_dicts)` — replace spectrogram labels.
- `w.export_annotations_raven()` — trigger Raven-format export client-side.
- `w.sync()` — request a full sync from JS to Python.

JS → Python synced traits (read from Python):

- `w.annotations` — list of annotation dicts synced from the player.
- `w.spectrogram_labels` — list of spectrogram label dicts.
- `w.current_time`, `w.duration`, `w.playing` — playback state.

Event handling:

```python
def on_ann(event, detail):
    print('Event', event, 'detail', detail)

w.on_event('annotationcreate', on_ann)
```

`on_event(event, callback)` registers callbacks that receive `(event_name, detail)` when the JS player emits events.

## Export / Upload integration

The demo includes helpers to build Xeno‑canto payloads and export annotation sets. See the XC panel code at [demo/lib/xc-panel.js](demo/lib/xc-panel.js) for the exact payload builder used by the UI. The Python wrapper is orthogonal — use the widget or iframe to edit labels and export via the client UI, or serialize and post the app-generated payload from Python if needed.

## Demos and examples

- `python-wrapper/demo_streamlit.py` — Streamlit demo embedding the player and exposing option presets.
- `python-wrapper/demo_gradio.py` — Gradio demo.
- `python-wrapper/demo_colab.ipynb` — Colab notebook example.

## Optional dependencies & troubleshooting

- `numpy` — required for `spectrogram_data` support.
- `librosa` + `matplotlib` — required by `generate_spectrogram_image()`.
- `Pillow` — required to convert numpy image arrays to PNG.
- `anywidget` + `ipywidgets` — required for `AudioWorkbenchWidget`.

If you see ImportError messages, install the missing extras, for example:

```bash
pip install numpy librosa matplotlib Pillow anywidget ipywidgets
```

## Code references

- Python wrapper root & README: [python-wrapper/README.md](python-wrapper/README.md)
- Renderer implementations: [python-wrapper/audio_workbench/renderer.py](python-wrapper/audio_workbench/renderer.py)
- Interactive widget: [python-wrapper/audio_workbench/widget.py](python-wrapper/audio_workbench/widget.py)
- Streamlit demo: [python-wrapper/demo_streamlit.py](python-wrapper/demo_streamlit.py)

---

If you want, I can also:

- add a small runnable example notebook under `docs/` linking to this page, or
- include a downloadable sample `demo/data/` JSON for the widget → JS sync examples.
