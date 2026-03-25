
# audio-workbench (Python wrapper)

<p align="center">
    <a href="https://pypi.org/project/audio-workbench/">
        <img src="https://img.shields.io/pypi/v/audio-workbench.svg" alt="PyPI">
    </a>
    <a href="https://github.com/LimitlessGreen/Audio-Workbench">
        <img src="https://img.shields.io/github/stars/LimitlessGreen/Audio-Workbench?style=social" alt="GitHub stars">
    </a>
</p>

Python package to embed the Audio Workbench DAW player in Streamlit, Jupyter, Gradio, and any HTML-capable UI. Supports waveform & spectrogram visualization, annotation, and custom player layouts.

**Live demo:** https://limitlessgreen.github.io/Audio-Workbench/

---

## Installation

```bash
pip install audio-workbench
```

Optional for demos:

```bash
pip install "audio-workbench[streamlit]"
pip install "audio-workbench[gradio]"
```

---

## Quickstart

Embed a DAW player for your own audio in Streamlit, Jupyter, or any HTML UI:

```python
from audio_workbench import render_daw_player
html = render_daw_player(
        audio_bytes,  # bytes (WAV/MP3)
        viewMode="spectrogram",   # 'both' | 'waveform' | 'spectrogram'
        transportStyle="hero",    # 'default' | 'hero'
        showOverview=False,        # Hide overview navigator
        showFileOpen=False,        # Hide file open button
        showStatusbar=False,       # Hide status bar
        labelTaxonomy=[{"name": "Species", "color": "#0ea5e9"}],
        # ...any other BirdNETPlayer option
)
```

**Display in Streamlit:**

```python
import streamlit.components.v1 as components
components.html(html, height=620, scrolling=False)
```

**Display in Jupyter:**

```python
from IPython.display import HTML
HTML(html)
```

---

## Player Options

| Option | Example | Description |
|---|---|---|
| `viewMode` | `'spectrogram'` | Show only the spectrogram |
| `transportStyle` | `'hero'` | Large centered play button |
| `showOverview` | `False` | Hide overview navigator |
| `showFileOpen` | `False` | Hide file open button |
| `showStatusbar` | `False` | Hide status bar |
| `labelTaxonomy` | `[{'name': 'Species', 'color': '#0ea5e9'}]` | Custom label presets |
| `iframe_height` | `320` | Set iframe height (default: 620) |

For all options, see the [Web API docs](https://github.com/LimitlessGreen/Audio-Workbench#player-options).

---

## Presets & Layouts

The package includes several ready-to-use presets (see `demo_streamlit.py`):

- **Full DAW**: All controls, waveform & spectrogram, annotation
- **Compact**: Minimal controls, no overview/statusbar
- **Preview Waveform Hero**: Large play button, waveform only
- **Preview Spectrogram Hero**: Large play button, spectrogram only
- **Ultra Compact Hero**: Smallest possible embed

You can combine or override any option for your use case.

---

## Advanced: Custom Spectrograms

You can inject your own pre-computed spectrogram data or images:

- `spectrogram_data`: 2D numpy array (nFrames × nMels, float32)
- `spectrogram_image`: PNG/JPEG bytes, data-URL, matplotlib Figure, PIL Image, or numpy uint8 array

See the [Web API](https://github.com/LimitlessGreen/Audio-Workbench#external-spectrogram-injection) for details.

---

## Demos

**Streamlit:**

```bash
streamlit run demo_streamlit.py
```

**Gradio:**

```bash
pip install gradio
python demo_gradio.py
```

---

## License

GNU AGPL-3.0
