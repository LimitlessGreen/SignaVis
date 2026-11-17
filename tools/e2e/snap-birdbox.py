"""Snap to call: first click starts BirdBox in the background, then the box under the click is BirdBox's;
Shift+wheel changes the confidence; where BirdBox has nothing the signal answers.
Dev server + models/birdbox-just-bird needed:
  uv run --with playwright python -I tools/e2e/snap-birdbox.py http://localhost:5191/demo/labeling-app.html [screenshot-dir]
"""
import sys
from playwright.sync_api import sync_playwright
url = sys.argv[1]; shots = sys.argv[2] if len(sys.argv) > 2 else None
CHIP = "() => { const e = window.__signavis.player.spectrogramLabels._snapEl; return e ? `${e.className} | ${e.innerText.replace(/\\s+/g, ' ')}` : '-'; }"
BOXES = "() => window.__signavis.state.labels.filter(l => l.origin === 'BirdBox').map(l => ({ start: l.start, end: l.end, freqMin: l.freqMin, freqMax: l.freqMax, confidence: l.confidence }))"
XY = """(p) => { const L = window.__signavis.player.spectrogramLabels, r = L.overlay.getBoundingClientRect();
  const w = parseFloat(L.overlay.style.width), h = parseFloat(L.overlay.style.height);
  const g = L._toGeometry(L._normalize({ start: p.t, end: p.t, freqMin: p.f, freqMax: p.f, label: '' }), w, h);
  return { x: r.left + g.left, y: r.top + g.top }; }"""
with sync_playwright() as p:
    b = p.chromium.launch(); page = b.new_page(viewport={'width': 1400, 'height': 900})
    errs = []; page.on('pageerror', lambda e: errs.append(str(e)))
    page.goto(url, wait_until='networkidle'); page.wait_for_function('window.__signavis')
    page.evaluate("document.getElementById('loadSampleBtn')?.click()"); page.wait_for_timeout(3500); page.keyboard.press('Escape')
    page.evaluate("() => { const sv = window.__signavis; sv.labelStore.replaceAll([]); sv.syncToPlayer(); }")
    page.evaluate("() => window.__signavis.player._snapBtn.click()")
    def click(t, f, **kw):
        pt = page.evaluate(XY, {'t': t, 'f': f}); page.mouse.click(pt['x'], pt['y'], **kw); page.wait_for_timeout(250); return pt

    click(1.0, 6000)
    print('first click (no rows yet):', page.evaluate(CHIP))
    page.wait_for_function("() => /Done|Error|Stopped/.test(document.getElementById('birdboxStatus').textContent)", timeout=180000)
    print('BirdBox:', page.inner_text('#birdboxStatus'))
    boxes = page.evaluate(BOXES); print(len(boxes), 'BirdBox boxes at the panel settings')
    if not boxes: print('page errors:', errs); sys.exit(1)
    best = max(boxes, key=lambda x: x['confidence'])
    t, f = (best['start'] + best['end']) / 2, (best['freqMin'] + best['freqMax']) / 2
    pt = click(t, f)
    print(f"click in box conf {best['confidence']:.2f}:", page.evaluate(CHIP))
    if shots: page.screenshot(path=f'{shots}/snap-birdbox.png')
    page.mouse.move(pt['x'], pt['y']); page.keyboard.down('Shift')
    for _ in range(18): page.mouse.wheel(0, 100)
    page.keyboard.up('Shift'); page.wait_for_timeout(200)
    print('confidence scrolled up     :', page.evaluate(CHIP))
    if shots: page.screenshot(path=f'{shots}/snap-fallback.png')
    page.keyboard.down('Shift')
    for _ in range(18): page.mouse.wheel(0, -100)
    page.keyboard.up('Shift'); page.wait_for_timeout(200)
    print('confidence scrolled down   :', page.evaluate(CHIP))
    page.evaluate("() => window.__signavis.player.setSpeciesBar('Chaffinch', { tags: { soundType: 'song' } })")
    page.keyboard.press('Enter'); page.wait_for_timeout(300)
    print('Enter:', page.evaluate("() => window.__signavis.state.labels.filter(l => l.origin === 'manual').map(l => `${l.label} ${l.start.toFixed(2)}-${l.end.toFixed(2)} ${Math.round(l.freqMin)}-${Math.round(l.freqMax)} Hz ${JSON.stringify(l.tags)}`)"))
    click(7.6, 600)
    print('click away from any box    :', page.evaluate(CHIP))
    print('page errors:', errs)
    b.close()
