"""Carry a label to other recordings: its patch is looked for in the next recording opened.
Dev server needed:
  uv run --with playwright python -I tools/e2e/similar-carry.py http://localhost:5197/demo/labeling-app.html <clipA.wav> <clipB.wav> <clipB.selections.txt>
clipA: first 60 s of Powdermill Recording_1_Segment_05 (Wood Thrush at 2.93–5.15 s is the label);
clipB: first 60 s of Recording_2_Segment_03 (another day; its WOTH boxes are the truth). Exits non-zero on failure.
"""
import sys
from playwright.sync_api import sync_playwright
url, clip_a, clip_b, sel_b = sys.argv[1:5]
SV = 'window.__signavis'
rows = [l.split('\t') for l in open(sel_b).read().replace('\r', '').splitlines()]
cols = rows[0]
ib, ie, isp = cols.index('Begin Time (s)'), cols.index('End Time (s)'), cols.index('Species')
woth = [(float(r[ib]), float(r[ie])) for r in rows[1:] if r[isp].strip() == 'WOTH' and float(r[ie]) <= 60]
fails = []
def check(ok, what):
    print(('ok   ' if ok else 'FAIL ') + what)
    if not ok: fails.append(what)

with sync_playwright() as p:
    b = p.chromium.launch(); page = b.new_page(viewport={'width': 1500, 'height': 900})
    errs = []; page.on('pageerror', lambda e: errs.append(str(e)))
    page.goto(url, wait_until='networkidle'); page.wait_for_function(SV)
    page.set_input_files('#fileInput', clip_a)
    page.wait_for_function(f"{SV}.player._state?.audioBuffer?.duration > 50", timeout=30000)
    page.wait_for_timeout(5000); page.keyboard.press('Escape')
    page.evaluate(f"""() => {{ const sv = {SV}; sv.state.labels.push({{ id: 'ex', setId: 'own', origin: 'manual', label: 'Wood Thrush',
        scientificName: 'Hylocichla mustelina', start: 2.93, end: 5.15, freqMin: 1167, freqMax: 5496 }}); sv.syncToPlayer(); }}""")
    page.evaluate(f"async () => {SV}.carrySimilarExemplar({SV}.state.labels.find(l => l.id === 'ex'))")
    meta = page.evaluate("document.getElementById('selectionMeta')?.textContent")
    check('every recording you open next' in meta, f'carry announced ({meta})')
    # Open another recording: it is searched for the carried label
    page.set_input_files('#fileInput', clip_b)
    page.get_by_role('button', name='Keep both').click(timeout=10000)   # label several recordings
    page.wait_for_selector('.similar-review:not(.similar-review--groups)', state='attached', timeout=60000)
    page.wait_for_timeout(500)
    title = page.locator('.similar-review:not(.similar-review--groups) .similar-review__title').inner_text()
    check(title == 'Similar to Wood Thrush', f'review opens in the new recording ({title})')
    sugg = page.evaluate(f"() => {SV}.state.labels.filter(l => l.origin === 'Similar').map(l => [l.start, l.end, l.similar.score, l.label, l.similar.sourceLabelId])")
    top = sorted(sugg, key=lambda x: -x[2])[:10]
    hit = lambda a, e: any(min(e, t1) - max(a, t0) > 0.3 * (e - a) for t0, t1 in woth)
    good = sum(hit(a, e) for a, e, *_ in top)
    print('top suggestions:', [(round(a, 1), round(c, 2), hit(a, e)) for a, e, c, *_ in top])
    check(len(top) >= 5 and good >= 0.7 * len(top), f'{good}/{len(top)} best suggestions are Wood Thrush songs of the other bird')
    check(all(s[3] == 'Wood Thrush' and s[4] == 'ex' for s in sugg), 'suggestions carry species and source label')
    page.keyboard.press('Enter'); page.wait_for_timeout(400)
    own = page.evaluate(f"() => {SV}.state.labels.filter(l => l.origin === 'manual')")
    check(len(own) == 1 and own[0]['adoptedFrom']['similar']['sourceLabelId'] == 'ex', 'Enter copies into this recording, provenance kept')
    check(not errs, f'page errors: {errs}')
    b.close()
sys.exit(1 if fails else 0)
