"""Xeno-canto export & upload (features/xc-upload.ts): summary + checklist, selection, export modal,
download, upload (stubbed, nothing leaves the machine) with success dialog and "uploaded sets" entry.

Dev server needed:  uv run --with playwright python -I tools/e2e/xc-upload.py http://localhost:5191/demo/labeling-app.html
Exits non-zero on failure.
"""
import json
import sys
from playwright.sync_api import sync_playwright

url = sys.argv[1]
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

    # Demo recording as XC1159843 with two own labels
    page.click('#helpMenuBtn'); page.click('.ctx-item:has-text("Load demo recording")')
    page.wait_for_function('window.__signavis.recordingCount() === 1 && window.__signavis.player.duration > 0', timeout=20000)
    page.evaluate("""() => { const sv = window.__signavis;
      sv.mobileApp.h.setRecordingInfo(sv.activeRecordingId(), { xcId: '1159843' });
      sv.labelStore.replaceAll([
        { id: 'u1', start: 1, end: 2, freqMin: 2000, freqMax: 6000, label: 'Wood Thrush', scientificName: 'Hylocichla mustelina', origin: 'manual', setId: 'own', tags: {} },
        { id: 'u2', start: 3, end: 4, freqMin: 2000, freqMax: 6000, label: 'Wood Thrush', scientificName: 'Hylocichla mustelina', origin: 'manual', setId: 'own', tags: {} },
      ]); sv.syncToPlayer(); }""")

    page.click('.activity-btn[data-panel="upload"]')
    page.wait_for_timeout(500)
    summary = page.inner_text('#xcUploadSummary')
    check('summary counts recording and labels', '1 recording' in summary and '2 labels' in summary, summary)
    check('checklist rendered', page.evaluate("document.querySelectorAll('#xcChecklist *').length > 0"))
    check('selection panel rendered', page.evaluate("document.querySelectorAll('#xcSelection .us-row').length > 0"))
    reason = page.evaluate("window.__signavis.xcUpload.blockReason()")
    check('block reason without API key / profile', reason.startswith('Fix first:'), reason)

    # Export modal shows the payload with both labels
    page.click('#xcExportSetBtn')
    pre = page.inner_text('#xcExportJsonPre')
    check('export modal shows payload', '1159843' in pre and 'u1' in pre and 'u2' in pre, pre[:120].replace('\n', ' '))
    page.keyboard.press('Escape')
    page.evaluate("document.querySelector('.xc-nokey-backdrop').hidden = true")

    # Download file
    with page.expect_download() as dl:
        page.click('#xcDownloadSetBtn')
    data = json.loads(open(dl.value.path()).read())
    check('download is the set payload', '1159843' in json.dumps(data) and 'u1' in json.dumps(data), dl.value.suggested_filename)

    # Upload (stubbed): success dialog, set remembered under "uploaded sets"
    page.evaluate("""() => { const x = window.__signavis.xcPanel; window.__sent = null;
      x.uploadToXenoCanto = async (labels) => { window.__sent = labels.map((l) => l.id); return { ok: true, message: 'Set created' }; }; }""")
    page.evaluate("() => { const b = document.getElementById('xcUploadBtn'); b.disabled = false; b.click(); }")
    page.wait_for_selector('.upl-backdrop', timeout=5000)
    check('upload sent both labels', page.evaluate('window.__sent') == ['u1', 'u2'], str(page.evaluate('window.__sent')))
    check('uploaded set listed', page.evaluate("window.__signavis.state.labelSets.get('own')?.uploads?.length") == 1
          and page.evaluate("document.querySelectorAll('#xcUploads .us-snap-title').length") == 1)
    check('no page errors', not errs, '; '.join(errs))
    b.close()

sys.exit(1 if fails else 0)
