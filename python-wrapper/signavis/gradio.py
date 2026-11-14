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
``select``       ``{start, end, play, id?}`` — plays the span, or without ``play``
                 selects the detection ``id`` and scrolls it into view;
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

__all__ = ["SignaVisPlayer", "player_value", "file_url", "ASSETS_DIR", "VIEWER_TOOLBAR", "DETECTION_COLUMNS"]

ASSETS_DIR = str(files("signavis.assets"))

_select_counter = itertools.count(1)

DEFAULT_OPTIONS: dict = {
    "viewMode": "spectrogram",
    "showFileOpen": False,
}

#: Toolbar of a player that shows detections: listen and navigate, nothing else.
VIEWER_TOOLBAR = ["play", "time", "volume", "zoom"]

#: Table columns for detector output: what was found, when, how sure.
DETECTION_COLUMNS = ["species", "start", "end", "conf"]


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
    select_id: Optional[str] = None,
) -> dict:
    """Build a value for :class:`SignaVisPlayer`.

    ``select`` is ``(start_s, end_s)``; with ``play`` the span is played,
    otherwise the detection ``select_id`` is selected and scrolled into view.
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
        if select_id is not None:
            value["select"]["id"] = str(select_id)
    return value


_JS_ON_LOAD = r"""
const host = element.querySelector('.signavis-host');

// Menus and popovers the player appends to <body> take the embed styles via this class.
if (!window.__signavisPortals) {
  window.__signavisPortals = true;
  const mark = (n) => {
    if (n.nodeType === 1 && !/^(GRADIO-APP|SCRIPT|STYLE|LINK)$/.test(n.tagName)) n.classList.add('signavis-portal');
  };
  for (const n of document.body.children) mark(n);
  new MutationObserver((records) => {
    for (const r of records) for (const n of r.addedNodes) mark(n);
  }).observe(document.body, { childList: true });
}
// Gradio marks its dark theme with a "dark" class; the player reads html[data-theme].
if (!window.__signavisTheme) {
  window.__signavisTheme = true;
  const apply = () => {
    const dark = document.body.classList.contains('dark') || document.documentElement.classList.contains('dark');
    document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  };
  apply();
  const observer = new MutationObserver(apply);
  observer.observe(document.body, { attributes: true, attributeFilter: ['class'] });
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
}
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
    else if (sel.id != null) player.selectLabel(sel.id);
  }
}

const schedule = () => { state.chain = state.chain.then(sync).catch((e) => console.error('SignaVis:', e)); };
watch('value', schedule);
schedule();
"""

_CSS = """
.signavis-root {
  position: relative; width: 100%; overflow: hidden;
  border-radius: var(--block-radius, 0);
}
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
    toolbar
        Toolbar controls to keep (see the player's ``toolbar`` option);
        ``None`` keeps all of them. Defaults to :data:`VIEWER_TOOLBAR`.
    label_table
        Show the detections in a sortable table below the player.
    label_table_columns
        Columns the table starts with; the user can change them in its column
        menu. Defaults to :data:`DETECTION_COLUMNS`.
    label_display
        ``'focus'`` draws only the hovered or selected detection on the
        spectrogram (the label tracks show all of them); ``'boxes'`` draws all.
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
        toolbar: Optional[Iterable[str]] = tuple(VIEWER_TOOLBAR),
        label_table: bool = True,
        label_table_columns: Optional[Iterable[str]] = tuple(DETECTION_COLUMNS),
        label_display: str = "focus",
        options: Optional[Mapping[str, Any]] = None,
        **kwargs,
    ):
        player_options = {
            **DEFAULT_OPTIONS,
            "spectrogramHeight": int(spectrogram_height),
            "readOnly": bool(read_only),
            "labelTable": bool(label_table),
            **(
                {"labelTableColumns": list(label_table_columns)}
                if label_table_columns is not None
                else {}
            ),
            "labelDisplay": label_display,
            **({"toolbar": list(toolbar)} if toolbar is not None else {}),
            **(options or {}),
        }
        gr.set_static_paths([ASSETS_DIR])
        assets = file_url(ASSETS_DIR).rstrip("/")
        head = (
            f'<link rel="stylesheet" href="{assets}/birdnet-player.embed.css">'
            f'<script src="{assets}/wavesurfer.min.js"></script>'
            f'<script src="{assets}/birdnet-player.iife.js"></script>'
            # Gradio pads the container of a gr.HTML; the player spans the full width
            # like the other components.
            "<style>.html-container:has(.signavis-root) { padding: 0; }</style>"
        )
        super().__init__(
            value=value,
            html_template=(
                '<div class="signavis-root signavis-embed">'
                '<div class="signavis-host"></div></div>'
            ),
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

