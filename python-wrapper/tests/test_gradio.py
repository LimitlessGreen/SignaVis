"""Tests for signavis.gradio."""

from __future__ import annotations

import json
import os
import tempfile
import unittest

try:
    import gradio as gr

    from signavis.gradio import SignaVisPlayer, file_url, player_value
except ImportError:  # pragma: no cover
    gr = None


@unittest.skipIf(gr is None, "gradio not installed")
class TestPlayerValue(unittest.TestCase):
    def test_source_only(self):
        self.assertEqual(player_value("a.wav"), {"src": "a.wav"})

    def test_detections_are_copied(self):
        det = {"start": 1, "end": 2, "label": "x"}
        value = player_value("a.wav", detections=[det])
        value["detections"][0]["label"] = "y"
        self.assertEqual(det["label"], "x")

    def test_each_selection_is_distinct(self):
        a = player_value("a.wav", select=(1, 2))["select"]
        b = player_value("a.wav", select=(1, 2), play=False)["select"]
        self.assertEqual((a["start"], a["end"], a["play"]), (1.0, 2.0, True))
        self.assertFalse(b["play"])
        self.assertNotEqual(a["n"], b["n"])


@unittest.skipIf(gr is None, "gradio not installed")
class TestFileUrl(unittest.TestCase):
    def test_urls_pass_through(self):
        for url in ("https://x/a.wav", "data:audio/wav;base64,AA", "/gradio_api/file=a"):
            self.assertEqual(file_url(url), url)

    def test_path_is_served_by_gradio(self):
        with tempfile.TemporaryDirectory() as d:
            path = os.path.join(d, "a b.wav")
            url = file_url(path)
        self.assertTrue(url.startswith("/gradio_api/file="))
        self.assertTrue(url.endswith("/a%20b.wav"))
        self.assertNotIn("\\", url)


@unittest.skipIf(gr is None, "gradio not installed")
class TestSignaVisPlayer(unittest.TestCase):
    def test_options_are_baked_into_the_script(self):
        player = SignaVisPlayer(read_only=False, options={"viewMode": "both"})
        start = player.js_on_load.index("Object.assign({ WaveSurfer: window.WaveSurfer }, ")
        literal = player.js_on_load[start:].split(", ", 1)[1].split(");", 1)[0]
        opts = json.loads(literal)
        self.assertEqual(opts["viewMode"], "both")
        self.assertFalse(opts["readOnly"])
        self.assertFalse(opts["showFileOpen"])

    def test_assets_are_served_locally(self):
        head = SignaVisPlayer().head
        self.assertNotIn("unpkg", head)
        for name in ("birdnet-player.css", "wavesurfer.min.js", "birdnet-player.iife.js"):
            self.assertIn(name, head)

    def test_a_source_path_becomes_a_url(self):
        out = SignaVisPlayer().postprocess({"src": "https://x/a.wav", "detections": []})
        self.assertEqual(out, {"src": "https://x/a.wav", "detections": []})
        self.assertIsNone(SignaVisPlayer().postprocess(None))


if __name__ == "__main__":
    unittest.main()
