# Demo GIFs

Scripted screen recordings of the labeling app for the README, release notes and docs.
Every scene is a short Playwright script, so the GIFs can be re-recorded after UI changes.

## Usage

```bash
npm run dev                # dev server on http://localhost:5173 (separate terminal)
npm run demo:gifs          # all scenes
npm run demo:gifs -- snap magnifier       # selected scenes
npm run demo:gifs -- --list               # list scenes
```

Needs [uv](https://docs.astral.sh/uv/) (installs Playwright on the fly) and `ffmpeg` on `PATH`.
First run: `uvx playwright install chromium`.

Output (default `docs/img/gifs/`): `<scene>.gif` (README) and `<scene>.mp4`
(H.264, ~5–10× smaller — for release notes, docs and articles).

Options: `--url`, `--out DIR`, `--audio FILE`, `--keep-video` (keep the raw `.webm`).

The scenes use `tests/fixtures/local/XC204513.wav`
([XC204513](https://xeno-canto.org/204513), *Zosterops borbonicus*) when present,
otherwise `demo/samples/birdsong.wav`.

## Writing a scene

Add `scenes/NN_name.py`:

```python
SCENE = {"name": "my-scene", "title": "What it shows", "viewport": (1440, 810)}

def run(d):
    d.setup_recording()            # open app, load audio, collapse sidebar (cut from the GIF)
    d.begin()                      # the GIF starts here
    d.caption("Explain the step", 1200)
    d.click('button[title^="Snap to call"]')
    d.drag(*d.at(0.3, 0.2), *d.at(0.4, 0.8))   # d.at(fx, fy): point inside the spectrogram
    d.no_caption()
```

`d` is the `Director` in `demo_gifs.py`: smooth mouse moves with a visible cursor and click
ripple, captions (`<b>`, `<kbd>` allowed), `wheel`, `type`, `open_panel`, `toolbar_button`.
Everything before `d.begin()` is cut, so setup and probing (see `scenes/03_snap.py`) stay
invisible.

GIF size: spectrogram noise compresses badly. Defaults are 10 fps, 860 px, 128 colours;
per scene override with `"fps"` / `"gif_width"` in `SCENE`. Keep scenes under ~20 s.
