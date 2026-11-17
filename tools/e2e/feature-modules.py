"""Feature modules split out of main.js (architecture step 4): theme toggle, Raven export, Annota-JSON import.

Dev server needed:  uv run --with playwright python -I tools/e2e/feature-modules.py http://localhost:5191/demo/labeling-app.html <set.json> <not-a-set.json> [clip.wav]
<set.json>: an Annota-JSON set with annotations for XC1159843 (2), XC999 (1, no such recording) and one without
XC number. The demo recording gets XC number 1159843 for the test. Exits non-zero on failure.
"""
import sys
from playwright.sync_api import sync_playwright

url, set_file, bad_file = sys.argv[1:4]
clip = sys.argv[4] if len(sys.argv) > 4 else None
fails = []


def check(name, ok, info=''):
    print(('ok  ' if ok else 'FAIL'), name, info)
    if not ok:
        fails.append(name)


with sync_playwright() as p:
    b = p.chromium.launch()
    ctx = b.new_context(viewport={'width': 1400, 'height': 900}, accept_downloads=True)
    page = ctx.new_page()
    errs = []
    page.on('pageerror', lambda e: errs.append(str(e)))
    page.goto(url, wait_until='networkidle'); page.wait_for_function('window.__signavis')
    page.keyboard.press('Escape')

    # Theme: toggles data-theme and keeps it after a reload
    theme = lambda: page.evaluate("document.documentElement.getAttribute('data-theme')")
    t0 = theme()
    page.click('#themeToggleBtn')
    t1 = theme()
    page.reload(wait_until='networkidle'); page.wait_for_function('window.__signavis')
    check('theme toggles and persists', t0 in ('light', 'dark') and t1 != t0 and theme() == t1,
          f'{t0} → {t1} → after reload {theme()}')
    check('theme button icon', page.evaluate("!!document.querySelector('#themeToggleBtn svg')"))
    page.click('#themeToggleBtn')   # back

    # Demo recording with three labels
    page.keyboard.press('Escape')
    page.evaluate("document.getElementById('loadSampleBtn').click()")
    page.wait_for_function("window.__signavis.activeRecordingId()", timeout=20000); page.wait_for_timeout(1500)
    page.keyboard.press('Escape')
    page.evaluate("""() => { const sv = window.__signavis;
        sv.labelStore.replaceAll([0, 1, 2].map((i) => ({ id: 'r' + i, start: i, end: i + 0.5, freqMin: 1000, freqMax: 4000,
            label: 'Robin', scientificName: 'Erithacus rubecula', origin: 'manual', setId: 'own', tags: {} }))); }""")
    page.wait_for_timeout(300)

    # Raven export of the open recording: a download with a header and one row per label
    with page.expect_download() as dl:
        page.evaluate("window.__signavis.ravenExport.download()")
    path = dl.value.path(); name = dl.value.suggested_filename
    rows = open(path, encoding='utf-8').read().strip().splitlines()
    check('Raven table download', name.endswith('.Table.1.selections.txt') and len(rows) == 4 and rows[0].startswith('Selection'),
          f'{name}, {len(rows)} lines')

    # Annota import: not a set
    page.set_input_files('#importSetInput', bad_file); page.wait_for_timeout(500)
    meta = lambda: page.evaluate("document.getElementById('selectionMeta').textContent")
    check('Annota import rejects non-sets', 'not an Annota-JSON annotation set' in meta(), repr(meta()))

    # Annota import into the open recording (given XC number 1159843), then undo
    page.evaluate("() => { const sv = window.__signavis; sv.mobileApp.h.setRecordingInfo(sv.activeRecordingId(), { xcId: '1159843' }); }")
    page.set_input_files('#importSetInput', set_file); page.wait_for_timeout(800)
    ids = lambda: page.evaluate("window.__signavis.state.labels.map((l) => l.id).sort()")
    after = ids(); m = meta()
    check('Annota import adds labels', after == ['r0', 'r1', 'r2', 'xc1159843_lbl_76352', 'xc1159843_lbl_76353'], str(after))
    check('Annota import message', m.startswith('2 labels imported') and 'no recording for XC999' in m and '1 without XC number skipped' in m, repr(m))
    locked = page.evaluate("[...window.__signavis.state.labelSets.values()].some((s) => s.locked && /Test set/.test(s.name || ''))")
    check('Annota set registered as locked set', locked)
    page.click('.undo-toast__btn'); page.wait_for_timeout(500)
    check('Annota import undo', ids() == ['r0', 'r1', 'r2'] and not page.evaluate("[...window.__signavis.state.labelSets.values()].some((s) => /Test set/.test(s.name || ''))"),
          f'{ids()} · {meta()!r}')

    # Undo keeps sets created after the import
    page.set_input_files('#importSetInput', set_file); page.wait_for_timeout(800)
    page.evaluate("() => { window.__signavis.state.labelSets.set('later', { id: 'later', name: 'Later set' }); }")
    page.click('.undo-toast__btn'); page.wait_for_timeout(500)
    check('Annota undo keeps a set created later', page.evaluate("window.__signavis.state.labelSets.has('later')") and ids() == ['r0', 'r1', 'r2'], str(ids()))
    page.evaluate("() => { window.__signavis.state.labelSets.delete('later'); }")

    # Undo after switching to another recording restores the imported one, leaves the other alone
    if clip:
        a_id = page.evaluate("window.__signavis.activeRecordingId()")
        page.set_input_files('#fileInput', clip)
        for _ in range(20):
            page.wait_for_timeout(500)
            keep = page.locator('[data-v="keep"]')
            if keep.count() and keep.first.is_visible(): keep.first.click()
            if page.evaluate("window.__signavis.recordingCount()") >= 2: break
        page.wait_for_timeout(2500)
        b_id = page.evaluate("window.__signavis.activeRecordingId()")
        page.evaluate("() => window.__signavis.labelStore.replaceAll([{ id: 'b0', start: 1, end: 2, freqMin: 1000, freqMax: 3000, label: 'B', origin: 'manual', setId: 'own', tags: {} }])")
        page.evaluate("(id) => window.__signavis.mobileApp.h.openRecording(id)", a_id); page.wait_for_timeout(2500)
        page.set_input_files('#importSetInput', set_file); page.wait_for_timeout(800)
        page.evaluate("(id) => window.__signavis.mobileApp.h.openRecording(id)", b_id); page.wait_for_timeout(2500)
        page.click('.undo-toast__btn'); page.wait_for_timeout(500)
        stored = page.evaluate("""([a, b]) => { const rs = window.__signavis.recordings();
            const ids = (id) => (id === window.__signavis.activeRecordingId() ? window.__signavis.state.labels : rs.find((e) => e.id === id).annotations).map((l) => l.id).sort();
            return [ids(a), ids(b)]; }""", [a_id, b_id])
        check('Annota undo after a recording switch', stored == [['r0', 'r1', 'r2'], ['b0']], str(stored))

    check('page errors', not errs, str(errs))
    b.close()

sys.exit(1 if fails else 0)
