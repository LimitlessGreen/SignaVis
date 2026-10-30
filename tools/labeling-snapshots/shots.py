import sys
from pathlib import Path
from playwright.sync_api import sync_playwright

OUT = Path(sys.argv[1])
OUT.mkdir(parents=True, exist_ok=True)
URL = "http://localhost:5199/demo/labeling-app.html"

with sync_playwright() as p:
    b = p.chromium.launch()
    pg = b.new_page(viewport={"width": 1600, "height": 950})
    pg.goto(URL)
    pg.wait_for_selector(".activity-btn", timeout=90000); pg.wait_for_timeout(2000)
    for sel in ("#xcNokeyCloseBtn", ".daily-tips button"):
        try:
            if pg.locator(sel).first.is_visible():
                pg.locator(sel).first.click()
        except Exception:
            pass
    pg.screenshot(path=OUT / "00-start.png")
    pg.click("#loadSampleBtn")
    pg.wait_for_timeout(6000)
    pg.keyboard.press("Escape")
    pg.screenshot(path=OUT / "01-demo-loaded.png")

    bars = pg.locator(".activity-bar")
    print("bars", bars.count())
    btns = pg.locator(".activity-btn")
    ids = [btns.nth(i).get_attribute("data-panel") for i in range(btns.count())]
    print(ids)
    for i, pid in enumerate(ids):
        btn = btns.nth(i)
        # open panel (toggle: if active, it would close, so ensure open)
        cls = btn.get_attribute("class") or ""
        if "active" not in cls:
            btn.click()
        pg.wait_for_timeout(700)
        pg.screenshot(path=OUT / f"{i+2:02d}-{pid}.png")
        # expand XC edit + set tab for extra shots
        if pid == "xc":
            pg.click("#xcToggleRecordingEdit"); pg.wait_for_timeout(300)
            pg.screenshot(path=OUT / f"{i+2:02d}-xc-edit.png", full_page=True)
            pg.click("#xcTabSetBtn"); pg.wait_for_timeout(300)
            pg.screenshot(path=OUT / f"{i+2:02d}-xc-set.png", full_page=True)
        if pid == "birdnet":
            pg.click("#birdnetAnalyzeBtn")
            pg.wait_for_timeout(25000)
            pg.screenshot(path=OUT / f"{i+2:02d}-birdnet-after-run.png")
    b.close()
