import json
from pathlib import Path

import gradio as gr

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


def _read_file_bytes(file_obj):
    if file_obj is None:
        return None
    path = getattr(file_obj, "name", None) or str(file_obj)
    if not path:
        return None
    return Path(path).read_bytes()


def _build_options(
    preset,
    apply_advanced_overrides,
    view_mode,
    transport_style,
    transport_overlay,
    show_waveform_timeline,
    show_file_open,
    show_time,
    show_volume,
    show_view_toggles,
    show_zoom,
    show_fft_controls,
    show_display_gain,
    show_statusbar,
    show_overview,
):
    options = dict(PRESETS.get(preset, {}))
    if apply_advanced_overrides:
        options.update(
            {
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
        )
    if "Hero" in preset and "height" not in options:
        options["height"] = 240
    return options


def render_from_upload(
    file_obj,
    preset,
    iframe_height,
    apply_advanced_overrides,
    view_mode,
    transport_style,
    transport_overlay,
    show_waveform_timeline,
    show_file_open,
    show_time,
    show_volume,
    show_view_toggles,
    show_zoom,
    show_fft_controls,
    show_display_gain,
    show_statusbar,
    show_overview,
):
    audio_bytes = _read_file_bytes(file_obj)
    if audio_bytes is None:
        return "<p>Bitte eine Audiodatei hochladen.</p>", "{}"

    options = _build_options(
        preset,
        apply_advanced_overrides,
        view_mode,
        transport_style,
        transport_overlay,
        show_waveform_timeline,
        show_file_open,
        show_time,
        show_volume,
        show_view_toggles,
        show_zoom,
        show_fft_controls,
        show_display_gain,
        show_statusbar,
        show_overview,
    )
    html = render_daw_player(audio_bytes, iframe_height=int(iframe_height), **options)
    return html, json.dumps(options, indent=2)


with gr.Blocks(title="SignaVis Player (Gradio Demo)") as demo:
    gr.Markdown("# SignaVis Player (Gradio Demo)")
    gr.Markdown("Preset wählen, Optionen setzen und den Embed direkt testen.")

    with gr.Row():
        upload = gr.File(
            label="Audio-Datei wählen",
            file_count="single",
            file_types=["audio"],
        )
        preset = gr.Dropdown(label="Preset", choices=list(PRESETS.keys()), value="Full DAW")
        iframe_height = gr.Slider(label="Iframe Height", minimum=180, maximum=900, value=620, step=10)

    with gr.Accordion("Advanced Player Options", open=False):
        apply_advanced_overrides = gr.Checkbox(label="Advanced Overrides aktivieren", value=False)
        with gr.Row():
            view_mode = gr.Dropdown(label="viewMode", choices=["both", "waveform", "spectrogram"], value="both")
            transport_style = gr.Dropdown(label="transportStyle", choices=["default", "hero"], value="default")
            transport_overlay = gr.Checkbox(label="transportOverlay", value=False)
            show_waveform_timeline = gr.Checkbox(label="showWaveformTimeline", value=True)
        with gr.Row():
            show_file_open = gr.Checkbox(label="showFileOpen", value=False)
            show_time = gr.Checkbox(label="showTime", value=True)
            show_volume = gr.Checkbox(label="showVolume", value=True)
            show_view_toggles = gr.Checkbox(label="showViewToggles", value=True)
            show_zoom = gr.Checkbox(label="showZoom", value=True)
        with gr.Row():
            show_fft_controls = gr.Checkbox(label="showFFTControls", value=True)
            show_display_gain = gr.Checkbox(label="showDisplayGain", value=True)
            show_statusbar = gr.Checkbox(label="showStatusbar", value=True)
            show_overview = gr.Checkbox(label="showOverview", value=True)

    out = gr.HTML(label="Player")
    options_json = gr.Code(label="Aktive Optionen", language="json", value="{}")

    inputs = [
        upload,
        preset,
        iframe_height,
        apply_advanced_overrides,
        view_mode,
        transport_style,
        transport_overlay,
        show_waveform_timeline,
        show_file_open,
        show_time,
        show_volume,
        show_view_toggles,
        show_zoom,
        show_fft_controls,
        show_display_gain,
        show_statusbar,
        show_overview,
    ]
    outputs = [out, options_json]

    for component in inputs:
        component.change(fn=render_from_upload, inputs=inputs, outputs=outputs)


if __name__ == "__main__":
    demo.launch()
