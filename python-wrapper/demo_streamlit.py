import json

import streamlit as st
import streamlit.components.v1 as components

from signavis import render_daw_player


PRESETS = {
    "Full DAW": {},
    "Compact": {
        "showStatusbar": False,
        "showOverview": False,
        "showDisplayGain": False,
        "height": 320,
    },
    "Preview Waveform Hero": {
        "viewMode": "waveform",
        "transportStyle": "hero",
        "transportOverlay": True,
        "showWaveformTimeline": False,
        "showOverview": False,
        "showFileOpen": False,
        "showTime": False,
        "showVolume": False,
        "showViewToggles": False,
        "showZoom": False,
        "showFFTControls": False,
        "showDisplayGain": False,
        "showStatusbar": False,
    },
    "Preview Spectrogram Hero": {
        "viewMode": "spectrogram",
        "transportStyle": "hero",
        "transportOverlay": True,
        "showOverview": False,
        "showFileOpen": False,
        "showTime": False,
        "showVolume": False,
        "showViewToggles": False,
        "showZoom": False,
        "showFFTControls": False,
        "showDisplayGain": False,
        "showStatusbar": False,
    },
    "Ultra Compact Hero": {
        "viewMode": "spectrogram",
        "transportStyle": "hero",
        "transportOverlay": True,
        "showOverview": False,
        "showFileOpen": False,
        "showTime": False,
        "showVolume": False,
        "showViewToggles": False,
        "showZoom": False,
        "showFFTControls": False,
        "showDisplayGain": False,
        "showStatusbar": False,
    },
}


def merged_options(preset_name: str, overrides: dict) -> dict:
    base = dict(PRESETS.get(preset_name, {}))
    base.update(overrides)
    return base


st.set_page_config(page_title="SignaVis Player Demo", layout="wide")
st.title("SignaVis Player (Streamlit Demo)")
st.caption("Preset wählen, Optionen live anpassen und den Embed direkt testen.")

with st.sidebar:
    st.subheader("Preset")
    preset = st.selectbox("Layout", list(PRESETS.keys()), index=0)
    iframe_height_default = 280 if "Hero" in preset else 620
    iframe_height = st.slider("Iframe Height", min_value=180, max_value=900, value=iframe_height_default, step=10)
    apply_advanced_overrides = st.checkbox("Advanced Overrides aktivieren", value=False)

    with st.expander("Advanced Player Options", expanded=False):
        view_mode = st.selectbox("viewMode", ["both", "waveform", "spectrogram"], index=0)
        transport_style = st.selectbox("transportStyle", ["default", "hero"], index=0)
        transport_overlay = st.checkbox("transportOverlay", value=False)
        show_waveform_timeline = st.checkbox("showWaveformTimeline", value=True)

        show_file_open = st.checkbox("showFileOpen", value=False)
        show_time = st.checkbox("showTime", value=True)
        show_volume = st.checkbox("showVolume", value=True)
        show_view_toggles = st.checkbox("showViewToggles", value=True)
        show_zoom = st.checkbox("showZoom", value=True)
        show_fft_controls = st.checkbox("showFFTControls", value=True)
        show_display_gain = st.checkbox("showDisplayGain", value=True)
        show_statusbar = st.checkbox("showStatusbar", value=True)
        show_overview = st.checkbox("showOverview", value=True)

uploaded = st.file_uploader("Audio-Datei wählen", type=["wav", "mp3", "ogg", "flac"])
if uploaded is None:
    st.info("Lade eine Audiodatei hoch, um den Player zu sehen.")
else:
    overrides = {}
    if apply_advanced_overrides:
        overrides = {
            "viewMode": view_mode,
            "transportStyle": transport_style,
            "transportOverlay": transport_overlay,
            "showWaveformTimeline": show_waveform_timeline,
            "showFileOpen": show_file_open,
            "showTime": show_time,
            "showVolume": show_volume,
            "showViewToggles": show_view_toggles,
            "showZoom": show_zoom,
            "showFFTControls": show_fft_controls,
            "showDisplayGain": show_display_gain,
            "showStatusbar": show_statusbar,
            "showOverview": show_overview,
        }
    options = merged_options(
        preset,
        overrides,
    )

    # For Hero presets, keep narrow visual style by default while still allowing overrides.
    if "Hero" in preset and "height" not in options:
        options["height"] = 240

    html = render_daw_player(uploaded.read(), iframe_height=iframe_height, **options)
    components.html(html, height=iframe_height + 12, scrolling=False)
    with st.expander("Aktive Optionen (JSON)", expanded=False):
        st.code(json.dumps(options, indent=2), language="json")
