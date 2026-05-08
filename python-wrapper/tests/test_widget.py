"""Tests for signavis.widget (AudioWorkbenchWidget)."""

from __future__ import annotations

import io
import json
import struct
import unittest
from unittest.mock import MagicMock, patch


def _make_wav_bytes(n_samples: int = 160, sr: int = 16000) -> bytes:
    """Create a minimal valid 16-bit mono WAV in memory."""
    data_size = n_samples * 2
    buf = io.BytesIO()
    buf.write(b"RIFF")
    buf.write(struct.pack("<I", 36 + data_size))
    buf.write(b"WAVE")
    buf.write(b"fmt ")
    buf.write(struct.pack("<I", 16))
    buf.write(struct.pack("<HHIIHH", 1, 1, sr, sr * 2, 2, 16))
    buf.write(b"data")
    buf.write(struct.pack("<I", data_size))
    buf.write(b"\x00" * data_size)
    return buf.getvalue()


class TestWidgetImport(unittest.TestCase):
    def test_importable(self):
        from signavis.widget import AudioWorkbenchWidget
        self.assertTrue(callable(AudioWorkbenchWidget))

    def test_exported_from_package(self):
        from signavis import AudioWorkbenchWidget
        self.assertTrue(callable(AudioWorkbenchWidget))


class TestWidgetConstruction(unittest.TestCase):
    def test_basic_construction(self):
        from signavis.widget import AudioWorkbenchWidget

        w = AudioWorkbenchWidget(_make_wav_bytes())
        self.assertIsNotNone(w._audio_b64)
        self.assertGreater(len(w._audio_b64), 0)
        self.assertEqual(w.annotations, [])
        self.assertEqual(w.spectrogram_labels, [])
        self.assertEqual(w.current_time, 0.0)
        self.assertEqual(w.duration, 0.0)
        self.assertFalse(w.playing)

    def test_options_forwarded(self):
        from signavis.widget import AudioWorkbenchWidget

        w = AudioWorkbenchWidget(
            _make_wav_bytes(), viewMode="spectrogram", showZoom=False
        )
        opts = json.loads(w._player_options)
        self.assertEqual(opts["viewMode"], "spectrogram")
        self.assertFalse(opts["showZoom"])

    def test_spectrogram_data(self):
        import numpy as np
        from signavis.widget import AudioWorkbenchWidget

        arr = np.random.rand(50, 32).astype(np.float32)
        w = AudioWorkbenchWidget(_make_wav_bytes(), spectrogram_data=arr)
        self.assertGreater(len(w._spectrogram_b64), 0)
        meta = json.loads(w._spectrogram_meta)
        self.assertEqual(meta["type"], "data")
        self.assertEqual(meta["n_frames"], 50)
        self.assertEqual(meta["n_mels"], 32)

    def test_spectrogram_image_url(self):
        from signavis.widget import AudioWorkbenchWidget

        w = AudioWorkbenchWidget(
            _make_wav_bytes(),
            spectrogram_image="data:image/png;base64,AAAA",
        )
        meta = json.loads(w._spectrogram_meta)
        self.assertEqual(meta["type"], "image")
        self.assertTrue(meta["is_url"])

    def test_spectrogram_image_bytes(self):
        from signavis.widget import AudioWorkbenchWidget

        png = b"\x89PNG\r\n\x1a\n" + b"\x00" * 20
        w = AudioWorkbenchWidget(_make_wav_bytes(), spectrogram_image=png)
        meta = json.loads(w._spectrogram_meta)
        self.assertEqual(meta["type"], "image")
        self.assertFalse(meta["is_url"])

    def test_mutual_exclusion(self):
        import numpy as np
        from signavis.widget import AudioWorkbenchWidget

        with self.assertRaises(ValueError):
            AudioWorkbenchWidget(
                _make_wav_bytes(),
                spectrogram_data=np.zeros((10, 10)),
                spectrogram_image="data:image/png;base64,AAAA",
            )


class TestWidgetMethods(unittest.TestCase):
    def setUp(self):
        from signavis.widget import AudioWorkbenchWidget

        self.w = AudioWorkbenchWidget(_make_wav_bytes())
        self.w.send = MagicMock()

    def test_call(self):
        self.w.call("play")
        self.w.send.assert_called_with(
            {"type": "call", "method": "play", "args": []}
        )

    def test_call_with_args(self):
        anno = {"start": 1.0, "end": 2.0, "species": "Test"}
        self.w.call("addAnnotation", anno)
        self.w.send.assert_called_with(
            {"type": "call", "method": "addAnnotation", "args": [anno]}
        )

    def test_play(self):
        self.w.play()
        self.w.send.assert_called_with(
            {"type": "call", "method": "play", "args": []}
        )

    def test_pause(self):
        self.w.pause()
        self.w.send.assert_called_with(
            {"type": "call", "method": "pause", "args": []}
        )

    def test_stop(self):
        self.w.stop()
        self.w.send.assert_called_with(
            {"type": "call", "method": "stop", "args": []}
        )

    def test_sync(self):
        self.w.sync()
        self.w.send.assert_called_with({"type": "sync"})

    def test_set_annotations(self):
        annots = [{"start": 0.5, "end": 1.5, "species": "A"}]
        self.w.set_annotations(annots)
        self.assertEqual(self.w._annotations_in, annots)

    def test_set_spectrogram_labels(self):
        labels = [
            {"start": 1, "end": 2, "freqMin": 500, "freqMax": 8000, "label": "X"}
        ]
        self.w.set_spectrogram_labels(labels)
        self.assertEqual(self.w._spectrogram_labels_in, labels)


class TestWidgetEvents(unittest.TestCase):
    def test_on_event_callback(self):
        from signavis.widget import AudioWorkbenchWidget

        w = AudioWorkbenchWidget(_make_wav_bytes())
        received = []
        w.on_event("annotationcreate", lambda evt, detail: received.append(detail))

        # Simulate incoming message
        msg = {"type": "event", "event": "annotationcreate", "detail": {"id": "a1"}}
        w._handle_custom_msg(msg, [])

        self.assertEqual(len(received), 1)
        self.assertEqual(received[0]["id"], "a1")

    def test_unknown_event_ignored(self):
        from signavis.widget import AudioWorkbenchWidget

        w = AudioWorkbenchWidget(_make_wav_bytes())
        received = []
        w.on_event("annotationcreate", lambda e, d: received.append(d))

        msg = {"type": "event", "event": "other", "detail": {}}
        w._handle_custom_msg(msg, [])

        self.assertEqual(len(received), 0)

    def test_non_dict_msg_ignored(self):
        from signavis.widget import AudioWorkbenchWidget

        w = AudioWorkbenchWidget(_make_wav_bytes())
        # Should not raise
        w._handle_custom_msg("not a dict", [])
        w._handle_custom_msg(42, [])


class TestWidgetTraits(unittest.TestCase):
    def test_iife_inlined_in_esm(self):
        from signavis.widget import AudioWorkbenchWidget

        w = AudioWorkbenchWidget(_make_wav_bytes())
        # IIFE bundle is prepended to the ESM — both must be present
        self.assertIn("BirdNETPlayerModule", w._esm)
        self.assertIn("export async function render", w._esm)

    def test_player_css_loaded(self):
        from signavis.widget import AudioWorkbenchWidget

        w = AudioWorkbenchWidget(_make_wav_bytes())
        self.assertGreater(len(w._player_css), 0)

    def test_accepts_file_path(self):
        """Widget should accept a pathlib.Path and read the file."""
        import pathlib
        import tempfile

        wav = _make_wav_bytes()
        with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as f:
            f.write(wav)
            tmp_path = pathlib.Path(f.name)

        try:
            from signavis.widget import AudioWorkbenchWidget

            w = AudioWorkbenchWidget(tmp_path)
            self.assertGreater(len(w._audio_b64), 0)
        finally:
            tmp_path.unlink()

    def test_accepts_string_path(self):
        """Widget should accept a string file path."""
        import tempfile

        wav = _make_wav_bytes()
        with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as f:
            f.write(wav)
            tmp_name = f.name

        try:
            from signavis.widget import AudioWorkbenchWidget

            w = AudioWorkbenchWidget(tmp_name)
            self.assertGreater(len(w._audio_b64), 0)
        finally:
            import os
            os.unlink(tmp_name)


class TestPlayer(unittest.TestCase):
    """Tests for the convenience Player class."""

    def test_importable(self):
        from signavis import Player
        self.assertTrue(callable(Player))

    def test_repr_html(self):
        from signavis import Player

        p = Player(_make_wav_bytes())
        html = p._repr_html_()
        self.assertIn("<iframe", html)
        self.assertIn("srcdoc", html)

    def test_accepts_path(self):
        import pathlib
        import tempfile

        wav = _make_wav_bytes()
        with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as f:
            f.write(wav)
            tmp_path = pathlib.Path(f.name)

        try:
            from signavis import Player

            p = Player(tmp_path, viewMode="spectrogram")
            self.assertIn("<iframe", p._repr_html_())
        finally:
            tmp_path.unlink()

    def test_options_forwarded(self):
        from signavis import Player

        p = Player(_make_wav_bytes(), viewMode="waveform")
        self.assertIn("waveform", p._repr_html_())


class TestShowFunction(unittest.TestCase):
    """Tests for the show() convenience function."""

    def test_importable(self):
        from signavis import show
        self.assertTrue(callable(show))

    @patch("signavis.render_daw_player")
    def test_calls_display(self, mock_render):
        mock_render.return_value = "<iframe></iframe>"

        with patch("IPython.display.display") as mock_display:
            from signavis import show

            show(_make_wav_bytes(), viewMode="both")
            mock_display.assert_called_once()


if __name__ == "__main__":
    unittest.main()
