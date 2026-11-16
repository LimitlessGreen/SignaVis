"""SpectrogramLabelLayer: the keyed render must equal a full rebuild after every operation.

Dev server needed:  uv run --with playwright python -I tools/perf/label-render-equivalence.py http://localhost:5191/demo/labeling-app.html
Per step: OK/DIFF against a forced full rebuild, and how many elements were reused.
"""
import sys, json
from playwright.sync_api import sync_playwright
url = sys.argv[1]
SNAP = """() => {
  const lay = window.__signavis.player.spectrogramLabels;
  return [...lay.overlay.children].map((el) => ({
    id: el.dataset.id, cls: [...el.classList].sort().join(' '), style: el.getAttribute('style'), html: el.innerHTML,
    text: [...(el.querySelector('.spectrogram-label-text')?.classList || [])].sort().join(' '),
  }));
}"""
with sync_playwright() as p:
    b = p.chromium.launch(); page = b.new_page(viewport={'width': 1400, 'height': 900})
    errs = []; page.on('pageerror', lambda e: errs.append(str(e)))
    page.goto(url, wait_until='networkidle'); page.wait_for_function('window.__signavis')
    page.evaluate("document.getElementById('loadSampleBtn')?.click()"); page.wait_for_timeout(3500)
    page.evaluate("""() => {
      const sv = window.__signavis; const labels = [];
      for (let i = 0; i < 200; i++) { const t = (i * 0.37) % 7.5;
        labels.push({ id: 'b' + i, start: t, end: t + 0.3 + (i % 3) * 0.2, freqMin: 1000 + (i % 7) * 500, freqMax: 3000 + (i % 7) * 500,
          label: 'Species ' + (i % 25), scientificName: '', origin: i % 5 ? 'manual' : 'BirdNET', setId: 'own', confidence: (i % 10) / 10, tags: {} }); }
      sv.state.labels = labels; sv.syncToPlayer();
    }""")
    page.wait_for_timeout(500)
    def check(name):
        page.wait_for_timeout(300)
        keyed = page.evaluate(SNAP)
        marks = page.evaluate("() => [...window.__signavis.player.spectrogramLabels.overlay.children].filter((e) => e.__m).length")
        page.evaluate("() => { const l = window.__signavis.player.spectrogramLabels; l._elById = new Map(); l.render(); }")
        full = page.evaluate(SNAP)
        ok = keyed == full
        diff = ''
        if not ok:
            for a, c in zip(keyed, full):
                if a != c:
                    diff = json.dumps({k: (a[k], c[k]) for k in a if a[k] != c[k]})[:400]; break
            if len(keyed) != len(full): diff += f' len {len(keyed)} vs {len(full)}'
        print(f'{name:28s} {"OK " if ok else "DIFF"}  elements {len(keyed)}, reused {marks}  {diff}')
        page.evaluate("() => { for (const e of window.__signavis.player.spectrogramLabels.overlay.children) e.__m = 1; }")
    page.evaluate("() => { for (const e of window.__signavis.player.spectrogramLabels.overlay.children) e.__m = 1; }")
    check('baseline')
    page.evaluate("() => window.__signavis.propsPanel.onChange('b7', { label: 'Umbenannt' })"); check('rename one')
    page.evaluate("() => window.__signavis.propsPanel.onChange('b8', { start: 0.05, end: 0.9 })"); check('move one (overlaps)')
    page.evaluate("() => { const sv = window.__signavis; sv.state.labels = sv.state.labels.filter((l) => l.id !== 'b9'); sv.syncToPlayer(); }"); check('delete one')
    page.evaluate("() => { const sv = window.__signavis; sv.state.labels.push({ id: 'new1', start: 1, end: 2, freqMin: 2000, freqMax: 6000, label: 'Neu', origin: 'manual', setId: 'own', tags: {} }); sv.syncToPlayer(); }"); check('add one')
    page.evaluate("() => { const sv = window.__signavis; sv.player.spectrogramLabels.setLockedIds(['b1', 'b2']); }"); check('lock two')
    page.evaluate("() => { const sv = window.__signavis; sv.player.options.labelConfidence = true; sv.syncToPlayer(); }"); check('confidence on (all)')
    page.evaluate("() => { const st = window.__signavis.player._state; st._setPixelsPerSecond(st.pixelsPerSecond * 2.5, true, 2, 0); }"); check('zoom in x2.5')
    page.evaluate("() => { const w = window.__signavis.player._state.d.canvasWrapper; w.scrollLeft = 600; w.dispatchEvent(new Event('scroll')); }"); check('scroll')
    page.evaluate("() => { const st = window.__signavis.player._state; st._setPixelsPerSecond(st.pixelsPerSecond / 2.5, true, 0, 0); }"); check('zoom out')
    for e in errs: print('pageerror', e[:200])
    b.close()
