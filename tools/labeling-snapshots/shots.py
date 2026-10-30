"""Screenshots of the labeling app: light + dark, 1600 + 1280 px, every sidebar tab.

uv run --with playwright python -I tools/labeling-snapshots/shots.py <outdir> [--birdnet]
Needs the dev server on port 5199 (npx vite --port 5199). Console errors go to <outdir>/console.txt.
"""
import sys
from pathlib import Path
from playwright.sync_api import sync_playwright

OUT = Path(sys.argv[1])
OUT.mkdir(parents=True, exist_ok=True)
RUN_BIRDNET = "--birdnet" in sys.argv
URL = "http://localhost:5199/demo/labeling-app.html"
log = []


def dismiss(pg):
    for sel in ("#xcNokeyCloseBtn", ".daily-tips button"):
        try:
            if pg.locator(sel).first.is_visible():
                pg.locator(sel).first.click()
        except Exception:
            pass


def open_panel(pg, pid):
    btn = pg.locator(f'.activity-btn[data-panel="{pid}"]').first
    if "active" not in (btn.get_attribute("class") or ""):
        btn.click()
    pg.wait_for_timeout(600)


def run(b, theme, width, waveform=True):
    tag = f"{theme}-{width}" + ("" if waveform else "-nowave")
    ctx = b.new_context(viewport={"width": width, "height": 900})
    ctx.add_init_script(
        f"localStorage.setItem('aw:theme','{theme}');"
        f"localStorage.setItem('signavis.labeling.show-waveform.v1','{1 if waveform else 0}');"
        "localStorage.setItem('audio-workbench.xc-nokey-dismissed.v1','1');"
    )
    pg = ctx.new_page()
    pg.on("console", lambda m: m.type == "error" and log.append(f"[{tag}] console: {m.text}"))
    pg.on("pageerror", lambda e: log.append(f"[{tag}] pageerror: {e}"))
    pg.goto(URL)
    pg.wait_for_selector(".activity-btn", timeout=90000)
    pg.wait_for_timeout(2000)
    dismiss(pg)
    shot = lambda name: pg.screenshot(path=OUT / f"{tag}-{name}.png")
    shot("00-start")

    open_panel(pg, "project")
    pg.click("#loadSampleBtn")
    pg.wait_for_timeout(6000)
    pg.keyboard.press("Escape")
    shot("01-demo-loaded")
    if not waveform:
        ctx.close()
        return

    ids = [x.get_attribute("data-panel") for x in pg.locator(".sidebar--left .activity-btn, .activity-bar .activity-btn").all()]
    for i, pid in enumerate(dict.fromkeys(ids)):
        if not pid:
            continue
        open_panel(pg, pid)
        shot(f"{i + 2:02d}-tab-{pid}")
        if pid == "analyse" and RUN_BIRDNET and theme == "light" and width == 1600:
            pg.click("#birdnetAnalyzeBtn")
            pg.wait_for_timeout(30000)
            shot(f"{i + 2:02d}-tab-analyse-after-run")

    # Draw a label (Shift+drag, name it), then select it → right bar opens with properties
    box = pg.locator("[data-aw=spectrogramCanvas]").first.bounding_box()
    x0, y0 = box["x"] + box["width"] * 0.05, box["y"] + box["height"] * 0.4
    pg.keyboard.down("Shift")
    pg.mouse.move(x0, y0); pg.mouse.down(); pg.mouse.move(x0 + 120, y0 + 80, steps=8); pg.mouse.up()
    pg.keyboard.up("Shift")
    pg.wait_for_timeout(600)
    pg.keyboard.type("Turdus"); pg.wait_for_timeout(600); pg.keyboard.press("Enter"); pg.wait_for_timeout(600)
    regions = pg.locator(".spectrogram-container [data-id]")
    if regions.count():
        regions.first.click()
        pg.wait_for_timeout(800)
        shot("20-label-selected")
    else:
        log.append(f"[{tag}] drawing a label failed")

    pg.click("#helpMenuBtn")
    pg.wait_for_timeout(300)
    shot("21-help-menu")
    pg.keyboard.press("Escape")
    ctx.close()


with sync_playwright() as p:
    b = p.chromium.launch()
    for theme in ("light", "dark"):
        for width in (1600, 1280):
            run(b, theme, width)
    run(b, "light", 1600, waveform=False)
    b.close()

(OUT / "console.txt").write_text("\n".join(log) or "no errors", encoding="utf-8")
print("\n".join(log) or "no console errors")
