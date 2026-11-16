"""✓ on a BirdNET detection copies its BirdBox call box(es); ✓ on a BirdBox box takes the BirdNET species.
Dev server needed:  uv run --with playwright python -I tools/e2e/adopt-detection.py http://localhost:5191/demo/labeling-app.html [screenshot-dir]
"""
import sys
from playwright.sync_api import sync_playwright
url = sys.argv[1]; shots = sys.argv[2] if len(sys.argv) > 2 else None
OWN = "() => window.__signavis.state.labels.filter(l => l.origin === 'manual').map(l => `${l.label} ${l.start}-${l.end} ${l.freqMin}-${l.freqMax}Hz ${JSON.stringify(l.tags || {})}`)"
SEED = """() => { const sv = window.__signavis; sv.state.labelSets.set('bn', { id: 'bn', name: 'BirdNET', origin: 'BirdNET', locked: true, visible: true });
  sv.state.labelSets.set('bb', { id: 'bb', name: 'BirdBox', origin: 'BirdBox', locked: true, visible: true });
  const box = (id, s, e, c) => ({ id, setId: 'bb', origin: 'BirdBox', start: s, end: e, freqMin: 3000, freqMax: 7000, label: 'Bird', confidence: c });
  sv.state.labels = [
    { id: 'bn1', setId: 'bn', origin: 'BirdNET', start: 0, end: 3, freqMin: 0, freqMax: 24000, fullBand: true, label: 'Chaffinch', scientificName: 'Fringilla coelebs', confidence: 0.8 },
    box('b1', 0.5, 0.9, 0.5), box('b2', 1.4, 1.9, 0.9), box('b3', 2.3, 2.6, 0.7), box('b4', 5, 5.5, 0.8)];
  sv.syncToPlayer(); }"""
with sync_playwright() as p:
    b = p.chromium.launch(); page = b.new_page(viewport={'width': 1400, 'height': 900})
    errs = []; page.on('pageerror', lambda e: errs.append(str(e)))
    page.goto(url, wait_until='networkidle'); page.wait_for_function('window.__signavis')
    page.evaluate("document.getElementById('loadSampleBtn')?.click()"); page.wait_for_timeout(3500); page.keyboard.press('Escape')
    page.evaluate(SEED); page.wait_for_timeout(400)
    adopt = lambda id: (page.evaluate("id => window.__signavis.player._emit('spectrogramlabeladopt', { label: { id } })", id), page.wait_for_timeout(300))
    toast = lambda: page.locator('.undo-toast').inner_text().replace('\n', ' | ') if page.locator('.undo-toast').count() else '-'

    adopt('bn1'); print('✓ BirdNET      :', page.evaluate(OWN), '| toast:', toast())
    if shots: page.screenshot(path=f'{shots}/adopt-best.png')
    adopt('bn1'); print('✓ again        :', page.evaluate(OWN), '| toast:', toast())
    page.locator('.undo-toast__btn').first.click(); page.wait_for_timeout(300)
    print('"Other 1"      :', len(page.evaluate(OWN)), 'labels | toast:', toast())
    adopt('bn1'); print('✓ once more    :', len(page.evaluate(OWN)), 'labels')
    page.locator('.undo-toast__btn', has_text='Undo').click(); page.wait_for_timeout(300)
    print('Undo           :', len(page.evaluate(OWN)), 'labels')
    adopt('b1'); print('✓ box in window:', page.evaluate(OWN)[-1])
    page.evaluate("() => window.__signavis.player.setSpeciesBar('Robin', { tags: { sex: 'male' } })")
    adopt('b4'); print('✓ box, template:', page.evaluate(OWN)[-1])
    page.evaluate("() => { window.__signavis.player.setSpeciesBar('', { tags: null }); const sv = window.__signavis; sv.state.labels = sv.state.labels.filter(l => l.origin !== 'manual'); sv.syncToPlayer(); }")
    adopt('b4'); print('✓ box, no name :', page.evaluate(OWN), '| dialog open:', page.locator('.label-name-editor').count())
    page.keyboard.press('Escape')
    print('page errors:', errs)
    b.close()
