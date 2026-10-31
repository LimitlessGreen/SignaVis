"""Load an XC recording with the API key, check value lists and N/P. Usage: <outdir> <xc-nr>
Key: read from ~/.signavis-xc-key, injected into the test browser only, never printed. Dev server on :5199.
uv run --with playwright python -I tools/labeling-snapshots/xctest.py ...
"""
import sys, json, re
sys.stdout.reconfigure(encoding='utf-8')
from pathlib import Path
from playwright.sync_api import sync_playwright
OUT=Path(sys.argv[1]); OUT.mkdir(parents=True,exist_ok=True)
XC=sys.argv[2]
KEY=(Path.home()/".signavis-xc-key").read_text(encoding="utf-8-sig").strip()
def scrub(t): return t.replace(KEY,"***") if KEY else t
log=[]
def openp(pg,pid):
    btn=pg.locator(f'.activity-btn[data-panel="{pid}"]').first
    if "active" not in (btn.get_attribute("class") or ""): btn.click()
    pg.wait_for_timeout(500)
with sync_playwright() as p:
    b=p.chromium.launch(); ctx=b.new_context(viewport={"width":1600,"height":900}, user_agent="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36")
    ctx.add_init_script(f"localStorage.setItem('signavis.xc-api-key.v1',{json.dumps(KEY)});localStorage.setItem('aw:theme','light');")
    pg=ctx.new_page()
    pg.on("console", lambda m: m.type=="error" and log.append(scrub("console: "+m.text[:250])))
    pg.on("pageerror", lambda e: log.append(scrub(f"pageerror: {e}")))
    def onresp(r):
        u=r.url
        if "xeno-canto" in u and "/api/" in u:
            path=u.split("?")[0]
            log.append(f"api {r.status} {path} {'[group_properties]' if 'group_properties' in u else ''}")
            if "group_properties" in u:
                try: (OUT/"group_properties.json").write_text(scrub(r.text()),encoding="utf-8")
                except Exception as e: log.append(f"gp body err {e}")
    pg.on("response", onresp)
    pg.goto(f"http://localhost:5199/demo/labeling-app.html?xc={XC}")
    pg.wait_for_selector(".activity-btn",timeout=90000)
    pg.wait_for_timeout(30000)
    pg.screenshot(path=OUT/"x1-xc-loaded.png")
    openp(pg,"project"); pg.screenshot(path=OUT/"x2-project.png")
    openp(pg,"labels"); pg.screenshot(path=OUT/"x3-labels.png")
    print("labels tab:", scrub(pg.locator("#panelLabels").inner_text()[:400]).replace(chr(10)," | "))
    # select first label to see sound-type list
    regs=pg.locator(".spectrogram-container [data-id]")
    if regs.count():
        regs.first.click(); pg.wait_for_timeout(1000); openp(pg,"properties") if False else None
        pg.screenshot(path=OUT/"x4-label-props.png")
    # add demo, then N/P
    openp(pg,"project"); pg.evaluate("document.getElementById('loadSampleBtn').click()"); pg.wait_for_timeout(6000)
    fl=lambda: pg.locator("#fileLabel").inner_text()
    print("after demo:", fl())
    pg.mouse.click(900,500); pg.keyboard.press("p"); pg.wait_for_timeout(8000); print("after P:", fl())
    pg.keyboard.press("n"); pg.wait_for_timeout(6000); print("after N:", fl())
    pg.screenshot(path=OUT/"x5-after-np.png")
    b.close()
print("\n".join(log[:60]))
