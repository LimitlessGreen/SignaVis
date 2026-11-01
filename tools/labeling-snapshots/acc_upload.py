"""Fill profile/set, draw a label, upload to acc.xeno-canto.org. Usage: <outdir> [--upload] [--noid]
Key: read from ~/.signavis-xc-key, injected into the test browser only, never printed. Dev server on :5199.
uv run --with playwright python -I tools/labeling-snapshots/acc_upload.py ...
"""
import sys, json
sys.stdout.reconfigure(encoding='utf-8')
from pathlib import Path
from playwright.sync_api import sync_playwright
OUT=Path(sys.argv[1]); OUT.mkdir(parents=True,exist_ok=True)
DO_UPLOAD="--upload" in sys.argv
KEY=(Path.home()/".signavis-xc-key").read_text(encoding="utf-8-sig").strip()
scrub=lambda t: t.replace(KEY,"***")
log=[]
def openp(pg,pid):
    btn=pg.locator(f'.activity-btn[data-panel="{pid}"]').first
    if "active" not in (btn.get_attribute("class") or ""): btn.click()
    pg.wait_for_timeout(500)
UA="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36"
with sync_playwright() as p:
    b=p.chromium.launch(); ctx=b.new_context(viewport={"width":1600,"height":900},user_agent=UA)
    ctx.add_init_script(f"localStorage.setItem('signavis.xc-api-key.v1',{json.dumps(KEY)});localStorage.setItem('aw:theme','light');localStorage.setItem('signavis.daily-tips.disabled','1');")
    pg=ctx.new_page()
    def onreq(r):
        if r.method=="POST" and "upload/annotation-set" in r.url:
            body=json.loads(r.post_data or "{}")
            print("SENT to", r.url.split('?')[0], "| set_name:", body.get("set_name"), "| set_license:", body.get("set_license"), "| set_creator_id:", body.get("set_creator_id"), "| annotator_xc_id:", [a.get("annotator_xc_id") for a in body.get("annotations",[])])
    pg.on("request", onreq)
    pg.on("console", lambda m: m.type=="error" and log.append(scrub("console: "+m.text[:250])))
    pg.on("pageerror", lambda e: log.append(scrub(f"pageerror: {e}")))
    pg.on("response", lambda r: ("xeno-canto" in r.url and "/api/" in r.url) and log.append(f"api {r.status} {r.request.method} {r.url.split('?')[0]}"))
    pg.goto("http://localhost:5199/demo/labeling-app.html?xc=928094&xcenv=acc")
    pg.wait_for_selector(".activity-btn",timeout=90000); pg.wait_for_timeout(25000)
    try: pg.get_by_role("button", name="Close", exact=True).first.click(timeout=3000)
    except Exception: pass
    pg.wait_for_timeout(500); pg.screenshot(path=OUT/"u0-before-draw.png")
    # draw label
    box=pg.locator("[data-aw=spectrogramCanvas]").first.bounding_box()
    x0,y0=box["x"]+box["width"]*0.08,box["y"]+box["height"]*0.3
    # Draw mode: plain drag opens "New label" (retry — the first drags can be swallowed while loading)
    for i in range(4):
        pg.mouse.move(x0+i*120,y0); pg.mouse.down(); pg.mouse.move(x0+i*120+80,y0+150,steps=8); pg.mouse.up(); pg.wait_for_timeout(800)
        if pg.locator(".label-search-input").first.is_visible(): break
        # a species preselected in the top search bar (here: from the XC recording) labels directly, without dialog
        if pg.locator(".spectrogram-container .spectrogram-label-region").count(): break
        pg.keyboard.press("Escape"); pg.wait_for_timeout(1500)
    if pg.locator(".label-search-input").first.is_visible():
        pg.locator(".label-search-input").first.fill("Myotis dasycneme"); pg.wait_for_timeout(1200); pg.keyboard.press("Enter"); pg.wait_for_timeout(800)
    print("labels drawn:", pg.locator(".spectrogram-container .spectrogram-label-region").count())
    pg.locator(".spectrogram-container [data-id]").first.click(); pg.wait_for_timeout(500)
    pg.keyboard.press("2")  # 2nd sound type of the group list
    pg.wait_for_timeout(500)
    pg.screenshot(path=OUT/"u1-label.png")
    print("props:", pg.locator(".sidebar--right").inner_text()[:500].replace(chr(10)," | "))
    # profile in upload tab
    openp(pg,"upload")
    pg.locator("#panelXc input[placeholder='Your name']").fill("SignaVis Test")
    pg.locator("#panelXc input[placeholder^='xeno-canto contributor ID']").fill("" if "--noid" in sys.argv else "xc")
    pg.keyboard.press("Tab"); pg.wait_for_timeout(500)
    # set details live in the upload tab now
    pg.locator("#xcSetContainer input[placeholder*='Turdus']").fill("Myotis dasycneme"); pg.keyboard.press("Tab")
    sel=pg.locator("#xcSetContainer select").filter(has=pg.locator("option[value='part']")).first
    sel.select_option("part"); pg.wait_for_timeout(800)
    openp(pg,"upload"); pg.wait_for_timeout(800)
    pg.screenshot(path=OUT/"u2-checklist.png", full_page=True)
    print("selection:", pg.locator("#xcSelection").inner_text()[:400].replace(chr(10)," | "))
    print("checklist:", pg.locator("#xcChecklist").inner_text()[:900].replace(chr(10)," | "))
    btn=pg.locator("#xcUploadBtn")
    print("button:", btn.inner_text(), "disabled=", btn.is_disabled(), "| hint:", pg.locator("#xcUploadTargetHint").inner_text())
    if DO_UPLOAD and not btn.is_disabled():
        btn.click(); pg.wait_for_timeout(8000)
        print("status:", pg.locator("#xcStatus").inner_text())
        pg.screenshot(path=OUT/"u3-after-upload.png")
        print("uploaded sets:", pg.locator("#xcUploads").inner_text()[:300].replace(chr(10)," | "))
        # edit the label after the upload -> snapshot must say "changed"
        pg.locator(".spectrogram-container [data-id]").first.click(); pg.wait_for_timeout(300)
        pg.keyboard.press("3"); pg.wait_for_timeout(1500)
        openp(pg,"upload"); pg.wait_for_timeout(800)
        print("uploaded sets after edit:", pg.locator("#xcUploads").inner_text()[:300].replace(chr(10)," | "))
        pg.screenshot(path=OUT/"u4-after-edit.png", full_page=True)
    b.close()
print("\n".join(log[:40]))
