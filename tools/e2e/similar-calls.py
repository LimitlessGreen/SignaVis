"""Find similar calls: one own label → suggestions → review bar (Enter / X / Shift+Enter) → copies with provenance.
Dev server needed:  uv run --with playwright python -I tools/e2e/similar-calls.py http://localhost:5197/demo/labeling-app.html <clip.wav> [screenshot-dir]
The clip: first 60 s of Powdermill Recording_1_Segment_05 (Wood Thrush songs at 2.9, 11.0, 14.5, 19.1 … s).
Exits non-zero when a check fails.
"""
import sys
from playwright.sync_api import sync_playwright
url, clip = sys.argv[1], sys.argv[2]
shots = sys.argv[3] if len(sys.argv) > 3 else None
SV = 'window.__signavis'
SUGG = f"() => {SV}.state.labels.filter(l => l.origin === 'Similar').map(l => [l.start, l.similar.score, l.similar.sources.join('+')])"
OWN = f"() => {SV}.state.labels.filter(l => l.origin === 'manual')"
fails = []
def check(ok, what):
    print(('ok   ' if ok else 'FAIL ') + what)
    if not ok: fails.append(what)

with sync_playwright() as p:
    b = p.chromium.launch(); page = b.new_page(viewport={'width': 1500, 'height': 900})
    errs = []; page.on('pageerror', lambda e: errs.append(str(e)))
    page.goto(url, wait_until='networkidle'); page.wait_for_function(SV)
    page.set_input_files('#fileInput', clip)
    page.wait_for_function(f"{SV}.player._state?.audioBuffer?.duration > 50", timeout=30000)
    page.wait_for_function(f"{SV}.activeRecordingId() !== null", timeout=30000); page.keyboard.press('Escape')   # recording registered
    # One own label: the Wood Thrush song at 2.93–5.15 s
    page.evaluate(f"""() => {{ const sv = {SV}; const own = [...sv.state.labelSets.values()].find(s => s.origin !== 'BirdBox' && !s.locked)?.id;
        sv.state.labels.push({{ id: 'ex', setId: own, origin: 'manual', label: 'Wood Thrush', scientificName: 'Hylocichla mustelina',
          start: 2.93, end: 5.15, freqMin: 1167, freqMax: 5496 }}); sv.syncToPlayer(); sv.player.selectLabel('ex'); }}""")
    page.wait_for_timeout(500)
    page.evaluate("document.activeElement?.blur()")
    page.keyboard.press('f')
    page.wait_for_selector('.similar-review', state='attached', timeout=30000)
    s = page.evaluate(SUGG)
    print('suggestions (start, score, sources):', [(round(a, 2), round(c, 2), d) for a, c, d in sorted(s, key=lambda x: -x[1])][:10])
    truth = [11.03, 14.53, 19.14, 23.41, 26.80, 30.97, 35.43, 39.16, 44.40, 47.99, 51.55, 55.40, 58.88]
    top = sorted(s, key=lambda x: -x[1])[:8]
    good = sum(any(abs(a - t) < 0.6 for t in truth) for a, _, _ in top)
    check(good >= 6, f'{good}/8 best suggestions are Wood Thrush songs')
    check(page.locator('.similar-review__title').inner_text() == 'Similar to Wood Thrush', 'review bar title')
    if shots: page.screenshot(path=f'{shots}/similar-review.png')
    styles = page.evaluate("[...document.querySelectorAll('.spectrogram-label-region--similar, .annotation-region--similar')].map(e => getComputedStyle(e).borderTopStyle)")
    check(styles and all(x == 'dotted' for x in styles), f'suggestions are dotted {styles}')
    bar, spec = page.locator('.similar-review').bounding_box(), page.evaluate(f"() => {{ const r = {SV}.player._state.d.canvasWrapper.getBoundingClientRect(); return [r.top, r.bottom]; }}")
    check(spec[0] < bar['y'] and bar['y'] + bar['height'] <= spec[1], f'review bar sits inside the spectrogram (bar {bar}, spectrogram {spec})')

    n0 = len(s)
    before = page.locator('.similar-review__score').inner_text()
    page.keyboard.press('Enter'); page.wait_for_timeout(600)
    print('score shown before / after the first decision (re-ranked):', before, '/', page.locator('.similar-review__score').inner_text())
    own = page.evaluate(OWN)
    copied = [l for l in own if l['id'] != 'ex']
    check(len(copied) == 1 and copied[0]['adoptedFrom']['similar']['sourceLabelId'] == 'ex', 'Enter copies with adoptedFrom.similar')
    check(len(page.evaluate(SUGG)) == n0 - 1, 'copied suggestion leaves the suggestions')
    # Threshold to 0.25, Shift+Enter copies everything ranked at or above it (ranks after re-ranking)
    page.evaluate("() => { const r = document.querySelector('.similar-review input'); r.value = '0.25'; r.dispatchEvent(new Event('input')); }")
    page.wait_for_timeout(300)
    above = int(page.locator('[data-act="all"]').inner_text().split()[-1])
    page.keyboard.press('Shift+Enter'); page.wait_for_timeout(300)
    check(above > 0 and len(page.evaluate(OWN)) == 2 + above, f'Shift+Enter copies the {above} ranked above 0.25')
    page.locator('.undo-toast__btn', has_text='Undo').click(); page.wait_for_timeout(300)
    check(len(page.evaluate(OWN)) == 2, 'Undo takes the group back')

    def search():
        page.evaluate(f"() => {SV}.player.selectLabel('ex')"); page.evaluate("document.activeElement?.blur()")
        page.keyboard.press('f'); page.wait_for_timeout(300)
        page.wait_for_function("!document.getElementById('selectionMeta')?.textContent.startsWith('Looking')", timeout=30000)
        page.wait_for_timeout(300)
    search()
    check(len(page.evaluate(SUGG)) == n0 - 1, 'new search: the copied one stays out')
    page.keyboard.press('x'); page.wait_for_timeout(300)
    check(len(page.evaluate(SUGG)) == n0 - 2, 'X rejects one suggestion')
    check(page.evaluate(f"() => {SV}.state.labels.some(l => l.id === 'ex')"), 'X did not delete the exemplar')
    # ✗ on a suggestion box rejects it too, and the review drops it
    sid = page.evaluate(f"() => {SV}.state.labels.filter(l => l.origin === 'Similar').at(-1).id")
    page.evaluate(f"id => {SV}.player.spectrogramLabels.dispatchEvent(new CustomEvent('spectrogramlabelremove', {{ detail: {{ label: {SV}.state.labels.find(l => l.id === id) }} }}))", sid)
    page.wait_for_timeout(300)
    pos = page.locator('.similar-review__pos').inner_text()
    check(len(page.evaluate(SUGG)) == n0 - 3 and pos.endswith(f'/ {n0 - 3}'), f'✗ on the box rejects it (bar: {pos})')
    search()
    check(len(page.evaluate(SUGG)) == n0 - 3, 'new search: the copied and the two rejected ones stay out')
    # Narrow window: every control of the bar stays reachable
    page.set_viewport_size({'width': 320, 'height': 800}); page.wait_for_timeout(400)
    page.evaluate("window.dispatchEvent(new Event('resize'))"); page.wait_for_timeout(200)
    out = page.evaluate("[...document.querySelectorAll('.similar-review button, .similar-review input')].map(e => e.getBoundingClientRect()).filter(r => r.left < 0 || r.right > window.innerWidth).length")
    check(out == 0, f'at 320 px all controls are inside the window ({out} outside)')
    # The threshold slider keeps its arrow keys
    pos_before = page.locator('.similar-review__pos').inner_text()
    page.locator('.similar-review input').focus(); page.keyboard.press('ArrowRight'); page.wait_for_timeout(200)
    check(page.locator('.similar-review__pos').inner_text() == pos_before and page.locator('.similar-review output').inner_text() != '0.35',
          'arrow keys on the slider move the threshold, not the suggestions')
    page.evaluate("document.activeElement?.blur()")
    page.keyboard.press('Escape'); page.wait_for_timeout(200)
    check(page.locator('.similar-review').count() == 0, 'Esc closes the bar')
    check(not errs, f'page errors: {errs}')
    b.close()
sys.exit(1 if fails else 0)
