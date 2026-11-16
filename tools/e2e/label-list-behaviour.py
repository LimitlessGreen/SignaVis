"""Label list: selection, hover, play state, late tag edits, range selection and all rows.

Run against two dev servers (old/new) and diff the output; it must be identical:
  uv run --with playwright python -I tools/e2e/label-list-behaviour.py http://localhost:5191/demo/labeling-app.html
"""
import sys, json, hashlib
from playwright.sync_api import sync_playwright
url = sys.argv[1]
SNAP = """() => [...document.querySelectorAll('.lt-grp.lt-open .lt-row')].map(r => r.outerHTML.replace(/\\s+/g, ' ')).join('\\n')"""
STATE = """() => ({ open: [...document.querySelectorAll('.lt-grp.lt-open')].map(g => g.dataset.groupKey),
  selected: [...document.querySelectorAll('.lt-row.selected')].map(r => r.dataset.labelId),
  multi: [...window.__signavis.labelList.multiSelectedIds].sort(),
  playing: [...document.querySelectorAll('.lt-row--playing')].map(r => r.dataset.labelId),
  highlighted: [...document.querySelectorAll('.lt-row.highlighted')].map(r => r.dataset.labelId) })"""
h = lambda s: hashlib.md5(s.encode()).hexdigest()[:10]
with sync_playwright() as p:
    b = p.chromium.launch(); page = b.new_page(viewport={'width': 1400, 'height': 900})
    errs = []; page.on('pageerror', lambda e: errs.append(str(e)))
    page.goto(url, wait_until='networkidle'); page.wait_for_function('window.__signavis')
    page.evaluate("document.getElementById('loadSampleBtn')?.click()"); page.wait_for_timeout(3500); page.keyboard.press('Escape')
    page.evaluate("""() => { const sv = window.__signavis; const labels = [];
      for (let i = 0; i < 60; i++) { const t = (i * 0.37) % 7.5;
        labels.push({ id: 'L' + i, start: t, end: t + 0.3, freqMin: 1000, freqMax: 3000, label: 'Species ' + (i % 6), scientificName: '', origin: 'manual', setId: 'own', tags: i % 4 ? {} : { sex: 'male' } }); }
      sv.state.labels = labels; sv.syncToPlayer(); }""")
    page.wait_for_timeout(500)
    document_tab = page.evaluate("() => { document.querySelector('[data-panel=labels]')?.click(); return true; }"); page.wait_for_timeout(300)
    out = []
    out.append(('initial', page.evaluate(STATE)))
    # select a label in a closed group (as a click on the spectrogram would)
    page.evaluate("() => window.__signavis.labelList.highlightRow('L13')"); page.wait_for_timeout(200)
    out.append(('highlight L13', page.evaluate(STATE)))
    # hover from spectrogram on a label in another closed group
    page.evaluate("() => window.__signavis.labelList.highlightHover('L20')"); page.wait_for_timeout(200)
    out.append(('hover L20', page.evaluate(STATE)))
    page.evaluate("() => window.__signavis.labelList.highlightHover(null)")
    # play state for a row in a closed group, then open it
    page.evaluate("() => window.__signavis.labelList.setPlaying('L4')"); page.wait_for_timeout(100)
    page.evaluate("() => window.__signavis.labelList.highlightRow('L4')"); page.wait_for_timeout(200)
    out.append(('playing L4 + reveal', page.evaluate(STATE)))
    page.evaluate("() => window.__signavis.labelList.setPlaying(null)")
    # tags changed without a render (props edit path), then the group opens
    page.evaluate("() => window.__signavis.propsPanel.onChange('L5', { tags: { sex: 'female' } })"); page.wait_for_timeout(200)
    page.evaluate("() => window.__signavis.labelList.highlightRow('L5')"); page.wait_for_timeout(200)
    out.append(('tags L5 then reveal', page.evaluate("() => document.querySelector('.lt-row[data-label-id=\"L5\"] .lt-tags')?.textContent")))
    # shift range select from L13 to L19 (order across groups)
    page.evaluate("() => { window.__signavis.labelList.highlightRow('L13'); window.__signavis.labelList._rangeSelect('L19'); }"); page.wait_for_timeout(200)
    out.append(('range L13..L19', page.evaluate(STATE)['multi']))
    page.evaluate("() => window.__signavis.labelList.clearMultiSelection()")
    # open every group, compare the rows
    page.evaluate("() => { for (const g of document.querySelectorAll('.lt-grp:not(.lt-open) .lt-sp')) g.click(); }"); page.wait_for_timeout(300)
    page.evaluate("() => { window.__signavis.labelList._accordion = false; for (const g of document.querySelectorAll('.lt-grp')) window.__signavis.labelList._setGroupOpen(g, true); }"); page.wait_for_timeout(300)
    rows = page.evaluate(SNAP)
    out.append(('all rows (md5, count)', (h(rows), rows.count('lt-row') )))
    # time view
    page.evaluate("() => window.__signavis.labelList.setView('time')"); page.wait_for_timeout(300)
    t = page.evaluate("() => [...document.querySelectorAll('.lt-row')].map(r => r.outerHTML.replace(/\\s+/g, ' ')).join('\\n')")
    out.append(('time view rows (md5, n)', (h(t), page.evaluate("() => document.querySelectorAll('.lt-row').length"))))
    page.evaluate("() => window.__signavis.labelList.setView('source')")
    for k, v in out: print(f'{k:24s} {json.dumps(v)}')
    for e in errs: print('pageerror', e[:200])
    b.close()
