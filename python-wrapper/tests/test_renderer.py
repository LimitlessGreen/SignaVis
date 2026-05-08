"""Tests for signavis.renderer."""

from __future__ import annotations

import base64
import io
import struct
import unittest
from unittest.mock import MagicMock, patch

# ---------------------------------------------------------------------------
# Minimal helpers
# ---------------------------------------------------------------------------


def _make_wav_bytes(n_samples: int = 160, sr: int = 16000) -> bytes:
    """Create a minimal valid 16-bit mono WAV in memory."""
    data_size = n_samples * 2  # 16-bit = 2 bytes/sample
    buf = io.BytesIO()
    # RIFF header
    buf.write(b"RIFF")
    buf.write(struct.pack("<I", 36 + data_size))
    buf.write(b"WAVE")
    # fmt sub-chunk
    buf.write(b"fmt ")
    buf.write(struct.pack("<I", 16))  # sub-chunk size
    buf.write(struct.pack("<HHIIHH", 1, 1, sr, sr * 2, 2, 16))
    # data sub-chunk
    buf.write(b"data")
    buf.write(struct.pack("<I", data_size))
    buf.write(b"\x00" * data_size)
    return buf.getvalue()


# ===========================================================================
# render_daw_player basics
# ===========================================================================


class TestRenderBasic(unittest.TestCase):
    def test_returns_iframe_html(self):
        from signavis.renderer import render_daw_player

        html = render_daw_player(_make_wav_bytes())
        self.assertIn("<iframe", html)
        self.assertIn("srcdoc=", html)

    def test_iframe_height_default(self):
        from signavis.renderer import render_daw_player

        html = render_daw_player(_make_wav_bytes())
        self.assertIn("height:620px", html)

    def test_iframe_height_custom(self):
        from signavis.renderer import render_daw_player

        html = render_daw_player(_make_wav_bytes(), iframe_height=400)
        self.assertIn("height:400px", html)

    def test_iframe_height_clamped(self):
        from signavis.renderer import render_daw_player

        html = render_daw_player(_make_wav_bytes(), iframe_height=5)
        self.assertIn("height:180px", html)

    def test_audio_base64_in_output(self):
        from signavis.renderer import render_daw_player

        wav = _make_wav_bytes()
        b64 = base64.b64encode(wav).decode("ascii")
        html = render_daw_player(wav)
        self.assertIn(b64, html)


# ===========================================================================
# _encode_spectrogram_data
# ===========================================================================


class TestEncodeSpectrogramData(unittest.TestCase):
    def test_basic_encoding(self):
        import numpy as np
        from signavis.renderer import _encode_spectrogram_data

        arr = np.random.rand(100, 64).astype(np.float32)
        b64, n_frames, n_mels = _encode_spectrogram_data(arr)
        self.assertEqual(n_frames, 100)
        self.assertEqual(n_mels, 64)
        # Decode back
        raw = base64.b64decode(b64)
        self.assertEqual(len(raw), 100 * 64 * 4)

    def test_auto_transpose(self):
        """Arrays shaped (n_mels, n_frames) should be auto-transposed."""
        import numpy as np
        from signavis.renderer import _encode_spectrogram_data

        # 64 mels × 200 frames — should be transposed to (200, 64)
        arr = np.random.rand(64, 200).astype(np.float32)
        b64, n_frames, n_mels = _encode_spectrogram_data(arr)
        self.assertEqual(n_frames, 200)
        self.assertEqual(n_mels, 64)

    def test_rejects_1d(self):
        import numpy as np
        from signavis.renderer import _encode_spectrogram_data

        with self.assertRaises(ValueError):
            _encode_spectrogram_data(np.zeros(100))

    def test_rejects_3d(self):
        import numpy as np
        from signavis.renderer import _encode_spectrogram_data

        with self.assertRaises(ValueError):
            _encode_spectrogram_data(np.zeros((10, 10, 3)))

    def test_float64_coerced_to_float32(self):
        import numpy as np
        from signavis.renderer import _encode_spectrogram_data

        arr = np.random.rand(50, 32)  # float64
        b64, n_frames, n_mels = _encode_spectrogram_data(arr)
        raw = base64.b64decode(b64)
        self.assertEqual(len(raw), 50 * 32 * 4)  # 4 bytes = float32

    def test_roundtrip_values(self):
        import numpy as np
        from signavis.renderer import _encode_spectrogram_data

        arr = np.array([[1.0, 2.0], [3.0, 4.0], [5.0, 6.0]], dtype=np.float32)
        b64, n_frames, n_mels = _encode_spectrogram_data(arr)
        raw = base64.b64decode(b64)
        recovered = np.frombuffer(raw, dtype=np.float32).reshape(n_frames, n_mels)
        np.testing.assert_array_equal(recovered, arr)

    def test_render_with_spectrogram_data(self):
        import numpy as np
        from signavis.renderer import render_daw_player

        arr = np.random.rand(50, 32).astype(np.float32)
        html = render_daw_player(_make_wav_bytes(), spectrogram_data=arr)
        self.assertIn("setSpectrogramData", html)
        self.assertIn("Float32Array", html)


# ===========================================================================
# _coerce_image_to_png_bytes
# ===========================================================================


class TestCoerceImageToPngBytes(unittest.TestCase):
    def test_bytes_passthrough(self):
        from signavis.renderer import _coerce_image_to_png_bytes

        raw = b"\x89PNG\r\n\x1a\n" + b"\x00" * 100
        result = _coerce_image_to_png_bytes(raw)
        self.assertIs(result, raw)

    def test_bytesio(self):
        from signavis.renderer import _coerce_image_to_png_bytes

        data = b"\x89PNG\r\n\x1a\n" + b"\x00" * 50
        buf = io.BytesIO(data)
        buf.seek(10)  # simulate partially-read buffer
        result = _coerce_image_to_png_bytes(buf)
        self.assertEqual(result, data)

    def test_matplotlib_figure(self):
        """Real matplotlib Figure → PNG (uses Agg backend)."""
        try:
            import matplotlib
            matplotlib.use("Agg")
            import matplotlib.pyplot as plt
        except ImportError:
            self.skipTest("matplotlib not installed")

        from signavis.renderer import _coerce_image_to_png_bytes

        fig, ax = plt.subplots(figsize=(3, 2))
        ax.bar([1, 2, 3], [4, 5, 6])
        result = _coerce_image_to_png_bytes(fig)
        self.assertTrue(result.startswith(b"\x89PNG"))
        self.assertGreater(len(result), 100)  # non-trivial PNG
        plt.close(fig)

    def test_pil_image(self):
        try:
            from PIL import Image as PILImage
        except ImportError:
            self.skipTest("Pillow not installed")

        from signavis.renderer import _coerce_image_to_png_bytes

        img = PILImage.new("L", (80, 40), color=127)
        result = _coerce_image_to_png_bytes(img)
        self.assertTrue(result.startswith(b"\x89PNG"))
        # Verify round-trip
        loaded = PILImage.open(io.BytesIO(result))
        self.assertEqual(loaded.size, (80, 40))

    def test_numpy_grayscale(self):
        try:
            import numpy as np
            from PIL import Image as PILImage  # noqa: F401 — needed by renderer
        except ImportError:
            self.skipTest("numpy + Pillow required")

        from signavis.renderer import _coerce_image_to_png_bytes

        arr = np.random.randint(0, 256, (40, 80), dtype=np.uint8)
        result = _coerce_image_to_png_bytes(arr)
        self.assertTrue(result.startswith(b"\x89PNG"))

    def test_numpy_rgb(self):
        try:
            import numpy as np
            from PIL import Image as PILImage  # noqa: F401
        except ImportError:
            self.skipTest("numpy + Pillow required")

        from signavis.renderer import _coerce_image_to_png_bytes

        arr = np.random.randint(0, 256, (40, 80, 3), dtype=np.uint8)
        result = _coerce_image_to_png_bytes(arr)
        self.assertTrue(result.startswith(b"\x89PNG"))

    def test_numpy_rgba(self):
        try:
            import numpy as np
            from PIL import Image as PILImage  # noqa: F401
        except ImportError:
            self.skipTest("numpy + Pillow required")

        from signavis.renderer import _coerce_image_to_png_bytes

        arr = np.random.randint(0, 256, (40, 80, 4), dtype=np.uint8)
        result = _coerce_image_to_png_bytes(arr)
        self.assertTrue(result.startswith(b"\x89PNG"))

    def test_unsupported_type(self):
        from signavis.renderer import _coerce_image_to_png_bytes

        with self.assertRaises(TypeError):
            _coerce_image_to_png_bytes(42)

    def test_numpy_bad_shape(self):
        import numpy as np
        from signavis.renderer import _coerce_image_to_png_bytes

        with self.assertRaises(ValueError):
            _coerce_image_to_png_bytes(np.zeros((10, 20, 5), dtype=np.uint8))

    def test_real_matplotlib_figure(self):
        try:
            import matplotlib
            matplotlib.use("Agg")
            import matplotlib.pyplot as plt
        except ImportError:
            self.skipTest("matplotlib not installed")

        from signavis.renderer import _coerce_image_to_png_bytes

        fig, ax = plt.subplots(figsize=(2, 2))
        ax.plot([0, 1], [0, 1])
        result = _coerce_image_to_png_bytes(fig)
        self.assertTrue(result.startswith(b"\x89PNG"))
        plt.close(fig)

    def test_render_with_image_string(self):
        from signavis.renderer import render_daw_player

        html = render_daw_player(
            _make_wav_bytes(),
            spectrogram_image="data:image/png;base64,AAAA",
        )
        self.assertIn("setSpectrogramImage", html)
        self.assertIn("data:image/png;base64,AAAA", html)

    def test_render_with_image_bytes(self):
        from signavis.renderer import render_daw_player

        png = b"\x89PNG\r\n\x1a\n" + b"\x00" * 20
        html = render_daw_player(_make_wav_bytes(), spectrogram_image=png)
        self.assertIn("setSpectrogramImage", html)
        self.assertIn("data:image/png;base64,", html)


# ===========================================================================
# Mutual exclusion
# ===========================================================================


class TestMutualExclusion(unittest.TestCase):
    def test_data_and_image_both_raises(self):
        import numpy as np
        from signavis.renderer import render_daw_player

        with self.assertRaises(ValueError):
            render_daw_player(
                _make_wav_bytes(),
                spectrogram_data=np.zeros((10, 10)),
                spectrogram_image="data:image/png;base64,AAAA",
            )


# ===========================================================================
# Additional render options
# ===========================================================================


class TestRenderOptions(unittest.TestCase):
    def test_sample_rate_in_data_mode(self):
        import numpy as np
        from signavis.renderer import render_daw_player

        arr = np.random.rand(50, 32).astype(np.float32)
        html = render_daw_player(
            _make_wav_bytes(), spectrogram_data=arr, sample_rate=48000
        )
        self.assertIn("sampleRate: 48000", html)

    def test_spectrogram_mode_classic(self):
        import numpy as np
        from signavis.renderer import render_daw_player

        arr = np.random.rand(50, 32).astype(np.float32)
        html = render_daw_player(
            _make_wav_bytes(), spectrogram_data=arr, spectrogram_mode="classic"
        )
        # HTML-escaped single quotes
        self.assertIn("classic", html)

    def test_options_forwarded_to_constructor(self):
        from signavis.renderer import render_daw_player

        html = render_daw_player(
            _make_wav_bytes(), showFileOpen=False, showZoom=True
        )
        self.assertIn("showFileOpen", html)
        self.assertIn("showZoom", html)

    def test_iframe_height_clamped_max(self):
        from signavis.renderer import render_daw_player

        html = render_daw_player(_make_wav_bytes(), iframe_height=9999)
        self.assertIn("height:1600px", html)

    def test_spectrogram_image_pil(self):
        try:
            from PIL import Image as PILImage
        except ImportError:
            self.skipTest("Pillow not installed")

        from signavis.renderer import render_daw_player

        img = PILImage.new("RGB", (10, 10))
        html = render_daw_player(_make_wav_bytes(), spectrogram_image=img)
        self.assertIn("setSpectrogramImage", html)


if __name__ == "__main__":
    unittest.main()
