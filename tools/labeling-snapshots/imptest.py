"""Import Annota set files into a loaded XC recording, incl. re-import + undo. Usage: <outdir> <dir with set928094.json/set1159843.json>
Key: read from ~/.signavis-xc-key, injected into the test browser only, never printed. Dev server on :5199.
uv run --with playwright python -I tools/labeling-snapshots/imptest.py ...
"""
import sys, json
sys.stdout.reconfigure(encoding='utf-8')
from pathlib import Path
from playwright.sync_api import sync_playwright
OUT=Path(sys.argv[1]); IMP=Path(sys.argv[2])
KEY=(Path.home()/".signavis-xc-key").read_text(encoding="utf-8-sig").strip()
UA="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36"
def openp(pg,pid):
    btn=pg.locator(f'.activity-btn[data-panel="{pid}"]').first
    if "active" not in (btn.get_attribute("class") or ""): btn.click()
    pg.wait_for_timeout(500)
def state(pg):
    return pg.locator("#panelLabels").inner_text()[:500].replace(chr(10)," | ")
with sync_playwright() as p:
    b=p.chromium.launch()
    for scen,url,files in [("A","?xc=928094",["set928094.json","set1159843.json"])]:
        ctx=b.new_context(viewport={"width":1600,"height":900},user_agent=UA)
        ctx.add_init_script(f"localStorage.setItem('signavis.xc-api-key.v1',{json.dumps(KEY)});localStorage.setItem('aw:theme','light');")
        pg=ctx.new_page()
        pg.on("pageerror", lambda e: print("pageerror", str(e).replace(KEY,'***')))
        pg.on("console", lambda m: m.type=="error" and print("console:", m.text[:200].replace(KEY,'***')))
        pg.goto("http://localhost:5199/demo/labeling-app.html"+url); pg.wait_for_selector(".activity-btn",timeout=90000); pg.wait_for_timeout(25000)
        try: pg.get_by_role("button", name="Close", exact=True).first.click(timeout=2000)
        except Exception: pass
        openp(pg,"labels"); print(scen,"before:", state(pg))
        for f in files:
            pg.set_input_files("#importSetInput", str(IMP/f)); pg.wait_for_timeout(1500)
            print(scen,f,"status:", pg.locator("#selectionMeta").inner_text())
            print(scen,f,"labels:", state(pg))
        pg.screenshot(path=OUT/f"imp-{scen}.png")
        pg.set_input_files("#importSetInput", str(IMP/"set928094.json")); pg.wait_for_timeout(1500)
        print(scen,"re-import:", state(pg)[:200])
        pg.locator(".undo-toast button").first.click(); pg.wait_for_timeout(800)
        print(scen,"after undo:", pg.locator("#selectionMeta").inner_text(), "|", state(pg)[:200])
        ctx.close()
    b.close()
