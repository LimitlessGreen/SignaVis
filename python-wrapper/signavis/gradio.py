"""Gradio integration: the SignaVis player as a native ``gr.HTML`` component.

Unlike :func:`signavis.render_daw_player`, nothing is inlined: the player
bundle, its stylesheet and WaveSurfer are served from this package, and the
audio is streamed from its path on disk. That keeps the page small for long
recordings and works offline (e.g. in a pywebview desktop app).

>>> import gradio as gr
>>> from signavis.gradio import SignaVisPlayer, player_value
>>> with gr.Blocks() as demo:
...     player = SignaVisPlayer()
...     btn = gr.Button("Load")
...     btn.click(lambda: player_value("bird.wav", detections=[
...         {"start": 3.0, "end": 6.0, "label": "Turdus merula", "confidence": 0.91},
...     ]), outputs=player)

The component's value is a plain dict (see :func:`player_value`):

``src``          path or URL of the audio file
``detections``   list of ``{start, end, label, confidence?, freqMin?, freqMax?,
                 scientificName?, commonName?, color?, id?}``
``select``       ``{start, end, play}`` — scrolls to and optionally plays a span;
                 a new dict each time re-triggers it
"""

from __future__ import annotations

import itertools
import json
import os
from importlib.resources import files
from typing import Any, Iterable, Mapping, Optional
from urllib.parse import quote

import gradio as gr

__all__ = ["SignaVisPlayer", "player_value", "file_url", "ASSETS_DIR"]

ASSETS_DIR = str(files("signavis.assets"))

_select_counter = itertools.count(1)

DEFAULT_OPTIONS: dict = {
    "viewMode": "spectrogram",
    "showFileOpen": False,
    "compactToolbar": True,
}


def file_url(path: str) -> str:
    """URL under which Gradio serves ``path``; registers it as a static path."""
    if path.startswith(("http://", "https://", "data:", "blob:", "/gradio_api/")):
        return path
    path = os.path.abspath(path)
    gr.set_static_paths([path])
    return "/gradio_api/file=" + quote(path.replace("\\", "/"), safe="/:")


def player_value(
    src: Optional[str],
    *,
    detections: Optional[Iterable[Mapping[str, Any]]] = None,
    select: Optional[tuple] = None,
    play: bool = True,
) -> dict:
    """Build a value for :class:`SignaVisPlayer`.

    ``select`` is ``(start_s, end_s)``; with ``play`` the span is played.
    """
    value: dict = {"src": src}
    if detections is not None:
        value["detections"] = [dict(d) for d in detections]
    if select is not None:
        value["select"] = {
            "start": float(select[0]),
            "end": float(select[1]),
            "play": bool(play),
            "n": next(_select_counter),
        }
    return value


_JS_ON_LOAD = r"""
const host = element.querySelector('.signavis-host');
const state = { player: null, src: null, labels: null, select: null, chain: Promise.resolve() };

async function ensurePlayer() {
  if (state.player) return state.player;
  const mod = window.BirdNETPlayerModule;
  if (!mod?.BirdNETPlayer) {
    host.textContent = 'SignaVis failed to load';
    throw new Error('BirdNETPlayerModule missing');
  }
  const opts = Object.assign({ WaveSurfer: window.WaveSurfer }, __OPTIONS__);
  state.player = new mod.BirdNETPlayer(host, opts);
  await state.player.ready;
  state.player.on('ready', () => trigger('load'));
  return state.player;
}

function toLabels(detections) {
  return (detections || []).map((d, i) => ({
    id: d.id ?? `det-${i}`,
    start: +d.start,
    end: +d.end,
    label: d.label ?? d.commonName ?? d.scientificName ?? '',
    species: d.label ?? d.scientificName,
    scientificName: d.scientificName,
    commonName: d.commonName,
    confidence: d.confidence,
    freqMin: d.freqMin,
    freqMax: d.freqMax,
    color: d.color,
    origin: d.origin ?? 'detector',
    readonly: true,
  }));
}

async function sync() {
  const v = props.value || {};
  element.querySelector('.signavis-root').style.display = v.src ? '' : 'none';
  if (!v.src) return;
  const player = await ensurePlayer();
  if (v.src !== state.src) {
    state.src = v.src;
    state.labels = null;
    state.select = null;
    await player.loadUrl(v.src);
  }
  const labelsKey = JSON.stringify(v.detections || []);
  if (labelsKey !== state.labels) {
    state.labels = labelsKey;
    player.setSpectrogramLabels(toLabels(v.detections));
  }
  const sel = v.select;
  if (sel && sel.n !== state.select) {
    state.select = sel.n;
    if (sel.play) player.playSegment(sel.start, sel.end);
  }
}

const schedule = () => { state.chain = state.chain.then(sync).catch((e) => console.error('SignaVis:', e)); };
watch('value', schedule);
schedule();
"""

_CSS = """
.signavis-root { position: relative; width: 100%; overflow: hidden; }
.signavis-host { width: 100%; }
"""


class SignaVisPlayer(gr.HTML):
    """SignaVis spectrogram player for Gradio Blocks.

    Parameters
    ----------
    value
        Initial value, usually built with :func:`player_value`.
    spectrogram_height
        Initial height of the spectrogram in pixels.
    read_only
        View and listen only: no drawing or editing of labels.
    options
        Player constructor options (``viewMode``, ``showOverview``, …), merged
        over :data:`DEFAULT_OPTIONS`.
    """

    EVENTS = ["load"]

    def __init__(
        self,
        value: Optional[dict] = None,
        *,
        spectrogram_height: int = 260,
        read_only: bool = True,
        options: Optional[Mapping[str, Any]] = None,
        **kwargs,
    ):
        player_options = {
            **DEFAULT_OPTIONS,
            "spectrogramHeight": int(spectrogram_height),
            "readOnly": bool(read_only),
            **(options or {}),
        }
        gr.set_static_paths([ASSETS_DIR])
        assets = file_url(ASSETS_DIR).rstrip("/")
        head = (
            f'<link rel="stylesheet" href="{assets}/birdnet-player.css">'
            f'<script src="{assets}/wavesurfer.min.js"></script>'
            f'<script src="{assets}/birdnet-player.iife.js"></script>'
        )
        super().__init__(
            value=value,
            html_template='<div class="signavis-root"><div class="signavis-host"></div></div>',
            css_template=_CSS,
            # Baked into the script: a gr.update() of the component replaces its
            # custom props, so options passed as a prop would not survive one.
            js_on_load=_JS_ON_LOAD.replace("__OPTIONS__", json.dumps(player_options)),
            head=head,
            apply_default_css=False,
            **kwargs,
        )

    def postprocess(self, value):
        if isinstance(value, dict) and value.get("src"):
            value = {**value, "src": file_url(str(value["src"]))}
        return super().postprocess(value)

    def api_info(self) -> dict:
        return {"type": "object"}

