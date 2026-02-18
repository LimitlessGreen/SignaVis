# audio-workbench-player (Python wrapper)

Python helper package to embed `audio-workbench-player` in Streamlit, Jupyter, and other HTML-capable UIs.

## Install (PyPI)

```bash
pip install audio-workbench-player
```

Optional demo dependencies:

```bash
pip install "audio-workbench-player[streamlit]"
pip install "audio-workbench-player[gradio]"
```

## Install (local dev)

```bash
pip install -e .
```

## Usage

```python
from audio_workbench_player import render_daw_player
html = render_daw_player(
    audio_bytes,
    iframe_height=320,
    viewMode="spectrogram",
    transportStyle="hero",
    transportOverlay=True,
    showOverview=False,
    showFileOpen=False,
    showStatusbar=False,
)
```

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
