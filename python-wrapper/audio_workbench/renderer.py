import base64
import html
import io
import json
from importlib.resources import files
from typing import Optional, Union

try:
    import numpy as np
    _HAS_NUMPY = True
except ImportError:
    _HAS_NUMPY = False


_PLAYER_JS = (
    files("audio_workbench.assets")
    .joinpath("birdnet-player.iife.js")
    .read_text(encoding="utf-8")
    .replace("</script>", "<\\/script>")
)
_PLAYER_CSS = (
    files("audio_workbench.assets")
    .joinpath("birdnet-player.css")
    .read_text(encoding="utf-8")
)


def _encode_spectrogram_data(data) -> tuple:
    """Encode a numpy array (nFrames × nMels) to base64 float32 + dimensions.

    The JS side expects row-major float32: data[frame * nMels + mel].
    Numpy arrays in (n_mels, n_frames) layout (librosa convention) are
    automatically transposed.
    """
    if not _HAS_NUMPY:
        raise ImportError(
            "numpy is required for spectrogram_data. "
            "Install with: pip install numpy"
        )
    arr = np.asarray(data, dtype=np.float32)
    if arr.ndim != 2:
        raise ValueError(f"spectrogram_data must be 2D, got {arr.ndim}D")

    # Heuristic: if shape is (n_mels, n_frames) with n_mels < n_frames,
    # transpose to (n_frames, n_mels) for JS row-major layout.
    # Users can pass (n_frames, n_mels) directly to skip this.
    n_frames, n_mels = arr.shape
    if n_frames < n_mels:
        arr = arr.T
        n_frames, n_mels = arr.shape

    # Ensure C-contiguous for correct byte order
    arr = np.ascontiguousarray(arr)
    b64 = base64.b64encode(arr.tobytes()).decode("ascii")
    return b64, n_frames, n_mels


def _coerce_image_to_png_bytes(image) -> bytes:
    """Convert various image types to raw PNG bytes.

    Accepts:
    - bytes (returned as-is, assumed PNG/JPEG)
    - str (returned as-is — URL or data-URL, handled by caller)
    - io.BytesIO / io.BufferedIOBase
    - matplotlib.figure.Figure
    - PIL.Image.Image
    - numpy.ndarray (uint8, HWC or HW)
    """
    # bytes pass-through
    if isinstance(image, bytes):
        return image

    # io.BytesIO / file-like
    if isinstance(image, (io.BytesIO, io.BufferedIOBase)):
        image.seek(0)
        return image.read()

    # matplotlib Figure
    try:
        import matplotlib.figure
        if isinstance(image, matplotlib.figure.Figure):
            buf = io.BytesIO()
            image.savefig(buf, format="png", bbox_inches="tight", pad_inches=0, dpi=150)
            buf.seek(0)
            return buf.read()
    except ImportError:
        pass

    # PIL Image
    try:
        from PIL import Image as PILImage
        if isinstance(image, PILImage.Image):
            buf = io.BytesIO()
            image.save(buf, format="PNG")
            buf.seek(0)
            return buf.read()
    except ImportError:
        pass

    # numpy uint8 array (HWC or HW grayscale)
    if _HAS_NUMPY and isinstance(image, np.ndarray):
        try:
            from PIL import Image as PILImage
            if image.ndim == 2:
                pil_img = PILImage.fromarray(image)
            elif image.ndim == 3 and image.shape[2] == 3:
                pil_img = PILImage.fromarray(image)
            elif image.ndim == 3 and image.shape[2] == 4:
                pil_img = PILImage.fromarray(image)
            else:
                raise ValueError(f"Unsupported numpy array shape for image: {image.shape}")
            buf = io.BytesIO()
            pil_img.save(buf, format="PNG")
            buf.seek(0)
            return buf.read()
        except ImportError:
            raise ImportError("Pillow is required for numpy array images: pip install Pillow")

    # Fallback: unknown type
    raise TypeError(
        f"spectrogram_image: unsupported type {type(image).__name__}. "
        "Expected bytes, str, io.BytesIO, matplotlib.figure.Figure, "
        "PIL.Image.Image, or numpy.ndarray (uint8)."
    )


def generate_spectrogram_image(
    audio_bytes: bytes,
    *,
    sr: int = 22050,
    n_fft: int = 2048,
    hop_length: int = 512,
    n_mels: int = 128,
    fmin: float = 0.0,
    fmax: Optional[float] = None,
    cmap: str = "inferno",
    power_to_db: bool = True,
    figsize: Optional[tuple] = None,
    dpi: int = 150,
) -> tuple:
    """Generate a spectrogram image from audio bytes using librosa + matplotlib.

    This is a convenience helper that produces a PNG image ready to be
    passed to ``render_daw_player(spectrogram_image=...)``.

    Parameters
    ----------
    audio_bytes : bytes
        Raw audio file bytes (WAV, MP3, FLAC, etc.).
    sr : int
        Target sample rate.  Passed to ``librosa.load()``.
    n_fft : int
        FFT window size.
    hop_length : int
        Hop length in samples.
    n_mels : int
        Number of mel bands.
    fmin : float
        Lowest frequency (Hz) of the mel filterbank.
    fmax : float or None
        Highest frequency (Hz).  ``None`` → ``sr / 2``.
    cmap : str
        Matplotlib colormap name (e.g. 'inferno', 'viridis', 'magma').
    power_to_db : bool
        Convert power spectrogram to dB scale (default ``True``).
    figsize : tuple or None
        ``(width, height)`` in inches.  ``None`` → auto-sized to data.
    dpi : int
        Image resolution.

    Returns
    -------
    image_bytes : bytes
        Raw PNG image bytes.
    meta : dict
        Metadata dict with keys:
        - ``sample_rate`` (int)
        - ``freq_range``  (tuple of float) — ``(fmin, fmax)``
        - ``freq_scale``  (str) — ``'mel'``

    Example
    -------
    >>> img, meta = generate_spectrogram_image(audio, sr=32000, n_mels=128)
    >>> html = render_daw_player(audio, spectrogram_image=img, **meta)
    """
    try:
        import librosa
    except ImportError:
        raise ImportError(
            "librosa is required for generate_spectrogram_image(). "
            "Install with: pip install librosa"
        )
    try:
        import matplotlib
        matplotlib.use("Agg")
        import matplotlib.pyplot as plt
    except ImportError:
        raise ImportError(
            "matplotlib is required for generate_spectrogram_image(). "
            "Install with: pip install matplotlib"
        )
    if not _HAS_NUMPY:
        raise ImportError("numpy is required. Install with: pip install numpy")

    import numpy as np

    y, sr_actual = librosa.load(io.BytesIO(audio_bytes), sr=sr)
    effective_fmax = fmax if fmax is not None else sr_actual / 2.0

    S = librosa.feature.melspectrogram(
        y=y, sr=sr_actual,
        n_fft=n_fft, hop_length=hop_length,
        n_mels=n_mels, fmin=fmin, fmax=effective_fmax,
    )
    if power_to_db:
        S = librosa.power_to_db(S, ref=np.max)

    if figsize is None:
        # Width proportional to duration, height proportional to mels
        w = max(4, S.shape[1] / 100)
        h = max(2, n_mels / 60)
        figsize = (w, h)

    fig, ax = plt.subplots(1, 1, figsize=figsize, dpi=dpi)
    ax.imshow(S, aspect="auto", origin="lower", cmap=cmap, interpolation="nearest")
    ax.axis("off")
    plt.subplots_adjust(left=0, right=1, top=1, bottom=0)

    buf = io.BytesIO()
    fig.savefig(buf, format="png", bbox_inches="tight", pad_inches=0, dpi=dpi)
    plt.close(fig)
    buf.seek(0)

    return buf.read(), {
        "sample_rate": sr_actual,
        "freq_range": (fmin, effective_fmax),
        "freq_scale": "mel",
    }


def render_daw_player(
    audio_bytes: bytes,
    *,
    spectrogram_data=None,
    spectrogram_image=None,
    spectrogram_mode: str = "perch",
    sample_rate: Optional[int] = None,
    freq_range: Optional[tuple] = None,
    freq_scale: Optional[str] = None,
    **options,
) -> str:
    """Return an embeddable HTML iframe string with BirdNET DAW player.

    Parameters
    ----------
    audio_bytes : bytes
        Raw audio bytes (e.g. WAV/MP3).
    spectrogram_data : numpy.ndarray, optional
        Pre-computed spectrogram as 2D float32 array (nFrames × nMels).
        The player applies its own colorization (contrast, color map).
        Librosa-style (n_mels × n_frames) arrays are auto-transposed.
    spectrogram_image : various types, optional
        Pre-rendered spectrogram image. Accepted types:
        - ``bytes`` — raw PNG/JPEG bytes
        - ``str`` — data-URL ("data:image/png;base64,...") or HTTP URL
        - ``io.BytesIO`` — in-memory buffer with PNG/JPEG
        - ``matplotlib.figure.Figure`` — rendered to PNG automatically
        - ``PIL.Image.Image`` — converted to PNG automatically
        - ``numpy.ndarray`` (uint8, HW or HWC) — converted via Pillow
        Bypasses all DSP + colorization; image is drawn as-is.
    spectrogram_mode : str
        'perch' or 'classic' — affects frequency axis labels. Default: 'perch'.
    sample_rate : int, optional
        Override sample rate for frequency axis labels.
    freq_range : tuple of (float, float), optional
        Frequency range ``(fmin_hz, fmax_hz)`` that the spectrogram image
        covers along its vertical axis. Required for correct frequency labels
        and crosshair readout when using ``spectrogram_image``.
    freq_scale : {'linear', 'mel', 'log'}, optional
        Frequency axis mapping of the spectrogram image.
        ``'linear'`` — uniform spacing from *fmin* to *fmax*.
        ``'mel'``    — mel-scale spacing.
        ``'log'``    — logarithmic spacing.
        Used together with ``freq_range`` for correct pixel↔Hz conversion.
    options : dict
        Passed to BirdNETPlayer constructor.

    Notes
    -----
    Only one of ``spectrogram_data`` or ``spectrogram_image`` may be provided.
    """
    if spectrogram_data is not None and spectrogram_image is not None:
        raise ValueError("Provide spectrogram_data OR spectrogram_image, not both.")

    iframe_height = int(options.pop("iframe_height", 620) or 620)
    iframe_height = max(180, min(1600, iframe_height))
    b64_audio = base64.b64encode(audio_bytes).decode("ascii")
    opts = json.dumps(options or {})

    # Build the spectrogram injection JS snippet
    spect_js = ""
    if spectrogram_data is not None:
        b64_data, n_frames, n_mels = _encode_spectrogram_data(spectrogram_data)
        sr_opt = f", sampleRate: {sample_rate}" if sample_rate else ""
        spect_js = f"""
      // Inject pre-computed spectrogram data
      const specBin = atob('{b64_data}');
      const specBytes = new Uint8Array(specBin.length);
      for (let i = 0; i < specBin.length; i++) specBytes[i] = specBin.charCodeAt(i);
      await player.setSpectrogramData(
        new Float32Array(specBytes.buffer),
        {n_frames}, {n_mels},
        {{ mode: '{spectrogram_mode}'{sr_opt} }}
      );
"""
    elif spectrogram_image is not None:
        # Strings (URLs / data-URLs) pass through directly
        if isinstance(spectrogram_image, str):
            img_src = spectrogram_image
        else:
            # Everything else → PNG bytes → base64 data-URL
            png_bytes = _coerce_image_to_png_bytes(spectrogram_image)
            img_b64 = base64.b64encode(png_bytes).decode("ascii")
            img_src = f"data:image/png;base64,{img_b64}"

        # Build options object for setSpectrogramImage
        img_opts_parts = []
        if sample_rate:
            img_opts_parts.append(f"sampleRate: {sample_rate}")
        if freq_range is not None:
            img_opts_parts.append(f"freqRange: [{freq_range[0]}, {freq_range[1]}]")
        if freq_scale is not None:
            img_opts_parts.append(f"freqScale: '{freq_scale}'")
        img_opts_str = ", ".join(img_opts_parts)

        spect_js = f"""
      // Inject pre-rendered spectrogram image
      await player.setSpectrogramImage('{img_src}', {{{img_opts_str}}});
"""

    srcdoc = f"""
<!DOCTYPE html>
<html>
<head>
  <meta charset='utf-8' />
  <meta name='viewport' content='width=device-width, initial-scale=1' />
  <script src='https://unpkg.com/wavesurfer@7'></script>
  <style>{_PLAYER_CSS}</style>
  <style>
    html, body {{ margin:0; padding:0; width:100%; height:100%; overflow:hidden; }}
    #player {{ width:100%; height:100%; }}
  </style>
</head>
<body>
  <div id='player'></div>
  <script>{_PLAYER_JS}</script>
  <script>
    (async function() {{
      if (!window.BirdNETPlayerModule?.BirdNETPlayer) {{
        document.body.innerHTML = "<pre style='padding:12px;color:#b91c1c'>BirdNETPlayerModule failed to load</pre>";
        return;
      }}
      const playerRoot = document.getElementById('player');
      const player = new BirdNETPlayerModule.BirdNETPlayer(playerRoot, {opts});
      await player.ready;
      const binary = atob('{b64_audio}');
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      const file = new File([bytes], 'audio.wav', {{ type: 'audio/wav' }});
      await player.loadFile(file);{spect_js}
    }})();
  </script>
</body>
</html>
"""

    escaped = html.escape(srcdoc, quote=True)
    return (
        f"<iframe style='width:100%;height:{iframe_height}px;border:0' "
        f"srcdoc=\"{escaped}\"></iframe>"
    )
