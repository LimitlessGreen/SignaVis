"""App commands instead of button clicks (architecture step 3, part 2).

Dev server needed:  uv run --with playwright python -I tools/e2e/app-commands.py http://localhost:5191/demo/labeling-app.html [xc-number]
Checks: help menu loads the demo, Enter in the Xeno-canto field loads a recording (network), the phone
view turns draw mode off, the Draw button toggles it, key "b" starts BirdNET, the "no API key" dialog
stores the key on Enter. Prints one line per check; exits non-zero on failure.
"""
import sys
from playwright.sync_api import sync_playwright

url = sys.argv[1]
xc = sys.argv[2] if len(sys.argv) > 2 else None
fails = []


def check(name, ok, info=''):
    print(('ok  ' if ok else 'FAIL'), name, info)
    if not ok:
        fails.append(name)


with sync_playwright() as p:
    b = p.chromium.launch()
    page = b.new_page(viewport={'width': 1400, 'height': 900})
    errs = []
    page.on('pageerror', lambda e: errs.append(str(e)))
    page.goto(url, wait_until='networkidle'); page.wait_for_function('window.__signavis')
    page.keyboard.press('Escape')
    recs = lambda: page.evaluate("window.__signavis.recordingCount()")
    enter_xc = lambda v: page.evaluate("""(v) => { const i = document.getElementById('xcIdInput'); i.value = v;
        i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })); }""", v)

    # Help menu → Load demo recording
    page.click('#helpMenuBtn'); page.click('.ctx-item:has-text("Load demo recording")')
    page.wait_for_function("window.__signavis.activeRecordingId()", timeout=20000); page.wait_for_timeout(1500)
    page.keyboard.press('Escape')
    check('help menu loads demo', recs() == 1, f'recordings {recs()}')

    # Draw button toggles draw mode (setDrawMode)
    draw = lambda: page.evaluate("[window.__signavis.player.spectrogramLabels.drawMode, window.__signavis.player._drawBtn.classList.contains('active')]")
    before = draw()
    page.evaluate("window.__signavis.player._drawBtn.click()")
    after = draw()
    page.evaluate("window.__signavis.player._drawBtn.click()")
    check('draw button toggles', before == [True, True] and after == [False, False] and draw() == [True, True], f'{before} → {after} → {draw()}')

    # Key "b": BirdNET starts (button disabled while it runs) — or nothing when it cannot
    can = page.evaluate("!document.getElementById('birdnetAnalyzeBtn').disabled")
    page.mouse.click(5, 5); page.keyboard.press('b'); page.wait_for_timeout(300)
    started = page.evaluate("document.getElementById('birdnetAnalyzeBtn').disabled || /./.test(document.getElementById('birdnetStatus')?.textContent || '')")
    check('key b starts BirdNET', (not can) or started, f'could start {can}, started {started}')

    # "No API key" dialog: Enter stores the key through the XC panel
    page.evaluate("document.getElementById('xcNokeyModal')?.removeAttribute('hidden')")
    page.evaluate("""() => { const i = document.getElementById('xcNokeyKeyInput'); i.value = 'test-key-123'; i.dispatchEvent(new Event('input')); }""")
    page.focus('#xcNokeyKeyInput'); page.keyboard.press('Enter'); page.wait_for_timeout(500)
    key = page.evaluate("localStorage.getItem('xc_api_key') || Object.keys(localStorage).filter(k => /key/i.test(k)).map(k => localStorage.getItem(k)).join(',')")
    check('nokey Enter saves key', 'test-key-123' in (key or ''), repr(key))
    page.evaluate("Object.keys(localStorage).filter(k => /api.?key/i.test(k)).forEach(k => localStorage.removeItem(k))")

    # Enter in the Xeno-canto field loads the recording (network)
    if xc:
        enter_xc(xc)
        for _ in range(60):
            page.wait_for_timeout(1000)
            keep = page.locator('[data-v="keep"]')
            if keep.count() and keep.first.is_visible():
                keep.first.click()
            if recs() >= 2:
                break
        page.wait_for_timeout(1500)
        check('Enter loads Xeno-canto', recs() == 2, f'recordings {recs()}')
        # again: already in the session → switches, no new entry
        enter_xc(xc); page.wait_for_timeout(2000)
        check('same XC again: no duplicate', recs() == 2, f'recordings {recs()}')

    # Phone view: draw mode goes off
    page.set_viewport_size({'width': 412, 'height': 915}); page.wait_for_timeout(1500)
    check('phone view turns draw mode off', draw() == [False, False], str(draw()))

    # Phone: "Analyse" runs BirdBox through the host's run() (no desktop button click)
    page.evaluate("() => { document.getElementById('birdboxRunBtn').click = () => { throw new Error('clicked desktop button'); }; }")
    page.evaluate("window.__signavis.mobileApp.openAnalyse('recordings')"); page.wait_for_timeout(500)
    page.evaluate("""() => { const m = window.__signavis.mobileApp; m.anBirdnet.checked = false; m.anBirdbox.checked = true; m.runAnalysis(); }""")
    page.wait_for_timeout(1500)
    running = page.evaluate("[window.__signavis.mobileApp.anJob, getComputedStyle(document.getElementById('birdboxProgressWrap')).display, document.getElementById('birdboxStatus')?.textContent]")
    check('phone analyse starts BirdBox', running[0] == 'birdbox', str(running))

    # A second start while BirdBox runs (e.g. phone screen idle after a desktop start) keeps the first run
    same = page.evaluate("""() => { const sv = window.__signavis; const a = sv.birdboxPanel.abort;
        sv.mobileApp.anJob = 'idle'; sv.mobileApp.runAnalysis(); return !!a && sv.birdboxPanel.abort === a; }""")
    check('second BirdBox start ignored while running', same)
    page.evaluate("() => window.__signavis.birdboxPanel.stop?.()")

    # Xeno-canto: a second load while one runs is ignored (fetch stubbed, never resolves)
    calls = page.evaluate("""async () => { const sv = window.__signavis; let n = 0;
        sv.xcPanel.prefetchRecording = () => {};
        sv.xcPanel.fetchAudio = () => { n++; return new Promise(() => {}); };
        sv.loadXenoCanto('XC111'); sv.loadXenoCanto('XC222');
        await new Promise((r) => setTimeout(r, 4000)); return n; }""")
    check('one Xeno-canto load at a time', calls <= 1, f'fetches {calls}')

    # Folder BirdNET waits for a run it did not start instead of counting the recording as done
    page.evaluate("""() => { const p = window.__signavis.birdnetPanel; window.__bnRuns = [];
        p._analyze = async function () {          // stub: 1 s run, button disabled meanwhile
            this.analyzeBtn.disabled = true; const id = window.__signavis.activeRecordingId(); window.__bnRuns.push(id);
            await new Promise((r) => setTimeout(r, 1000)); this.analyzeBtn.disabled = false; }; }""")
    page.evaluate("() => { window.__signavis.birdnetPanel.analyze(); }")   # foreign run
    page.evaluate("() => { const sv = window.__signavis; window.__folder = sv.runBirdnetOnFolder({ entries: sv.recordings(), paths: [] }); }")
    page.wait_for_timeout(500)
    page.locator('button:has-text("Run")').last.click()
    page.wait_for_function("window.__bnRuns.length >= 1 + window.__signavis.recordings().length", timeout=30000)
    page.wait_for_timeout(800)
    runs = page.evaluate("window.__bnRuns.length"); n = page.evaluate("window.__signavis.recordings().length")
    meta = page.evaluate("document.getElementById('selectionMeta')?.textContent")
    check('folder BirdNET analyzes every recording', runs == 1 + n, f'runs {runs} for {n} recordings · {meta}')

    check('page errors', not errs, str(errs))
    b.close()

sys.exit(1 if fails else 0)
