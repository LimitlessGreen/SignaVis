"""Waveform track: moving, renaming and deleting a label there must reach the app state.

Dev server needed:  uv run --with playwright python -I tools/e2e/waveform-track-edits.py http://localhost:5191/demo/labeling-app.html
Each line: state / spectrogram / waveform track, then again after an app sync (must not undo the edit).
"""
import sys
from playwright.sync_api import sync_playwright
url = sys.argv[1]
ST = "() => { const l = window.__signavis.state.labels.find(x => x.id === 'w1'); return l ? [Math.round(l.start*100)/100, l.label] : null; }"
SP = "() => { const e = document.querySelector('.spectrogram-label-region[data-id=\"w1\"]'); return e ? [Math.round(parseFloat(e.dataset.start)*100)/100, e.querySelector('.spectrogram-label-name')?.textContent] : null; }"
WF = "() => { const e = document.querySelector('.annotation-region[data-id=\"w1\"]'); return e ? [Math.round(parseFloat(e.dataset.start)*100)/100, e.querySelector('.annotation-label')?.textContent] : null; }"
def show(page, step):
    page.wait_for_timeout(500)
    s, sp, wf = page.evaluate(ST), page.evaluate(SP), page.evaluate(WF)
    # a sync from the app (as after any other edit) must not undo it
    page.evaluate("() => window.__signavis.syncToPlayer()"); page.wait_for_timeout(300)
    s2, sp2 = page.evaluate(ST), page.evaluate(SP)
    print(f'{step:22s} state {s}  spectrogram {sp}  waveform {wf}  | after app sync: state {s2} spectrogram {sp2}')
with sync_playwright() as p:
    b = p.chromium.launch(); page = b.new_page(viewport={'width': 1400, 'height': 900})
    errs = []; page.on('pageerror', lambda e: errs.append(str(e)))
    page.goto(url, wait_until='networkidle'); page.wait_for_function('window.__signavis')
    page.evaluate("document.getElementById('loadSampleBtn')?.click()"); page.wait_for_timeout(3500)
    page.keyboard.press('Escape')
    page.evaluate("""() => { const sv = window.__signavis;
      sv.labelStore.replaceAll([{ id: 'w1', start: 2, end: 3.5, freqMin: 3000, freqMax: 7000, label: 'Wave', origin: 'manual', setId: 'own', tags: {} }]);
      sv.syncToPlayer(); }""")
    show(page, 'start')
    box = lambda: page.evaluate("() => { const r = document.querySelector('.annotation-region[data-id=\"w1\"]').getBoundingClientRect(); return [r.x, r.y, r.width, r.height]; }")
    x, y, w, h = box(); cx, cy = x + w / 2, y + h / 2
    page.mouse.move(cx, cy); page.mouse.down(); page.mouse.move(cx + 200, cy, steps=10); page.mouse.up()
    show(page, 'drag on waveform')
    page.wait_for_timeout(800)
    page.locator('.annotation-region[data-id="w1"]').click(); page.wait_for_timeout(1000)   # opens the properties bar (layout shifts)
    page.locator('.annotation-region[data-id="w1"]').dblclick(); page.wait_for_timeout(400)
    page.screenshot(path='/tmp/awcheck/wavefix-dbl.png')
    print('editor open:', page.evaluate("() => !!document.querySelector('.label-editor-backdrop.show')"), 'region box', [round(v) for v in (x, y, w, h)])
    page.keyboard.press('Control+a'); page.keyboard.type('Umbenannt'); page.wait_for_timeout(200)
    page.get_by_role('button', name='Save').click()
    show(page, 'rename on waveform')
    page.wait_for_timeout(800)
    page.locator('.annotation-region[data-id="w1"]').click(button='right'); page.wait_for_timeout(300)
    page.get_by_text('Delete', exact=True).last.click()
    page.wait_for_timeout(500)
    print('after delete: state', page.evaluate(ST), '| spectrogram', page.evaluate(SP), '| waveform', page.evaluate(WF),
          '| list rows', page.evaluate("() => document.querySelectorAll('.lt-row').length"))
    page.evaluate("() => window.__signavis.syncToPlayer()"); page.wait_for_timeout(300)
    print('after app sync: spectrogram', page.evaluate(SP), '| waveform', page.evaluate(WF))
    for e in errs: print('pageerror', e[:200])
    b.close()
