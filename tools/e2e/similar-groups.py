"""Overview: group the call boxes, name a group, check its members, copy them.
Dev server needed:  uv run --with playwright python -I tools/e2e/similar-groups.py http://localhost:5197/demo/labeling-app.html <clip.wav> <selections.txt> [screenshot-dir]
The clip: first 60 s of Powdermill Recording_1_Segment_05; its annotated boxes stand in for BirdBox's
(so the species of each box is known and group purity can be checked). Exits non-zero when a check fails.
"""
import json, sys
from playwright.sync_api import sync_playwright
url, clip, sel = sys.argv[1], sys.argv[2], sys.argv[3]
shots = sys.argv[4] if len(sys.argv) > 4 else None
SV = 'window.__signavis'
rows = [l.split('\t') for l in open(sel).read().splitlines()]
cols = rows[0]
ix = [cols.index(c) for c in ('Begin Time (s)', 'End Time (s)', 'Low Freq (Hz)', 'High Freq (Hz)', 'Species')]
truth = [dict(start=float(r[ix[0]]), end=float(r[ix[1]]), freqMin=float(r[ix[2]]), freqMax=float(r[ix[3]]), sp=r[ix[4]].strip())
         for r in rows[1:] if float(r[ix[1]]) <= 60]
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
    page.evaluate(f"""boxes => {{ const sv = {SV};
        sv.state.labelSets.set('bb', {{ id: 'bb', name: 'BirdBox', origin: 'BirdBox', locked: true, visible: true }});
        boxes.forEach((t, i) => sv.labelStore.add({{ id: 'bb' + i, setId: 'bb', origin: 'BirdBox', label: 'Bird', confidence: 0.5,
          start: t.start, end: t.end, freqMin: t.freqMin, freqMax: t.freqMax }}));
        sv.syncToPlayer(); }}""", truth)
    page.evaluate("document.getElementById('birdboxGroupBtn').click()")
    page.wait_for_selector('.similar-review--groups', state='attached', timeout=30000)
    page.wait_for_timeout(500)
    meta = page.evaluate("document.getElementById('selectionMeta')?.textContent")
    print('status:', meta)
    # Purity of the shown group: species of its members (box id bbN → truth[N])
    prev = page.evaluate(f"() => {SV}.state.labels.filter(l => l.similar?.preview).map(l => [l.start, l.end])")
    def sp_of(a, e):
        return next((t['sp'] for t in truth if abs(t['start'] - a) < 1e-3 and abs(t['end'] - e) < 1e-3), '?')
    species = [sp_of(a, e) for a, e in prev]
    top = max(set(species), key=species.count)
    print('first group:', len(species), 'calls,', {s: species.count(s) for s in set(species)})
    check(len(species) >= 4 and species.count(top) / len(species) >= 0.8, f'first group is ≥ 80 % one species ({top})')
    check(page.locator('.similar-review--groups .similar-review__score').inner_text() == f'{len(species)} calls', 'bar shows the group size')
    styles = page.evaluate("[...document.querySelectorAll('.spectrogram-label-region--similar')].map(e => getComputedStyle(e).borderTopStyle)")
    check(styles and all(x == 'dotted' for x in styles), 'group shown as dotted suggestions')
    if shots: page.screenshot(path=f'{shots}/groups.png')

    # Next / previous group
    page.keyboard.press('ArrowDown'); page.wait_for_timeout(300)
    pos2 = page.locator('.similar-review--groups .similar-review__pos').inner_text()
    page.keyboard.press('ArrowUp'); page.wait_for_timeout(300)
    check(pos2.startswith('2 /') and page.locator('.similar-review--groups .similar-review__pos').inner_text().startswith('1 /'), f'↓ / ↑ move between groups ({pos2})')

    # Name it via the template (no dialog), member review opens
    page.evaluate(f"name => {SV}.player.setSpeciesBar(name, {{ tags: {{}} }})", 'Wood Thrush' if top == 'WOTH' else top)
    page.keyboard.press('Enter'); page.wait_for_timeout(500)
    check(page.locator('.similar-review--groups').is_hidden(), 'group bar steps aside for the member review')
    title = page.locator('.similar-review:not(.similar-review--groups) .similar-review__title').inner_text()
    check(title.startswith('Similar to'), f'member review opens ({title})')
    # Reject the least typical member, copy the rest
    page.keyboard.press('ArrowUp'); page.keyboard.press('x'); page.wait_for_timeout(300)
    page.evaluate("() => { const r = document.querySelector('.similar-review:not(.similar-review--groups) input'); r.value = '0.2'; r.dispatchEvent(new Event('input')); }")
    n = int(page.locator('.similar-review:not(.similar-review--groups) [data-act="all"]').inner_text().split()[-1])
    page.keyboard.press('Shift+Enter'); page.wait_for_timeout(500)
    own = page.evaluate(f"() => {SV}.state.labels.filter(l => l.origin === 'manual')")
    check(len(own) == n and n > 0 and all(l['adoptedFrom']['similar']['group'] == 0 for l in own), f'Shift+Enter copies {n} members with adoptedFrom.similar.group')
    # Member review closes when empty or with Esc → back to the groups, on the next one
    if page.locator('.similar-review:not(.similar-review--groups)').count(): page.keyboard.press('Escape'); page.wait_for_timeout(300)
    check(page.locator('.similar-review--groups').is_visible(), 'group bar comes back')
    pos = page.locator('.similar-review--groups .similar-review__pos').inner_text()
    check(pos.startswith('1 /'), f'named group is done, the next is shown ({pos})')
    # Regrouping with the slider leaves the copied calls out too
    page.evaluate("() => { const r = document.querySelector('.similar-review--groups input'); r.value = '1.2'; r.dispatchEvent(new Event('change')); }")
    page.wait_for_timeout(300)
    left = page.evaluate(f"() => {SV}.groupedCalls()")
    check(left == len(truth) - n, f'slider regroup leaves the copied calls out ({left} of {len(truth)} grouped)')
    page.keyboard.press('Escape'); page.wait_for_timeout(300)
    check(page.evaluate(f"() => !{SV}.state.labels.some(l => l.similar?.preview)"), 'Esc removes the unnamed previews')
    # Regrouping leaves the labelled calls out
    page.evaluate("document.getElementById('birdboxGroupBtn').click()"); page.wait_for_timeout(1500)
    page.wait_for_function(f"{SV}.groupedCalls() !== null", timeout=30000)
    left = page.evaluate(f"() => {SV}.groupedCalls()")
    check(left == len(truth) - n, f'copied calls are not grouped again ({left} of {len(truth)} grouped)')
    # The new run's first group gets fresh ids: copying it works (ids of the first run are in adoptedFrom)
    page.wait_for_selector('.similar-review--groups', state='attached', timeout=30000)
    page.keyboard.press('Enter'); page.wait_for_timeout(500)
    page.evaluate("() => { const r = document.querySelector('.similar-review:not(.similar-review--groups) input'); r.value = '0.2'; r.dispatchEvent(new Event('input')); }")
    m = int(page.locator('.similar-review:not(.similar-review--groups) [data-act="all"]').inner_text().split()[-1])
    page.keyboard.press('Shift+Enter'); page.wait_for_timeout(500)
    own2 = page.evaluate(f"() => {SV}.state.labels.filter(l => l.origin === 'manual').length")
    check(m > 0 and own2 == n + m, f'second grouping: {m} more copied ({own2} own labels)')
    # Opening another file while a named group's member review is open: no overview or previews carried over
    page.evaluate("document.getElementById('birdboxGroupBtn').click()"); page.wait_for_timeout(1500)
    page.wait_for_selector('.similar-review--groups', state='attached', timeout=30000)
    page.keyboard.press('Enter'); page.wait_for_timeout(500)
    first = page.evaluate(f"{SV}.activeRecordingId()")
    import shutil; other = clip[:-4] + '-copy.wav'; shutil.copy(clip, other)
    page.set_input_files('#fileInput', other); page.wait_for_timeout(500)
    if page.locator('.app-modal [data-v="keep"]').count(): page.locator('.app-modal [data-v="keep"]').click()
    page.wait_for_function(f"{SV}.activeRecordingId() !== null && {SV}.activeRecordingId() !== {first!r}", timeout=30000)
    page.wait_for_timeout(800)
    check(page.locator('.similar-review').count() == 0, 'switching file closes the member review and the group overview')
    check(not page.evaluate(f"() => {SV}.state.labels.some(l => l.origin === 'Similar')"), 'switching file: no suggestions or previews in the new recording')
    saved = page.evaluate(f"id => ({SV}.recordings().find(e => e.id === id)?.annotations || []).filter(l => l.origin === 'Similar').length", first)
    check(saved == 0, f'switching file: none saved with the leaving recording ({saved})')
    check(not errs, f'page errors: {errs}')
    b.close()
sys.exit(1 if fails else 0)
