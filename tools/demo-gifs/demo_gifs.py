"""Record the demo GIFs for README / release notes.

    npm run dev                      # dev server (default http://localhost:5173)
    uv run --with playwright python -I tools/demo-gifs/demo_gifs.py [scene ...] [options]

Options:
    --url URL         base URL of the dev server (default http://localhost:5173)
    --out DIR         output folder (default docs/img/gifs); writes <scene>.gif and <scene>.mp4
    --audio FILE      recording used by the scenes (default tests/fixtures/local/XC204513.wav,
                      falls back to demo/samples/birdsong.wav)
    --keep-video      also keep the raw .webm recordings
    --list            list scenes and exit

Each scene is a module in tools/demo-gifs/scenes/ with a SCENE dict and a run(d) function
(d is a Director, see below). Without scene names, all scenes are recorded.
Needs ffmpeg on PATH.
"""
import importlib.util
import shutil
import subprocess
import sys
import time
from pathlib import Path

from playwright.sync_api import sync_playwright

HERE = Path(__file__).resolve().parent
REPO = HERE.parent.parent
SCENES_DIR = HERE / "scenes"

# Fake cursor, click ripple and caption banner. Headless Chromium has no visible pointer,
# so the overlay follows mouse events and makes clicks/drags readable in the GIF.
OVERLAY_JS = r"""
(() => {
  if (window.__demoOverlay) return;
  window.__demoOverlay = true;
  const css = `
    #demo-cursor { position: fixed; z-index: 2147483647; pointer-events: none; width: 22px; height: 22px;
      margin: -3px 0 0 -3px; left: -50px; top: -50px; transition: transform .08s; }
    #demo-cursor.down { transform: scale(.85); }
    .demo-ripple { position: fixed; z-index: 2147483646; pointer-events: none; width: 34px; height: 34px;
      margin: -17px 0 0 -17px; border-radius: 50%; border: 3px solid #ff9800; animation: demo-ripple .5s ease-out forwards; }
    @keyframes demo-ripple { from { transform: scale(.3); opacity: 1 } to { transform: scale(1.4); opacity: 0 } }
    #demo-caption { position: fixed; z-index: 2147483647; pointer-events: none; left: 50%; bottom: 28px;
      transform: translateX(-50%); max-width: 80%; padding: 10px 20px; border-radius: 10px;
      background: rgba(20, 24, 32, .88); color: #fff; font: 600 20px/1.3 system-ui, sans-serif;
      box-shadow: 0 6px 24px rgba(0,0,0,.35); opacity: 0; transition: opacity .25s; text-align: center; }
    #demo-caption.show { opacity: 1; }
    #demo-caption kbd { font: 600 16px ui-monospace, monospace; background: #fff2; border: 1px solid #fff5;
      border-radius: 4px; padding: 1px 6px; }`;
  const add = () => {
    const st = document.createElement('style'); st.textContent = css; document.head.appendChild(st);
    const c = document.createElement('div'); c.id = 'demo-cursor';
    c.innerHTML = '<svg width="22" height="22" viewBox="0 0 22 22"><path d="M2 2 L2 18 L6.5 13.5 L9.5 20 L12.5 18.7 L9.6 12.4 L16 12.4 Z" fill="#fff" stroke="#000" stroke-width="1.4" stroke-linejoin="round"/></svg>';
    document.body.appendChild(c);
    const cap = document.createElement('div'); cap.id = 'demo-caption'; document.body.appendChild(cap);
    const mv = e => { c.style.left = e.clientX + 'px'; c.style.top = e.clientY + 'px'; };
    addEventListener('mousemove', mv, true);
    addEventListener('mousedown', e => { mv(e); c.classList.add('down');
      const r = document.createElement('div'); r.className = 'demo-ripple';
      r.style.left = e.clientX + 'px'; r.style.top = e.clientY + 'px';
      document.body.appendChild(r); setTimeout(() => r.remove(), 600); }, true);
    addEventListener('mouseup', () => c.classList.remove('down'), true);
  };
  if (document.body) add(); else addEventListener('DOMContentLoaded', add);
  window.__demoCaption = (html) => {
    const cap = document.getElementById('demo-caption'); if (!cap) return;
    if (html) { cap.innerHTML = html; cap.classList.add('show'); } else cap.classList.remove('show');
  };
})();
"""

# Settings so every recording starts from the same clean state.
INIT_JS = """
localStorage.setItem('audio-workbench.xc-nokey-dismissed.v1','1');
localStorage.setItem('signavis.daily-tips.disabled','1');
localStorage.setItem('signavis.project-folder-hint.dismissed.v1','1');
"""


class Director:
    """Helpers for scenes: smooth mouse moves, captions, waits. `pg` is the Playwright page."""

    def __init__(self, pg, base_url, audio):
        self.pg = pg
        self.base_url = base_url.rstrip("/")
        self.audio = audio
        self.x, self.y = 640, 400
        self.start_t = None   # set by begin(); everything before is cut from the GIF

    # --- timeline ---
    def begin(self):
        """Mark the start of the visible GIF (call after loading / setup)."""
        self.start_t = time.monotonic()

    def wait(self, ms):
        self.pg.wait_for_timeout(ms)

    def caption(self, html, ms=0):
        self.pg.evaluate("h => window.__demoCaption(h)", html)
        if ms:
            self.wait(ms)

    def no_caption(self):
        self.pg.evaluate("() => window.__demoCaption('')")

    # --- navigation ---
    def open_app(self, page="demo/labeling-app.html"):
        self.pg.goto(f"{self.base_url}/{page}", timeout=180000)
        self.pg.wait_for_selector(".activity-btn", timeout=90000)
        self.wait(1500)
        self.move(640, 400, steps=1)

    def open_panel(self, pid, click=True):
        btn = self.pg.locator(f'.activity-btn[data-panel="{pid}"]').first
        if "active" not in (btn.get_attribute("class") or ""):
            self.click(btn) if click else btn.click()
        self.wait(500)

    def load_audio(self, path=None):
        """Load a local recording through the app's file input (default: --audio)."""
        self.pg.locator("#fileInput").set_input_files(str(path or self.audio))
        self.pg.wait_for_selector("[data-aw=spectrogramCanvas]", timeout=60000)
        self.wait(6000)
        self.pg.keyboard.press("Escape")

    def close_left_panel(self):
        """Collapse the left sidebar so the spectrogram gets the full width."""
        btn = self.pg.locator(".activity-btn.active").first
        if btn.count():
            btn.click()
            self.wait(800)

    def setup_recording(self, close_left=True):
        """Common start: app open, recording loaded, sidebar collapsed."""
        self.open_app()
        self.load_audio()
        if close_left:
            self.close_left_panel()

    def toolbar_button(self, text):
        return self.pg.locator("button.toolbar-btn, button", has_text=text).filter(visible=True).first

    def spectrogram_box(self):
        return self.pg.locator("[data-aw=spectrogramCanvas]").first.bounding_box()

    def at(self, fx, fy):
        """Point inside the spectrogram, as fractions of its width/height."""
        b = self.spectrogram_box()
        return b["x"] + b["width"] * fx, b["y"] + b["height"] * fy

    # --- mouse ---
    def move(self, x, y, steps=None):
        if steps is None:
            dist = ((x - self.x) ** 2 + (y - self.y) ** 2) ** 0.5
            steps = max(8, int(dist / 18))
        self.pg.mouse.move(x, y, steps=steps)
        self.x, self.y = x, y

    def _center(self, target):
        if isinstance(target, str):
            target = self.pg.locator(target).first
        b = target.bounding_box()
        return b["x"] + b["width"] / 2, b["y"] + b["height"] / 2

    def hover(self, target, ms=300):
        self.move(*self._center(target))
        self.wait(ms)

    def click(self, target=None, ms=400, button="left"):
        if target is not None:
            self.hover(target, 250)
        self.pg.mouse.down(button=button)
        self.wait(80)
        self.pg.mouse.up(button=button)
        self.wait(ms)

    def drag(self, x0, y0, x1, y1, steps=30, ms=400, modifier=None):
        self.move(x0, y0)
        self.wait(200)
        if modifier:
            self.pg.keyboard.down(modifier)
        self.pg.mouse.down()
        self.move(x1, y1, steps=steps)
        self.pg.mouse.up()
        if modifier:
            self.pg.keyboard.up(modifier)
        self.wait(ms)

    def wheel(self, dy, times=1, modifier=None, ms=120):
        if modifier:
            self.pg.keyboard.down(modifier)
        for _ in range(times):
            self.pg.mouse.wheel(0, dy)
            self.wait(ms)
        if modifier:
            self.pg.keyboard.up(modifier)

    def type(self, text, delay=70):
        self.pg.keyboard.type(text, delay=delay)


def load_scenes():
    scenes = {}
    for f in sorted(SCENES_DIR.glob("*.py")):
        spec = importlib.util.spec_from_file_location(f.stem, f)
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)
        scenes[mod.SCENE["name"]] = mod
    return scenes


def to_gif(webm, gif, skip_s, fps=10, width=860, colors=128):
    """Two-pass palette GIF. Spectrogram noise compresses badly, so fps/width/colours stay modest."""
    vf = (f"fps={fps},scale={width}:-1:flags=lanczos,split[a][b];"
          f"[a]palettegen=max_colors={colors}:stats_mode=diff[p];"
          "[b][p]paletteuse=dither=none:diff_mode=rectangle")
    subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-ss", f"{skip_s:.2f}", "-i", str(webm),
                    "-vf", vf, "-loop", "0", str(gif)], check=True)


def to_mp4(webm, mp4, skip_s, width=1280):
    """H.264 MP4 — a fraction of the GIF size, for release notes, docs and articles."""
    subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-ss", f"{skip_s:.2f}", "-i", str(webm),
                    "-vf", f"scale={width}:-2:flags=lanczos", "-c:v", "libx264", "-crf", "26",
                    "-preset", "slow", "-pix_fmt", "yuv420p", "-movflags", "+faststart", "-an", str(mp4)],
                   check=True)


def record(browser, mod, args):
    sc = mod.SCENE
    w, h = sc.get("viewport", (1280, 720))
    tmp = args["out"] / "_video" / sc["name"]
    shutil.rmtree(tmp, ignore_errors=True)
    ctx = browser.new_context(viewport={"width": w, "height": h}, device_scale_factor=1,
                              record_video_dir=str(tmp), record_video_size={"width": w, "height": h},
                              color_scheme=sc.get("theme", "light"))
    ctx.add_init_script(INIT_JS + sc.get("init_js", ""))
    ctx.add_init_script(OVERLAY_JS)
    pg = ctx.new_page()
    errors = []
    pg.on("pageerror", lambda e: errors.append(str(e)))
    t0 = time.monotonic()
    d = Director(pg, args["url"], args["audio"])
    try:
        mod.run(d)
        d.wait(sc.get("tail_ms", 1200))
    finally:
        video = pg.video
        ctx.close()
    webm = Path(video.path())
    skip = (d.start_t - t0) if d.start_t else 0.0
    gif = args["out"] / f"{sc['name']}.gif"
    to_gif(webm, gif, skip, fps=sc.get("fps", 10), width=sc.get("gif_width", 860))
    mp4 = gif.with_suffix(".mp4")
    to_mp4(webm, mp4, skip)
    if args["keep_video"]:
        shutil.copy(webm, args["out"] / f"{sc['name']}.webm")
    shutil.rmtree(tmp, ignore_errors=True)
    print(f"  {gif.name} {gif.stat().st_size // 1024} KB, {mp4.name} {mp4.stat().st_size // 1024} KB"
          + (f"  ({len(errors)} page errors: {errors[0][:120]})" if errors else ""))


def main(argv):
    fixture = REPO / "tests" / "fixtures" / "local" / "XC204513.wav"
    args = {"url": "http://localhost:5173", "out": REPO / "docs" / "img" / "gifs", "keep_video": False,
            "audio": fixture if fixture.exists() else REPO / "demo" / "samples" / "birdsong.wav"}
    names, it = [], iter(argv)
    for a in it:
        if a == "--url": args["url"] = next(it)
        elif a == "--out": args["out"] = Path(next(it)).resolve()
        elif a == "--audio": args["audio"] = Path(next(it)).resolve()
        elif a == "--keep-video": args["keep_video"] = True
        elif a == "--list": names = None; break
        else: names.append(a)
    scenes = load_scenes()
    if names is None:
        for n, m in scenes.items():
            print(f"{n:24} {m.SCENE.get('title', '')}")
        return
    if not shutil.which("ffmpeg"):
        sys.exit("ffmpeg not found on PATH")
    unknown = [n for n in names if n not in scenes]
    if unknown:
        sys.exit(f"unknown scene(s): {', '.join(unknown)} — see --list")
    args["out"].mkdir(parents=True, exist_ok=True)
    with sync_playwright() as p:
        b = p.chromium.launch(args=["--autoplay-policy=no-user-gesture-required"])
        for n in names or scenes:
            print(f"recording {n} ...")
            record(b, scenes[n], args)
        b.close()
    shutil.rmtree(args["out"] / "_video", ignore_errors=True)


if __name__ == "__main__":
    main(sys.argv[1:])
