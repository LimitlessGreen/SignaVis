"""Viewport culling of the label layers, time-view chunks of the label list, overview segments.

Dev server needed:  uv run --with playwright python -I tools/e2e/label-culling.py http://localhost:5191/demo/labeling-app.html
- zoomed in, only labels near the view have elements; scrolling brings the others in
- the selected label keeps its element anywhere; the playhead highlight follows playback
- the time view of the label list builds rows in chunks, a far selection builds up to it
- a note edit keeps the overview segments, clicking one seeks to it
"""
import sys
from playwright.sync_api import sync_playwright
url = sys.argv[1]
fails = []
def check(name, ok, info=''):
    print(('ok   ' if ok else 'FAIL ') + name + (f'  {info}' if info else ''))
    if not ok: fails.append(name)

with sync_playwright() as p:
    b = p.chromium.launch(args=['--autoplay-policy=no-user-gesture-required']); page = b.new_page(viewport={'width': 1400, 'height': 900})
    errs = []; page.on('pageerror', lambda e: errs.append(str(e)))
    page.goto(url, wait_until='networkidle'); page.wait_for_function('window.__signavis')
    page.evaluate("document.getElementById('loadSampleBtn')?.click()"); page.wait_for_timeout(3500); page.keyboard.press('Escape')
    page.evaluate("""async () => { const sv = window.__signavis; const labels = [];
      for (let i = 0; i < 400; i++) { const t = i * 0.028; labels.push({ id: 'c' + i, start: t, end: t + 0.05, freqMin: 2000, freqMax: 5000, label: 'Sp ' + (i % 5), origin: 'manual', setId: 'own', tags: {} }); }
      sv.labelStore.replaceAll(labels); sv.syncToPlayer(); await new Promise(r => setTimeout(r, 500));
      sv.player._state._viewport._setPixelsPerSecond(2000, true); await new Promise(r => setTimeout(r, 800)); }""")
    r = page.evaluate("""async () => { const sv = window.__signavis; const st = sv.player._state; const w = st.d.canvasWrapper;
      const vis = () => { const a = st.coords.scrollXToTime(w.scrollLeft), z = st.coords.scrollXToTime(w.scrollLeft + w.clientWidth);
        const want = sv.state.labels.filter(l => l.end >= a && l.start <= z).map(l => l.id);
        return want.filter(id => !document.querySelector(`.spectrogram-label-region[data-id="${id}"]`) || !document.querySelector(`.annotation-region[data-id="${id}"]`)).length; };
      const out = { rendered: document.querySelectorAll('.spectrogram-label-region').length, missingStart: vis() };
      w.scrollLeft = st.coords.timeToScrollX(8); await new Promise(r => setTimeout(r, 300)); out.missingMid = vis();
      return out; }""")
    check('culling: fewer elements than labels', r['rendered'] < 400, str(r['rendered']))
    check('culling: every visible label has both elements', r['missingStart'] == 0 and r['missingMid'] == 0, str(r))
    r = page.evaluate("""async () => { const sv = window.__signavis; const st = sv.player._state; const w = st.d.canvasWrapper;
      sv.player.spectrogramLabels._selectedLabelId = 'c5'; sv.player.spectrogramLabels.render();
      const kept = !!document.querySelector('.spectrogram-label-region[data-id="c5"]');
      w.scrollLeft = 0; await new Promise(r => setTimeout(r, 300));
      sv.player.play(); await new Promise(r => setTimeout(r, 700)); sv.player.pause();
      return { kept, active: document.querySelectorAll('.spectrogram-label-region.active').length }; }""")
    check('culling: selected label kept off-screen', r['kept'])
    check('highlight follows playback', r['active'] >= 1, str(r['active']))
    # Culling renders must keep: the paused playhead highlight, focus on an off-screen label, drag previews
    r = page.evaluate("""async () => { const sv = window.__signavis, st = sv.player._state, w = st.d.canvasWrapper, L = sv.player.spectrogramLabels;
      const wait = (ms) => new Promise(r => setTimeout(r, ms));
      w.scrollLeft = 0; await wait(300);
      L.highlightActiveLabel(10 * 0.028 + 0.02);
      w.scrollLeft = st.coords.timeToScrollX(8); await wait(300);
      w.scrollLeft = 0; await wait(300);
      const out = { activeBack: !!document.querySelector('.spectrogram-label-region.active[data-id="c10"]') };
      sv.player._emit('labelfocus', { id: 'c380', source: 'overview', interaction: 'hover' }); await wait(100);
      out.focusSpec = !!document.querySelector('.spectrogram-label-region[data-id="c380"]');
      out.focusWave = !!document.querySelector('.annotation-region[data-id="c380"]');
      sv.player._emit('labelfocus', { id: null, source: 'overview', interaction: 'hover' });
      const draft = document.createElement('div'); draft.className = 'spectrogram-label-draft'; L.overlay.appendChild(draft); L._draftEl = draft;
      const zoom = document.createElement('div'); zoom.className = 'spectrogram-label-draft zoom-box'; L.overlay.appendChild(zoom); L._zoomBoxEl = zoom;
      w.scrollLeft = st.coords.timeToScrollX(8); await wait(300);
      out.draftKept = draft.isConnected; out.zoomKept = zoom.isConnected;
      draft.remove(); zoom.remove(); L._draftEl = null; L._zoomBoxEl = null; w.scrollLeft = 0; await wait(300);
      return out; }""")
    check('culling: paused highlight back after scrolling away and back', r['activeBack'], str(r))
    check('culling: focusing an off-screen label builds its elements', r['focusSpec'] and r['focusWave'], str(r))
    check('culling: draw / zoom-box previews survive a scroll render', r['draftKept'] and r['zoomKept'], str(r))
    page.evaluate("() => { const b = [...document.querySelectorAll('button')].find(x => (x.getAttribute('aria-label') || x.title || x.textContent).trim().startsWith('Labels')); b?.click(); }")
    page.wait_for_timeout(400)
    r = page.evaluate("""async () => { const L = window.__signavis.labelList; L._view = 'time'; L.render(L._labels);
      const rows = () => L._container.querySelectorAll('.lt-row').length; const out = { initial: rows() };
      L.highlightRow('c350', { scroll: false }); out.far = !!L._container.querySelector('.lt-row.selected[data-label-id="c350"]');
      let sc = L._container; while (sc && !(sc.scrollHeight > sc.clientHeight && /auto|scroll/.test(getComputedStyle(sc).overflowY))) sc = sc.parentElement;
      for (let i = 0; i < 30 && sc; i++) { sc.scrollTop = sc.scrollHeight; await new Promise(r => setTimeout(r, 60)); }
      out.all = rows(); out.sorted = [...L._container.querySelectorAll('.lt-row')].every((r, i, a) => i === 0 || +r.dataset.labelId.slice(1) > +a[i - 1].dataset.labelId.slice(1));
      L._view = 'sources'; L.render(L._labels); return out; }""")
    check('label list time view: first chunk only', r['initial'] < 400, str(r['initial']))
    check('label list time view: far selection built and marked', r['far'])
    check('label list time view: scrolling builds all rows in order', r['all'] == 400 and r['sorted'], str(r))
    r = page.evaluate("""async () => { const L = window.__signavis.labelList; L._view = 'time'; L.render(L._labels);
      const lazy = [...L._lazyGroupOf.keys()]; if (!lazy.length) return { lazyKept: false, rowOk: false, lazy: 0, rows: L._container.querySelectorAll('.lt-row').length, n: L._labels.length };
      const id = lazy[lazy.length - 1], stale = L._lazyGroupOf.get(id).__buildRows;   // as a queued observer entry of this render
      L.render(L._labels);
      stale();
      const row = L._cardMap.get(id);
      const out = { lazyKept: L._lazyGroupOf.has(id), rowOk: !row || row.isConnected };
      L._view = 'sources'; L.render(L._labels); return out; }""")
    check('label list time view: a superseded render builds nothing into the current one', r['lazyKept'] and r['rowOk'], str(r))
    r = page.evaluate("""async () => { const sv = window.__signavis; const seg = () => document.querySelector('.overview-label-segment[data-id="c3"]');
      const before = seg(); sv.propsPanel.onChange('c3', { note: 'x' }); await new Promise(r => setTimeout(r, 300)); return before && before === seg(); }""")
    check('overview: note edit keeps the segments', r)
    seg = page.locator('.overview-label-segment[data-id="c300"]')
    if seg.count():
        seg.click(); page.wait_for_timeout(300)
        t = page.evaluate('window.__signavis.player.currentTime')
        check('overview: click on a segment seeks to it', abs(t - (300 * 0.028 + 0.01)) < 0.2, f't={t:.2f}')
    for e in errs: print('pageerror:', e[:200])
    b.close()
sys.exit(1 if fails or errs else 0)
