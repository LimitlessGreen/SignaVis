# audio-workbench (Python wrapper)

Python helper package to embed `audio-workbench` in Streamlit, Jupyter, and other HTML-capable UIs.

## Install (PyPI)

```bash
pip install audio-workbench
```

PyPI: https://pypi.org/project/audio-workbench


Optional demo dependencies:

```bash
pip install "audio-workbench[streamlit]"
pip install "audio-workbench[gradio]"
```

## Install (local dev)

```bash
pip install -e .
```


## Usage

```python
from audio_workbench import render_daw_player
html = render_daw_player(
    audio_bytes,
    # --- Player options (passed to JS) ---
    viewMode="spectrogram",           # 'both' | 'waveform' | 'spectrogram'
    transportStyle="hero",            # 'default' | 'hero'
    transportOverlay=True,             # Centered play overlay
    showOverview=False,                # Hide overview navigator
    showFileOpen=False,                # Hide file open button
    showStatusbar=False,               # Hide status bar
    # ...any other BirdNETPlayer option
)
```

**Common options:**

| Option | Example | Description |
|---|---|---|
| `viewMode` | `'spectrogram'` | Show only the spectrogram |
| `transportStyle` | `'hero'` | Large centered play button |
| `showOverview` | `False` | Hide overview navigator |
| `showFileOpen` | `False` | Hide file open button |
| `showStatusbar` | `False` | Hide status bar |
| `labelTaxonomy` | `[{'name': 'Species', 'color': '#0ea5e9'}]` | Custom label presets |

For a full list of options, see the [Web API documentation](https://github.com/LimitlessGreen/Audio-Workbench#player-options).

## Demo Features

- Presets: `Full DAW`, `Compact`, `Preview Waveform Hero`, `Preview Spectrogram Hero`, `Ultra Compact Hero`
- Advanced toggles for all relevant player sections
- Live options preview as JSON

## Streamlit demo

```bash
streamlit run demo_streamlit.py
```

## Gradio demo

```bash
pip install gradio
python demo_gradio.py
```

## License

GNU AGPL-3.0
