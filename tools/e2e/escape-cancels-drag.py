"""Escape while dragging (or in grab mode) puts the label back on both layers; nothing reaches the app state.

Dev server needed:  uv run --with playwright python -I tools/e2e/escape-cancels-drag.py http://localhost:5191/demo/labeling-app.html
Also checks that the live highlight (linked-live) is gone after every drag.
"""
import sys
from playwright.sync_api import sync_playwright
url = sys.argv[1]
POS = """() => { const q = (s) => { const e = document.querySelector(s); return e ? Math.round(parseFloat(e.dataset.start) * 100) / 100 : null; };
  const l = window.__signavis.state.labels.find(x => x.id === 'e1');
  return { state: l && Math.round(l.start * 100) / 100, spec: q('.spectrogram-label-region[data-id="e1"]'), wave: q('.annotation-region[data-id="e1"]'),
    liveLinked: document.querySelectorAll('.linked-live').length, editing: document.querySelectorAll('.editing').length }; }"""
FULL = """() => { const snap = () => [window.__signavis.player.spectrogramLabels, window.__signavis.player.annotations].flatMap(l => [...l.overlay.children]).map(e => e.getAttribute('style') + [...e.classList].sort().join(' ') + e.dataset.start).join('\\n');
  const a = snap(); for (const l of [window.__signavis.player.spectrogramLabels, window.__signavis.player.annotations]) { l._elById = new Map(); l.render(); } return a === snap(); }"""
with sync_playwright() as p:
    b = p.chromium.launch(); page = b.new_page(viewport={'width': 1400, 'height': 900})
    errs = []; page.on('pageerror', lambda e: errs.append(str(e)))
    page.goto(url, wait_until='networkidle'); page.wait_for_function('window.__signavis')
    page.evaluate("document.getElementById('loadSampleBtn')?.click()"); page.wait_for_timeout(3500); page.keyboard.press('Escape')
    page.evaluate("""() => { const sv = window.__signavis;
      sv.state.labels = [{ id: 'e1', start: 2, end: 3.5, freqMin: 3000, freqMax: 7000, label: 'Esc', origin: 'manual', setId: 'own', tags: {} }];
      sv.syncToPlayer(); }""")
    page.wait_for_timeout(500)
    touched0 = page.evaluate("() => JSON.stringify(window.__signavis.state.labels[0])")
    for sel, name in [('.spectrogram-label-region[data-id="e1"]', 'spectrogram'), ('.annotation-region[data-id="e1"]', 'waveform')]:
        page.wait_for_timeout(1000)
        r = page.locator(sel).bounding_box(); cx, cy = r['x'] + r['width'] / 2, r['y'] + r['height'] / 2
        page.mouse.move(cx, cy); page.mouse.down(); page.mouse.move(cx + 150, cy + 30, steps=10); page.wait_for_timeout(100)
        during = page.evaluate(POS)
        page.keyboard.press('Escape'); page.wait_for_timeout(100)
        after_esc = page.evaluate(POS)
        page.mouse.move(cx + 220, cy + 40, steps=4); page.mouse.up(); page.wait_for_timeout(500)
        after_up = page.evaluate(POS)
        print(f'{name:11s} during {during}\n            after Esc {after_esc}\n            after mouse up {after_up}  | equals full rebuild: {page.evaluate(FULL)}')
    now = page.evaluate("() => JSON.stringify(window.__signavis.state.labels[0])"); import json as _j; a0, a1 = _j.loads(touched0), _j.loads(now)
    print("state label changed fields:", {k: (a0.get(k), a1.get(k)) for k in set(a0) | set(a1) if a0.get(k) != a1.get(k)})
    # a normal drag still commits
    r = page.locator('.spectrogram-label-region[data-id="e1"]').bounding_box(); cx, cy = r['x'] + r['width'] / 2, r['y'] + r['height'] / 2
    page.mouse.move(cx, cy); page.mouse.down(); page.mouse.move(cx + 150, cy, steps=10); page.mouse.up(); page.wait_for_timeout(500)
    print('normal drag afterwards:', page.evaluate(POS))
    # grab (g) + Escape on both layers
    for layer, name in [('spectrogramLabels', 'spectrogram grab'), ('annotations', 'waveform grab')]:
        sel = '.spectrogram-label-region[data-id="e1"]' if layer == 'spectrogramLabels' else '.annotation-region[data-id="e1"]'
        page.wait_for_timeout(800)
        r = page.locator(sel).bounding_box(); cx, cy = r['x'] + r['width'] / 2, r['y'] + r['height'] / 2
        page.mouse.move(cx, cy); page.wait_for_timeout(100)
        before = page.evaluate(POS)
        page.evaluate(f"() => window.__signavis.player.{layer}.startGrab('e1')")
        page.mouse.move(cx + 120, cy, steps=8); page.wait_for_timeout(100)
        during = page.evaluate(POS)
        page.keyboard.press('Escape'); page.wait_for_timeout(300)
        print(f'{name:17s} before {before}\n                  during {during}\n                  after Esc {page.evaluate(POS)}')
    for e in errs: print('pageerror', e[:200])
    b.close()
