"""Folder workflow test (plans/unified-workflow-plan.md, phase 6): project folder with sub-folders.

uv run --with playwright python -I tools/labeling-snapshots/workflow.py <outdir> [--birdnet]
Needs the dev server on port 5199. Instead of the folder picker, an OPFS sub-folder is created
(garden/2026/a1.wav, garden/a2.wav, top.wav from ./samples/birdsong.wav) and registered as the
recent project folder. Checks + console errors go to <outdir>/report.txt.
"""
import sys
from pathlib import Path
from playwright.sync_api import sync_playwright

OUT = Path(sys.argv[1])
OUT.mkdir(parents=True, exist_ok=True)
RUN_BIRDNET = "--birdnet" in sys.argv
URL = "http://localhost:5199/demo/labeling-app.html"
UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36")
report = []
dialog_answers = []


def check(name, ok, detail=""):
    report.append(f"{'OK  ' if ok else 'FAIL'} {name}" + (f" — {detail}" if detail else ""))


SETUP_JS = """
async () => {
  const root = await navigator.storage.getDirectory();
  try { await root.removeEntry('testproj', { recursive: true }); } catch {}
  const proj = await root.getDirectoryHandle('testproj', { create: true });
  const wav = await (await fetch('./samples/birdsong.wav')).arrayBuffer();
  const put = async (path) => {
    const parts = path.split('/');
    let dir = proj;
    for (const p of parts.slice(0, -1)) dir = await dir.getDirectoryHandle(p, { create: true });
    const fh = await dir.getFileHandle(parts.at(-1), { create: true });
    const w = await fh.createWritable(); await w.write(wav); await w.close();
  };
  for (const p of ['garden/2026/a1.wav', 'garden/a2.wav', 'top.wav']) await put(p);
  await new Promise((res, rej) => {
    const req = indexedDB.open('signavis-project-folders', 1);
    req.onupgradeneeded = () => req.result.createObjectStore('handles');
    req.onsuccess = () => {
      const tx = req.result.transaction('handles', 'readwrite');
      tx.objectStore('handles').put(proj, 'recent');
      tx.oncomplete = res; tx.onerror = () => rej(tx.error);
    };
    req.onerror = () => rej(req.error);
  });
  localStorage.setItem('signavis.project.location.v1', 'folder');
  localStorage.setItem('signavis.explorer-open-folders.v1', JSON.stringify(['@local', 'garden', 'garden/2026']));
}
"""


def open_panel(pg, pid):
    btn = pg.locator(f'.activity-btn[data-panel="{pid}"]').first
    if "active" not in (btn.get_attribute("class") or ""):
        btn.click()
    pg.wait_for_timeout(600)


def explorer_text(pg):
    return pg.locator("#recordingExplorerMount").inner_text()


def main():
    with sync_playwright() as p:
        b = p.chromium.launch()
        ctx = b.new_context(viewport={"width": 1600, "height": 950}, user_agent=UA)
        ctx.add_init_script("localStorage.setItem('audio-workbench.xc-nokey-dismissed.v1','1');localStorage.setItem('signavis.daily-tips.disabled','1');")
        pg = ctx.new_page()
        pg.on("console", lambda m: m.type == "error" and report.append(f"console: {m.text}"))
        pg.on("pageerror", lambda e: report.append(f"pageerror: {e}"))
        pg.on("dialog", lambda d: d.accept(dialog_answers.pop(0) if dialog_answers else None))
        shot = lambda name: pg.screenshot(path=OUT / f"{name}.png")

        pg.goto(URL)
        pg.wait_for_selector(".activity-btn", timeout=90000)
        pg.evaluate(SETUP_JS)
        pg.reload()
        pg.wait_for_selector(".activity-btn", timeout=90000)
        pg.wait_for_timeout(3000)
        open_panel(pg, "project")
        pg.wait_for_timeout(1500)
        shot("01-project-folder")
        t = explorer_text(pg)
        check("tree: project folder node", "testproj" in t, t.replace("\n", " | ")[:300])
        check("tree: sub-folders garden / 2026", "garden" in t and "2026" in t)
        check("tree: unopened files listed", all(f in t for f in ("a1.wav", "a2.wav", "top.wav")))
        check("storage: no '+' list", pg.locator(".pl-unadded li").count() == 0)

        # Open a1.wav by clicking it
        pg.locator(".recording-explorer-row--file", has_text="a1.wav").first.click()
        pg.wait_for_timeout(5000)
        shot("02-opened-a1")
        check("a1 opened: transient row with +", pg.locator(".recording-explorer-row--transient .recording-explorer-keep").count() == 1)

        # Draw a label
        box = pg.locator("[data-aw=spectrogramCanvas]").first.bounding_box()
        x0, y0 = box["x"] + box["width"] * 0.1, box["y"] + box["height"] * 0.4
        # Draw mode is on by default: a plain drag draws and opens the "New label" dialog
        # (the first drags after loading can be swallowed while the spectrogram is still settling)
        for attempt in range(4):
            pg.mouse.move(x0 + attempt * 160, y0); pg.mouse.down()
            pg.mouse.move(x0 + attempt * 160 + 140, y0 + 80, steps=8); pg.mouse.up()
            pg.wait_for_timeout(800)
            if pg.locator(".label-search-input").first.is_visible():
                break
            pg.keyboard.press("Escape"); pg.wait_for_timeout(1500)
        check("draw: New label dialog opened", pg.locator(".label-search-input").first.is_visible(), f"attempts={attempt + 1}")
        pg.locator(".label-search-input").first.fill("Turdus merula"); pg.wait_for_timeout(1200)
        shot("03a-new-label-dialog")
        pg.keyboard.press("Enter"); pg.wait_for_timeout(600)
        save = pg.locator("button", has_text="Save").first
        if save.is_visible():
            save.click(); pg.wait_for_timeout(600)
        open_panel(pg, "project")
        shot("03-after-label")
        check("a1 with label: no longer transient", pg.locator(".recording-explorer-row--transient").count() == 0)

        # Labels tab: My labels + new layer
        open_panel(pg, "labels")
        lt = pg.locator("#panelLabels, .scroll-panel:visible").first.inner_text()
        check("labels: 'My labels' section", "My labels" in lt, lt.replace("\n", " | ")[:200])
        dialog_answers.append("Annotator B")
        sec = pg.locator('.lt-src[data-set-key="own"]').first
        sec.locator(".lt-src-head").hover()
        sec.locator(".lt-more").first.click()
        pg.wait_for_timeout(300)
        pg.get_by_text("New layer…").first.click()
        pg.wait_for_timeout(800)
        shot("04-labels-layer-bar")
        check("labels: layer bar with 2 chips", pg.locator(".lt-layer-chip").count() == 2)

        # Upload tab: assign XC number to a1, grouping
        open_panel(pg, "upload")
        shot("05-upload-before")
        dialog_answers.append("928094")
        btn = pg.locator(".us-panel button", has_text="Assign XC number").first
        if btn.count():
            btn.click(); pg.wait_for_timeout(1000)
        shot("06-upload-after-assign")
        ut = pg.locator("#xcSelection").inner_text()
        check("upload: a1 selectable after XC number", "XC928094" in ut, ut.replace("\n", " | ")[:200])
        check("upload: set details in upload tab", pg.locator("#panelXc #xcSetContainer").count() == 1)

        # Folder menu
        open_panel(pg, "project")
        folder = pg.locator(".recording-explorer-folder", has_text="garden").first
        folder.click(button="right")
        pg.wait_for_timeout(400)
        shot("07-folder-menu")
        menu = pg.locator(".context-menu, [role=menu]").first.inner_text() if pg.locator(".context-menu, [role=menu]").count() else ""
        check("folder menu: keep all + BirdNET", "Keep all" in menu and "BirdNET" in menu, menu.replace("\n", " | ")[:200])
        pg.keyboard.press("Escape")

        if RUN_BIRDNET:
            # garden = a1 (open, labeled) + a2 (never opened) → also tests switching recordings
            fg = pg.locator(".recording-explorer-folder", has_text="garden").first
            fg.click(button="right"); pg.wait_for_timeout(300)
            pg.get_by_text("Run BirdNET on this folder").first.click()
            pg.wait_for_function("document.body.innerText.includes('BirdNET done') || document.body.innerText.includes('BirdNET stopped')", timeout=240000)
            pg.wait_for_timeout(1000)
            shot("08-after-folder-birdnet")
            body = pg.locator("body").inner_text()
            check("folder BirdNET finished for 2 recordings", "BirdNET done for 2 of 2" in body)

        # Reload: viewed-only files are gone, labeled one stays
        pg.wait_for_timeout(3000)   # autosave
        pg.reload()
        pg.wait_for_selector(".activity-btn", timeout=90000)
        pg.wait_for_timeout(3000)
        open_panel(pg, "project")
        shot("09-after-reload")
        n_rec = pg.locator(".recording-explorer-row:not(.recording-explorer-row--file)").count()
        n_file = pg.locator(".recording-explorer-row--file").count()
        want = (2, 1) if RUN_BIRDNET else (1, 2)   # BirdNET keeps a2 (it got detections / was analyzed)
        check("reload: labeled/analyzed kept, others still unopened files", (n_rec, n_file) == want, f"recordings={n_rec} files={n_file}")
        ctx.close(); b.close()

    (OUT / "report.txt").write_text("\n".join(report) + "\n", encoding="utf-8")
    sys.stdout.buffer.write(("\n".join(report) + "\n").encode("utf-8"))


main()
