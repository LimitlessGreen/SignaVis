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
        sv.labelStore.add({{ id: 'ex', setId: own, origin: 'manual', label: 'Wood Thrush', scientificName: 'Hylocichla mustelina',
          start: 2.93, end: 5.15, freqMin: 1167, freqMax: 5496 }}); sv.syncToPlayer(); sv.player.selectLabel('ex'); }}""")
    page.wait_for_timeout(500)
    page.evaluate("document.activeElement?.blur()")
    cap = page.locator('.spectrogram-label-text').first
    page.keyboard.down('h'); page.wait_for_timeout(200)
    check(cap.evaluate("e => getComputedStyle(e).opacity") == '0', 'holding H hides label captions (no review open)')
    page.keyboard.up('h'); page.wait_for_timeout(200)
    # Watch the main thread while searching: the longest gap between frames
    page.evaluate("() => { window.__gap = 0; let t = performance.now(); const tick = () => { const n = performance.now(); window.__gap = Math.max(window.__gap, n - t); t = n; if (!window.__stopGap) requestAnimationFrame(tick); }; requestAnimationFrame(tick); }")
    page.keyboard.press('f')
    busy = page.evaluate("document.getElementById('selectionMeta').classList.contains('is-busy')")
    page.wait_for_selector('.similar-review', state='attached', timeout=30000)
    gap = page.evaluate("() => { window.__stopGap = true; return window.__gap; }")
    check(busy, 'status bar shows the spinner while searching')
    check(not page.evaluate("document.getElementById('selectionMeta').classList.contains('is-busy')"), 'spinner gone once the review opens')
    check(gap < 250, f'page stays responsive while searching (longest frame gap {gap:.0f} ms)')
    s = page.evaluate(SUGG)
    print('suggestions (start, score, sources):', [(round(a, 2), round(c, 2), d) for a, c, d in sorted(s, key=lambda x: -x[1])][:10])
    truth = [11.03, 14.53, 19.14, 23.41, 26.80, 30.97, 35.43, 39.16, 44.40, 47.99, 51.55, 55.40, 58.88]
    top = sorted(s, key=lambda x: -x[1])[:8]
    good = sum(any(abs(a - t) < 0.6 for t in truth) for a, _, _ in top)
    check(good >= 6, f'{good}/8 best suggestions are Wood Thrush songs')
    check(page.locator('.similar-review__title').inner_text() == 'Similar to Wood Thrush', 'review bar title')
    if shots: page.screenshot(path=f'{shots}/similar-review.png')
    # Hovering keeps the bar (its buttons stay usable); a drag that passes near it fades it
    # and lets the drag through (ffc9ac6); H hides all overlays
    bar = page.locator('.similar-review'); bb = bar.bounding_box()
    cx = bb['x'] + bb['width'] / 2
    page.mouse.move(cx, bb['y'] - 10)
    check('aw-peek--faded' not in bar.get_attribute('class'), 'hovering near the bar keeps it')
    page.mouse.move(cx, bb['y'] - 80); page.mouse.down(); page.mouse.move(cx, bb['y'] - 10, steps=4)
    check('aw-peek--faded' in bar.get_attribute('class') and bar.evaluate("e => getComputedStyle(e).pointerEvents") == 'none', 'a drag near the bar fades it')
    page.mouse.move(cx, bb['y'] - 80, steps=4); page.mouse.up(); page.wait_for_timeout(150)
    check('aw-peek--faded' not in bar.get_attribute('class'), 'bar back after the drag')
    page.mouse.move(bb['x'] + bb['width'] / 2, 20)
    page.keyboard.down('h'); page.wait_for_timeout(200)
    check(bar.evaluate("e => getComputedStyle(e).opacity") == '0', 'holding H hides the bar')
    page.keyboard.up('h'); page.wait_for_timeout(200)
    check(bar.evaluate("e => getComputedStyle(e).opacity") == '1', 'letting go of H brings it back')
    # The suggestion under review stands out (solid, highlighted) and has live resize handles
    rev = page.locator('.spectrogram-label-region--reviewing')
    check(rev.count() == 1, f'exactly one suggestion is highlighted ({rev.count()})')
    cur = page.evaluate(f"() => {SV}.state.labels.find(l => l.similar?.active)")
    check(cur and rev.get_attribute('data-id') == cur['id'] and not cur['readonly'], 'the highlighted one is the one under review, editable')
    check(rev.locator('.handle-r').is_visible() and float(rev.locator('.handle-r').evaluate("e => getComputedStyle(e).opacity")) == 1,
          'its resize handles are shown')
    styles = page.evaluate("[...document.querySelectorAll('.spectrogram-label-region--similar:not(.spectrogram-label-region--reviewing), .annotation-region--similar')].map(e => getComputedStyle(e).borderTopStyle)")
    check(styles and all(x == 'dotted' for x in styles), f'suggestions are dotted {styles}')
    bar, spec = page.locator('.similar-review').bounding_box(), page.evaluate(f"() => {{ const r = {SV}.player._state.d.canvasWrapper.getBoundingClientRect(); return [r.top, r.bottom]; }}")
    check(spec[0] < bar['y'] and bar['y'] + bar['height'] <= spec[1], f'review bar sits inside the spectrogram (bar {bar}, spectrogram {spec})')

    n0 = len(s)
    before = page.locator('.similar-review__score').inner_text()
    # Fine correction: drag the right edge of the one under review, then copy it
    hb = rev.locator('.handle-r').bounding_box()
    page.mouse.move(hb['x'] + hb['width'] / 2, hb['y'] + hb['height'] / 2); page.mouse.down()
    page.mouse.move(hb['x'] + hb['width'] / 2 + 40, hb['y'] + hb['height'] / 2, steps=6); page.mouse.up()
    page.wait_for_timeout(300)
    resized = page.evaluate(f"id => {SV}.state.labels.find(l => l.id === id)", cur['id'])
    check(resized['end'] > cur['end'] + 0.05 and abs(resized['start'] - cur['start']) < 1e-6, f"right edge dragged ({cur['end']:.2f} → {resized['end']:.2f} s)")
    if shots: page.screenshot(path=f'{shots}/similar-review-resized.png')
    others = page.evaluate(f"() => {SV}.state.labels.filter(l => l.origin === 'Similar' && !l.similar.active).map(l => [l.id, l.end - l.similar.found.end])")
    # A click on another suggestion's box reviews that one; back to the corrected one by clicking it
    other = page.locator('.spectrogram-label-region--similar:not(.spectrogram-label-region--reviewing)').first
    other.scroll_into_view_if_needed(); oid = other.get_attribute('data-id'); other.click(); page.wait_for_timeout(300)
    check(page.evaluate(f"() => {SV}.state.labels.find(l => l.similar?.active)?.id") == oid
          and page.locator('.spectrogram-label-region--reviewing').get_attribute('data-id') == oid, 'clicking another suggestion reviews it')
    page.evaluate(f"id => {SV}.player.spectrogramLabels.dispatchEvent(new CustomEvent('labelfocus', {{ detail: {{ id, source: 'spectrogram', interaction: 'click' }} }}))", cur['id'])
    page.wait_for_timeout(300)
    check(page.evaluate(f"() => {SV}.state.labels.find(l => l.similar?.active)?.id") == cur['id'], 'and back to the corrected one')
    bar_h = page.locator('.similar-review').bounding_box()['height']
    check(bar_h <= 36, f'review bar stays compact ({bar_h:.0f} px)')
    page.evaluate("document.activeElement?.blur()")
    page.keyboard.press('Enter'); page.wait_for_timeout(600)
    print('score shown before / after the first decision (re-ranked):', before, '/', page.locator('.similar-review__score').inner_text())
    own = page.evaluate(OWN)
    copied = [l for l in own if l['id'] != 'ex']
    check(len(copied) == 1 and copied[0]['adoptedFrom']['similar']['sourceLabelId'] == 'ex', 'Enter copies with adoptedFrom.similar')
    check(len(copied) == 1 and abs(copied[0]['end'] - resized['end']) < 1e-6 and 'active' not in copied[0]['adoptedFrom']['similar'],
          'the copy has the corrected box')
    dend = resized['end'] - cur['end']
    spread = page.evaluate(f"() => {SV}.state.labels.filter(l => l.origin === 'Similar').map(l => l.end - l.similar.found.end)")
    check(spread and all(abs(x - dend) < 1e-3 for x in spread) and all(abs(x) < 1e-6 for _, x in others),
          f'the correction carries over to the suggestions not looked at yet (+{dend:.2f} s)')
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
    # Copy, close with Esc, then Undo: the copy goes, the restored suggestions do not come back without a review
    search()
    page.keyboard.press('Enter'); page.wait_for_timeout(300)
    page.keyboard.press('Escape'); page.wait_for_timeout(300)
    page.locator('.undo-toast__btn', has_text='Undo').last.click(); page.wait_for_timeout(300)
    check(len(page.evaluate(OWN)) == 2 and len(page.evaluate(SUGG)) == 0, 'Undo after Esc: copy undone, no suggestions left without a review')
    search()
    page.keyboard.press('x'); page.wait_for_timeout(300)
    check(len(page.evaluate(SUGG)) == n0 - 2, f'X rejects one suggestion ({n0} → {len(page.evaluate(SUGG))})')
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
    check(len(page.evaluate(SUGG)) == 0 and page.locator('.spectrogram-label-region--similar').count() == 0,
          'closed: suggestions not copied are gone')
    check(any(l.get('adoptedFrom') for l in page.evaluate(OWN)), 'closed: the copies stay')
    # Opening another file (Keep both) with the review open: the leaving recording is saved without suggestions
    search()
    check(len(page.evaluate(SUGG)) > 0, 'search again before switching')
    page.keyboard.press('Enter'); page.wait_for_timeout(300)   # copy one, then leave with Esc
    page.keyboard.press('Escape'); page.wait_for_timeout(300)
    first = page.evaluate(f"{SV}.activeRecordingId()")
    import shutil; other = clip[:-4] + '-copy.wav'; shutil.copy(clip, other)
    page.set_input_files('#fileInput', other)
    page.wait_for_timeout(500)
    if page.locator('.app-modal [data-v="keep"]').count(): page.locator('.app-modal [data-v="keep"]').click()
    page.wait_for_function(f"{SV}.activeRecordingId() !== null && {SV}.activeRecordingId() !== {first!r}", timeout=30000)
    page.wait_for_timeout(500)
    # Undo of a copy made in the first recording, pressed in the second: the first gets no suggestions back
    page.locator('.undo-toast__btn', has_text='Undo').last.click(); page.wait_for_timeout(500)
    saved = page.evaluate(f"id => ({SV}.recordings().find(e => e.id === id)?.annotations || []).filter(l => l.origin === 'Similar').length", first)
    check(saved == 0, f'switching file: no suggestions saved with the leaving recording ({saved})')
    check(page.locator('.similar-review').count() == 0, 'no review open after switching and Undo')
    # Switching file while the review is open (no Esc): it closes, nothing saved with the leaving recording
    page.evaluate(f"""() => {{ const sv = {SV}; const own = [...sv.state.labelSets.values()].find(s => s.origin !== 'BirdBox' && !s.locked)?.id;
        sv.labelStore.add({{ id: 'ex', setId: own, origin: 'manual', label: 'Wood Thrush', scientificName: 'Hylocichla mustelina',
          start: 2.93, end: 5.15, freqMin: 1167, freqMax: 5496 }}); sv.syncToPlayer(); }}""")
    search()
    check(page.locator('.similar-review').count() == 1 and len(page.evaluate(SUGG)) > 0, 'review open in the second recording')
    second = page.evaluate(f"{SV}.activeRecordingId()")
    third = clip[:-4] + '-copy2.wav'; shutil.copy(clip, third)
    page.set_input_files('#fileInput', third); page.wait_for_timeout(500)
    if page.locator('.app-modal [data-v="keep"]').count(): page.locator('.app-modal [data-v="keep"]').click()
    page.wait_for_function(f"{SV}.activeRecordingId() !== null && {SV}.activeRecordingId() !== {second!r}", timeout=30000)
    page.wait_for_timeout(500)
    check(page.locator('.similar-review').count() == 0, 'switching file closes the open review')
    saved = page.evaluate(f"id => ({SV}.recordings().find(e => e.id === id)?.annotations || []).filter(l => l.origin === 'Similar').length", second)
    check(saved == 0, f'switching with the review open: no suggestions saved with the leaving recording ({saved})')
    check(not errs, f'page errors: {errs}')
    b.close()
sys.exit(1 if fails else 0)
