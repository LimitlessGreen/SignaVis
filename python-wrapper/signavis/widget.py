"""anywidget-based SignaVis player with bidirectional communication.

Provides ``AudioWorkbenchWidget`` — a Jupyter widget that renders the
BirdNET DAW player and synchronizes annotations, labels, playback state,
and current time back to Python in real-time.
"""

from __future__ import annotations

import base64
import json
import pathlib
from typing import Any, Callable, Optional

import anywidget
import traitlets

from .renderer import (
    _PLAYER_CSS,
    _PLAYER_JS,
    _coerce_image_to_png_bytes,
    _encode_spectrogram_data,
)

_WIDGET_JS = (
    pathlib.Path(__file__).parent / "assets" / "widget.js"
).read_text(encoding="utf-8")

# Compose ESM: IIFE bundle (creates module-scoped BirdNETPlayerModule) +
# widget logic.  No eval() or script injection — works under strict CSP.
_WIDGET_ESM = _PLAYER_JS + "\n\n" + _WIDGET_JS


class AudioWorkbenchWidget(anywidget.AnyWidget):
    """Interactive SignaVis player widget for Jupyter notebooks.

    Provides bidirectional communication between Python and the JS player:

    * **Python → JS**: Call player methods via :meth:`call`, push annotations
      via :meth:`set_annotations`, push spectrogram labels via
      :meth:`set_spectrogram_labels`.
    * **JS → Python**: Read synced traits ``annotations``,
      ``spectrogram_labels``, ``current_time``, ``duration``, ``playing``.
      Register callbacks via :meth:`on_event`.

    Parameters
    ----------
    audio : bytes, str, or pathlib.Path
        Raw audio file content (WAV, MP3, OGG, etc.) or path to a file.
    spectrogram_data : numpy.ndarray, optional
        2D float32 array (nFrames × nMels) — player applies colorization.
    spectrogram_image : various, optional
        Pre-rendered image (bytes, str URL, PIL, matplotlib, numpy).
    spectrogram_mode : str
        ``'perch'`` or ``'classic'``. Default: ``'perch'``.
    sample_rate : int, optional
        Override sample rate for frequency axis.
    **options
        Forwarded to the ``BirdNETPlayer`` JS constructor (e.g.
        ``viewMode='spectrogram'``, ``showFileOpen=False``).

    Examples
    --------
    >>> from signavis import AudioWorkbenchWidget
    >>> w = AudioWorkbenchWidget(audio_bytes, viewMode="both")
    >>> w  # display in notebook cell
    >>> # After user draws annotations:
    >>> w.annotations
    [{'id': '...', 'start': 1.2, 'end': 2.5, 'species': 'Bird Call', ...}]
    >>> w.spectrogram_labels
    [{'id': '...', 'start': 1.0, 'end': 3.0, 'freqMin': 2000, ...}]
    """

    # ── Internal traits (not meant for direct user access) ──
    _esm = traitlets.Unicode().tag(sync=True)
    _css = traitlets.Unicode("").tag(sync=True)

    _player_js = traitlets.Unicode("").tag(sync=True)
    _player_css = traitlets.Unicode("").tag(sync=True)
    _player_options = traitlets.Unicode("{}").tag(sync=True)
    _audio_b64 = traitlets.Unicode("").tag(sync=True)
    _spectrogram_b64 = traitlets.Unicode("").tag(sync=True)
    _spectrogram_meta = traitlets.Unicode("").tag(sync=True)

    # Python → JS push traits
    _annotations_in = traitlets.List(traitlets.Dict(), default_value=[]).tag(
        sync=True
    )
    _spectrogram_labels_in = traitlets.List(
        traitlets.Dict(), default_value=[]
    ).tag(sync=True)

    # ── JS → Python synced traits (read from Python) ──
    annotations = traitlets.List(traitlets.Dict(), default_value=[]).tag(
        sync=True
    )
    spectrogram_labels = traitlets.List(
        traitlets.Dict(), default_value=[]
    ).tag(sync=True)
    current_time = traitlets.Float(0.0).tag(sync=True)
    duration = traitlets.Float(0.0).tag(sync=True)
    playing = traitlets.Bool(False).tag(sync=True)

    def __init__(
        self,
        audio,
        *,
        spectrogram_data=None,
        spectrogram_image=None,
        spectrogram_mode: str = "perch",
        sample_rate: Optional[int] = None,
        **options,
    ):
        if spectrogram_data is not None and spectrogram_image is not None:
            raise ValueError(
                "Provide spectrogram_data OR spectrogram_image, not both."
            )

        # Accept file paths
        if isinstance(audio, (str, pathlib.Path)):
            audio = pathlib.Path(audio).read_bytes()

        # Encode audio
        audio_b64 = base64.b64encode(audio).decode("ascii")

        # Encode spectrogram
        spect_b64 = ""
        spect_meta = ""
        if spectrogram_data is not None:
            b64_data, n_frames, n_mels = _encode_spectrogram_data(
                spectrogram_data
            )
            spect_b64 = b64_data
            spect_meta = json.dumps(
                {
                    "type": "data",
                    "n_frames": n_frames,
                    "n_mels": n_mels,
                    "mode": spectrogram_mode,
                    "sample_rate": sample_rate or 16000,
                }
            )
        elif spectrogram_image is not None:
            if isinstance(spectrogram_image, str):
                spect_b64 = spectrogram_image
                spect_meta = json.dumps(
                    {
                        "type": "image",
                        "is_url": True,
                        "sample_rate": sample_rate,
                    }
                )
            else:
                png_bytes = _coerce_image_to_png_bytes(spectrogram_image)
                spect_b64 = base64.b64encode(png_bytes).decode("ascii")
                spect_meta = json.dumps(
                    {
                        "type": "image",
                        "is_url": False,
                        "sample_rate": sample_rate,
                    }
                )

        super().__init__(
            _esm=_WIDGET_ESM,
            _player_css=_PLAYER_CSS,
            _player_options=json.dumps(options or {}),
            _audio_b64=audio_b64,
            _spectrogram_b64=spect_b64,
            _spectrogram_meta=spect_meta,
        )

        self._event_callbacks: dict[str, list[Callable]] = {}
        self.on_msg(self._handle_custom_msg)

    # ── Python → JS methods ──

    def call(self, method: str, *args: Any) -> None:
        """Call a method on the JS BirdNETPlayer instance.

        Parameters
        ----------
        method : str
            Name of the player method (e.g. ``'play'``, ``'pause'``,
            ``'stop'``, ``'addAnnotation'``, ``'clearAnnotations'``).
        *args
            Arguments forwarded to the JS method.

        Examples
        --------
        >>> w.call('play')
        >>> w.call('pause')
        >>> w.call('addAnnotation', {'start': 1.0, 'end': 2.0, 'species': 'Bird'})
        """
        self.send({"type": "call", "method": method, "args": list(args)})

    def play(self) -> None:
        """Start playback."""
        self.call("play")

    def pause(self) -> None:
        """Pause playback."""
        self.call("pause")

    def stop(self) -> None:
        """Stop playback."""
        self.call("stop")

    def set_annotations(self, annotations: list[dict]) -> None:
        """Replace all waveform annotations from Python.

        Parameters
        ----------
        annotations : list of dict
            Each dict should have ``start``, ``end``, and optionally
            ``species``, ``color``, ``confidence``.
        """
        self._annotations_in = list(annotations)

    def set_spectrogram_labels(self, labels: list[dict]) -> None:
        """Replace all spectrogram labels from Python.

        Parameters
        ----------
        labels : list of dict
            Each dict should have ``start``, ``end``, ``freqMin``, ``freqMax``,
            and optionally ``label``, ``color``.
        """
        self._spectrogram_labels_in = list(labels)

    def export_annotations_raven(self) -> None:
        """Trigger Raven-format annotation export on the JS side."""
        self.call("exportAnnotationsRaven")

    def sync(self) -> None:
        """Request a full state sync from JS → Python."""
        self.send({"type": "sync"})

    # ── Event system ──

    def on_event(self, event: str, callback: Callable) -> None:
        """Register a callback for a JS player event.

        Parameters
        ----------
        event : str
            Event name (e.g. ``'annotationcreate'``,
            ``'spectrogramlabelupdate'``, ``'transportstatechange'``).
        callback : callable
            Called with ``(event_name: str, detail: dict)`` when fired.

        Examples
        --------
        >>> def on_annotation(event, detail):
        ...     print(f"New annotation: {detail}")
        >>> w.on_event('annotationcreate', on_annotation)
        """
        self._event_callbacks.setdefault(event, []).append(callback)

    def _handle_custom_msg(self, msg, buffers):
        """Dispatch incoming custom messages from JS."""
        if not isinstance(msg, dict):
            return
        if msg.get("type") == "event":
            event = msg.get("event", "")
            detail = msg.get("detail", {})
            for cb in self._event_callbacks.get(event, []):
                cb(event, detail)
