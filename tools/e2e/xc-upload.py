"""Xeno-canto export & upload (features/xc-upload.ts): summary + checklist, selection, export modal,
download, upload (stubbed, nothing leaves the machine) through the real button with success dialog and
"uploaded sets" entry; one upload at a time, snapshot = what went out (deduped, timed labels), none for a replaced own set,
accepted upload stays a success when saving it locally or the final panel update fails. The profile is set before loading, so neither onboarding nor the project-folder hint opens.

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


def close_export(page):
    """Close the export modal through its close button (removes its key handler)."""
    page.click('#xcExportModal .modal-close')
    page.wait_for_selector('#xcExportModal', state='hidden', timeout=5000)


def close_success(page):
    """Close the success dialog through its own button (runs its close callback)."""
    page.click('.upl-backdrop .upl-close')
    page.wait_for_selector('.upl-backdrop', state='detached', timeout=5000)


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
    close_export(page)

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
    # A label without an end: the payload leaves it out, so must the upload record
    page.evaluate("""() => { const sv = window.__signavis;
      sv.labelStore.add({ id: 'u3', start: 5, end: null, label: 'Wood Thrush', scientificName: 'Hylocichla mustelina', origin: 'manual', setId: 'own', tags: {} }); }""")
    page.click('#xcUploadBtn')
    page.wait_for_function('window.__calls.length === 1')
    # While it runs, a refresh or a direct panel update (e.g. an XC import finishing) must not
    # enable the button again while the set is still valid
    page.evaluate('window.__signavis.xcUpload.refresh()')
    check('button stays disabled while uploading (refresh)', page.is_disabled('#xcUploadBtn'))
    page.evaluate('window.__signavis.xcPanel._updateUploadState()')
    check('button stays disabled while uploading (panel update)', page.is_disabled('#xcUploadBtn'))
    # The selection changes (recording unticked) and both entry points are tried again
    page.click('#xcSelection .us-row input[type=checkbox]')
    page.wait_for_function('window.__signavis.xcUpload.collectSetLabels().length === 0', timeout=5000)
    page.evaluate("document.getElementById('xcUploadBtn').click()")
    page.click('#xcExportSetBtn'); page.click('#xcExportUploadBtn')
    page.wait_for_timeout(300)
    check('only one request at a time', page.evaluate('window.__calls.length') == 1, str(page.evaluate('window.__calls')))
    check('modal says an upload is running', 'already running' in page.inner_text('#xcExportModalStatus'), page.inner_text('#xcExportModalStatus'))
    close_export(page)
    page.evaluate('window.__answer()')
    page.wait_for_selector('.upl-backdrop', timeout=5000)
    check('upload got all three labels', page.evaluate('window.__calls[0]') == ['u1', 'u2', 'u3'], str(page.evaluate('window.__calls')))
    snap = page.evaluate("window.__signavis.state.labelSets.get('own')?.uploads?.map((u) => u.labelIds)")
    check('snapshot = what went out (no u3), not the later selection', snap == [['u1', 'u2']], str(snap))
    check('success dialog counts what went out', '2 labels' in page.inner_text('.upl-backdrop'), page.inner_text('.upl-backdrop')[:80].replace('\n', ' '))
    check('uploaded set listed', page.evaluate("document.querySelectorAll('#xcUploads .us-snap-title').length") == 1)
    close_success(page)
    page.evaluate("window.__signavis.labelStore.remove('u3')")
    page.click('#xcSelection .us-row input[type=checkbox]')   # tick the recording again
    page.wait_for_function('window.__signavis.xcUpload.collectSetLabels().length === 2', timeout=5000)

    # The own set is replaced (new session) while the request runs: the old upload is not recorded there
    page.evaluate("""() => { const sv = window.__signavis; const x = sv.xcPanel;
      x.uploadToXenoCanto = () => new Promise((resolve) => { window.__answer = () => resolve({ ok: true, message: 'Set created' }); });
      window.__oldOwn = sv.state.labelSets.get('own'); }""")
    page.wait_for_selector('#xcUploadBtn:not([disabled])', timeout=5000)
    page.click('#xcUploadBtn')
    page.wait_for_function('typeof window.__answer === "function"')
    page.evaluate("""() => { const sets = window.__signavis.state.labelSets;
      sets.set('own', { ...window.__oldOwn, name: 'Other set', uploads: [] }); window.__answer(); }""")
    page.wait_for_selector('.upl-backdrop', timeout=5000)
    check('replaced own set gets no upload record', page.evaluate("window.__signavis.state.labelSets.get('own').uploads.length") == 0)
    dlg = page.inner_text('.upl-backdrop')
    check('dialog names the set that was sent', "E2E Tester's Annotations" in dlg and 'Other set' not in dlg, dlg[:90].replace('\n', ' '))
    close_success(page)
    page.evaluate("() => { window.__signavis.state.labelSets.set('own', window.__oldOwn); window.__signavis.xcUpload.refresh(); }")

    # Accepted upload, then the final panel update throws: still a success with the error shown
    page.evaluate("""() => { const x = window.__signavis.xcPanel; const upd = x._updateUploadState;
      window.__restoreUpd = () => { x._updateUploadState = upd; };
      x.uploadToXenoCanto = async () => { x._updateUploadState = () => { throw new Error('panel broke'); }; return { ok: true, message: 'Set created' }; }; }""")
    page.wait_for_selector('#xcUploadBtn:not([disabled])', timeout=5000)
    page.click('#xcUploadBtn')
    try:
        page.wait_for_selector('.upl-backdrop', timeout=5000)
        dialog = True
    except Exception:
        dialog = False
    status = page.evaluate("document.querySelector('.xc-status')?.textContent || ''")
    check('accepted upload still a success when the panel update throws', dialog and 'updating the panel failed' in status, status)
    # The panel update still throws: the button must not stay stuck from the finished upload
    check('button usable again although the panel update fails', not page.is_disabled('#xcUploadBtn')
          and 'running' not in (page.get_attribute('#xcUploadBtn', 'title') or ''), page.get_attribute('#xcUploadBtn', 'title'))
    page.evaluate('window.__restoreUpd()')
    close_success(page)
    page.evaluate('window.__signavis.xcUpload.refresh()')

    # Accepted upload, then redrawing the panel throws (caught inside refresh): reported, still a success
    page.evaluate("""() => { const x = window.__signavis.xcPanel; const build = x.buildAnnotationSetPayload;
      window.__restoreBuild = () => { x.buildAnnotationSetPayload = build; };
      x.uploadToXenoCanto = async () => { x.buildAnnotationSetPayload = () => { throw new Error('render broke'); }; return { ok: true, message: 'Set created' }; }; }""")
    page.wait_for_selector('#xcUploadBtn:not([disabled])', timeout=5000)
    page.click('#xcUploadBtn')
    try:
        page.wait_for_selector('.upl-backdrop', timeout=5000)
        dialog = True
    except Exception:
        dialog = False
    page.evaluate('window.__restoreBuild()')
    status = page.evaluate("document.querySelector('.xc-status')?.textContent || ''")
    check('accepted upload reports a failed redraw', dialog and 'render broke' in status, status)
    close_success(page)
    page.evaluate('window.__signavis.xcUpload.refresh()')

    # Accepted upload, then only drawing fails (the selection list cannot be written): reported, the
    # check itself still passes, so the button is usable
    page.evaluate("""() => { const x = window.__signavis.xcPanel; const list = document.getElementById('xcSelection');
      window.__restoreDraw = () => { delete list.innerHTML; };
      x.uploadToXenoCanto = async () => { Object.defineProperty(list, 'innerHTML', { configurable: true,
        set: () => { throw new Error('draw broke'); } }); return { ok: true, message: 'Set created' }; }; }""")
    page.wait_for_selector('#xcUploadBtn:not([disabled])', timeout=5000)
    page.click('#xcUploadBtn')
    page.wait_for_selector('.upl-backdrop', timeout=5000)
    status = page.evaluate("document.querySelector('.xc-status')?.textContent || ''")
    check('drawing error after an accepted upload is reported', 'draw broke' in status, status)
    check('drawing error does not block the next upload', page.evaluate('window.__signavis.xcUpload.blockReason()') == ''
          and not page.is_disabled('#xcUploadBtn'))
    page.evaluate('window.__restoreDraw()')
    close_success(page)
    page.evaluate('window.__signavis.xcUpload.refresh()')

    # Only recording unticked during the upload, and the check after it fails: the old "ready"
    # result must not enable the button
    page.evaluate("""() => { const x = window.__signavis.xcPanel; const build = x.buildAnnotationSetPayload;
      window.__restoreBuild = () => { x.buildAnnotationSetPayload = build; };
      x.uploadToXenoCanto = () => new Promise((resolve) => { window.__answer = () => {
        x.buildAnnotationSetPayload = () => { throw new Error('check broke'); };
        resolve({ ok: true, message: 'Set created' }); }; }); }""")
    page.wait_for_selector('#xcUploadBtn:not([disabled])', timeout=5000)
    page.click('#xcUploadBtn')
    page.wait_for_function('typeof window.__answer === "function"')
    page.click('#xcSelection .us-row input[type=checkbox]')
    page.wait_for_function('window.__signavis.xcUpload.collectSetLabels().length === 0', timeout=5000)
    page.evaluate('window.__answer()')
    page.wait_for_selector('.upl-backdrop', timeout=5000)
    check('failed check keeps the button blocked', page.is_disabled('#xcUploadBtn')
          and 'could not be checked' in page.evaluate('window.__signavis.xcUpload.blockReason()'),
          page.evaluate('window.__signavis.xcUpload.blockReason()'))
    check('summary says the check could not run, checklist marked outdated',
          'could not be checked' in page.inner_text('#xcUploadSummary')
          and page.is_visible('.ua-stale-note') and 'outdated' in page.inner_text('.ua-stale-note'),
          page.inner_text('#xcUploadSummary'))
    # The export modal's own upload button only looks at the key: the upload must still send nothing
    page.evaluate("() => { window.__calls = []; window.__signavis.xcPanel.uploadToXenoCanto = async (l) => { window.__calls.push(l.length); return { ok: true }; }; }")
    close_success(page)
    page.click('#xcExportSetBtn')
    page.click('#xcExportUploadBtn')
    page.wait_for_timeout(300)
    check('no request while the set cannot be checked', page.evaluate('window.__calls.length') == 0
          and 'could not be checked' in page.inner_text('#xcExportModalStatus'), page.inner_text('#xcExportModalStatus'))
    close_export(page)
    page.evaluate('window.__restoreBuild()')
    page.click('#xcSelection .us-row input[type=checkbox]')   # tick the recording again
    page.wait_for_selector('#xcUploadBtn:not([disabled])', timeout=5000)
    check('a successful check unblocks it again', page.evaluate('window.__signavis.xcUpload.blockReason()') == ''
          and not page.is_visible('.ua-stale-note'))

    # The check throws an empty value and drawing fails in the same refresh: still blocked, and the
    # outdated note is shown although the selection list could not be drawn
    page.evaluate("""() => { const x = window.__signavis.xcPanel; const build = x.buildAnnotationSetPayload;
      const list = document.getElementById('xcSelection');
      x.buildAnnotationSetPayload = () => { throw ''; };
      window.__drawTries = 0;
      Object.defineProperty(list, 'innerHTML', { configurable: true, set: () => { window.__drawTries++; throw new Error('draw broke'); } });
      window.__restoreBoth = () => { x.buildAnnotationSetPayload = build; delete list.innerHTML; };
      window.__signavis.xcUpload.refresh(); }""")
    reason = page.evaluate('window.__signavis.xcUpload.blockReason()')
    check('empty thrown value still blocks', page.is_disabled('#xcUploadBtn') and 'could not be checked' in reason, reason)
    check('drawing was attempted (and failed) in that refresh', page.evaluate('window.__drawTries') > 0, str(page.evaluate('window.__drawTries')))
    check('outdated note shown although drawing failed', page.is_visible('.ua-stale-note'), page.inner_text('#xcUploadSummary'))
    page.evaluate('() => { window.__restoreBoth(); window.__signavis.xcUpload.refresh(); }')
    page.wait_for_selector('#xcUploadBtn:not([disabled])', timeout=5000)

    # Accepted upload, then the final check throws an empty value: reported as a local warning
    page.evaluate("""() => { const x = window.__signavis.xcPanel; const build = x.buildAnnotationSetPayload;
      window.__restoreBuild = () => { x.buildAnnotationSetPayload = build; };
      x.uploadToXenoCanto = async () => { x.buildAnnotationSetPayload = () => { throw ''; }; return { ok: true, message: 'Set created' }; }; }""")
    page.click('#xcUploadBtn')
    page.wait_for_selector('.upl-backdrop', timeout=5000)
    status = page.evaluate("document.querySelector('.xc-status')?.textContent || ''")
    check('empty check failure after an accepted upload is reported', 'unknown error' in status, status)
    page.evaluate('window.__restoreBuild()')
    close_success(page)
    page.evaluate('window.__signavis.xcUpload.refresh()')
    page.wait_for_selector('#xcUploadBtn:not([disabled])', timeout=5000)

    # Set name left empty: the real upload code (only fetch stubbed) sends a dated name, the dialog shows it
    page.evaluate("""() => { const sv = window.__signavis; const x = sv.xcPanel;
      delete x.uploadToXenoCanto;   // back to XenoCantoPanel.prototype.uploadToXenoCanto
      window.__realFetch = window.fetch; window.__sentNames = [];
      window.fetch = async (url, init) => {
        if (init?.method === 'POST') { window.__sentNames.push(JSON.parse(init.body).set_name);
          return new Response(JSON.stringify('Successfully uploaded'), { status: 200, headers: { 'Content-Type': 'application/json' } }); }
        return window.__realFetch(url, init); };
      sv.state.labelSets.get('own').name = ''; sv.xcUpload.refresh(); }""")
    page.wait_for_selector('#xcUploadBtn:not([disabled])', timeout=5000)
    page.click('#xcUploadBtn')
    page.wait_for_selector('.upl-backdrop', timeout=5000)
    sent_names = page.evaluate('window.__sentNames')
    dlg = page.inner_text('.upl-backdrop')
    check('empty set name: dialog shows the dated name that was sent',
          len(sent_names) == 1 and sent_names[0].startswith('SignaVis annotations') and sent_names[0] in dlg,
          f'{sent_names} | {dlg[:100]!r}')
    snap_name = page.evaluate("window.__signavis.state.labelSets.get('own').uploads.at(-1).name")
    check('upload record keeps the name that was sent', bool(sent_names) and snap_name == sent_names[0], snap_name)
    page.evaluate("() => { window.fetch = window.__realFetch; window.__signavis.state.labelSets.get('own').name = \"E2E Tester's Annotations\"; }")
    close_success(page)

    # Accepted upload while saving locally fails: still a success (dialog), the local error is shown
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
