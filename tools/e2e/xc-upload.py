"""Xeno-canto export & upload (features/xc-upload.ts): summary + checklist, selection, export modal,
download, upload (stubbed, nothing leaves the machine) through the real button with success dialog and
"uploaded sets" entry; one upload at a time, snapshot = what was sent, accepted upload stays a success
when saving it locally fails. The profile is set before loading, so neither onboarding nor the project-folder hint opens.

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
    # Profile done before the app starts: no onboarding dialog, the checklist only misses the API key
    page.add_init_script("""localStorage.setItem('aw:annotator-profile.v1',
      JSON.stringify({ name: 'E2E Tester', xcUsername: 'e2e', onboardingDone: true }));
      sessionStorage.setItem('signavis.project-folder-hint.dismissed.v1', '1');""")
    page.goto(url, wait_until='networkidle'); page.wait_for_function('window.__signavis')

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
    check('block reason without API key', reason.startswith('Fix first:') and 'API key' in reason, reason)
    check('upload button disabled without key', page.is_disabled('#xcUploadBtn'))

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
    pairs = sorted((a.get('annotation_source_id'), str(a.get('xc_nr'))) for a in data.get('annotations', []))
    check('download holds both labels', pairs == [('u1', '1159843'), ('u2', '1159843')], str(pairs))

    # Upload (stubbed, answers when told to) through the real button once a key is set
    page.evaluate("""() => { const x = window.__signavis.xcPanel; window.__calls = [];
      x.uploadToXenoCanto = (labels) => new Promise((resolve) => {
        window.__calls.push(labels.map((l) => l.id));
        window.__answer = () => resolve({ ok: true, message: 'Set created' });
      });
      x.setApiKey('e2e-dummy-key'); }""")
    page.wait_for_selector('#xcUploadBtn:not([disabled])', timeout=5000)
    check('block reason gone with key', page.evaluate("window.__signavis.xcUpload.blockReason()") == '')
    page.click('#xcUploadBtn')
    page.wait_for_function('window.__calls.length === 1')
    # While it runs, a refresh (set still valid) must not enable the button again
    page.evaluate('window.__signavis.xcUpload.refresh()')
    check('button stays disabled while uploading', page.is_disabled('#xcUploadBtn'))
    # The selection changes (recording unticked) and both entry points are tried again
    page.click('#xcSelection .us-row input[type=checkbox]')
    page.wait_for_timeout(300)
    page.evaluate("document.getElementById('xcUploadBtn').click()")
    page.click('#xcExportSetBtn'); page.click('#xcExportUploadBtn')
    page.wait_for_timeout(300)
    check('only one request at a time', page.evaluate('window.__calls.length') == 1, str(page.evaluate('window.__calls')))
    check('modal says an upload is running', 'already running' in page.inner_text('#xcExportModalStatus'), page.inner_text('#xcExportModalStatus'))
    page.evaluate("document.querySelector('.xc-nokey-backdrop').hidden = true")
    page.evaluate('window.__answer()')
    page.wait_for_selector('.upl-backdrop', timeout=5000)
    check('upload sent both labels', page.evaluate('window.__calls[0]') == ['u1', 'u2'], str(page.evaluate('window.__calls')))
    snap = page.evaluate("window.__signavis.state.labelSets.get('own')?.uploads?.map((u) => u.labelIds)")
    check('snapshot = what was sent, not the later selection', snap == [['u1', 'u2']], str(snap))
    check('uploaded set listed', page.evaluate("document.querySelectorAll('#xcUploads .us-snap-title').length") == 1)
    page.evaluate("document.querySelectorAll('.upl-backdrop').forEach((b) => b.remove())")

    # Accepted upload while saving locally fails: still a success (dialog), the local error is shown
    page.click('#xcSelection .us-row input[type=checkbox]')   # tick the recording again
    page.evaluate("""() => { const x = window.__signavis.xcPanel;
      x.uploadToXenoCanto = async () => ({ ok: true, message: 'Set created' });
      const own = window.__signavis.state.labelSets.get('own'); const keep = own.uploads;
      Object.defineProperty(own, 'uploads', { configurable: true, get: () => keep,
        set: () => { throw new Error('quota exceeded'); } });
      window.__restore = () => { delete own.uploads; own.uploads = keep; }; }""")
    page.wait_for_selector('#xcUploadBtn:not([disabled])', timeout=5000)
    page.click('#xcUploadBtn')
    try:
        page.wait_for_selector('.upl-backdrop', timeout=5000)
        dialog = True
    except Exception:
        dialog = False
    page.evaluate('window.__restore()')
    status = page.evaluate("document.querySelector('.xc-status')?.textContent || ''")
    check('accepted upload still a success when local save throws', dialog and 'saving that locally failed' in status, status)
    check('no page errors', not errs, '; '.join(errs))
    b.close()

sys.exit(1 if fails else 0)
