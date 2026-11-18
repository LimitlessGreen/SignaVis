"""Drag & drop and microphone recording (features/file-drop.ts, features/mic-recording.ts).

Dev server needed:  uv run --with playwright python -I tools/e2e/drop-and-record.py http://localhost:5191/demo/labeling-app.html <clip.wav>
Chromium runs with a fake microphone; the second load answers the replace-or-keep question with "Keep both". Exits non-zero on failure.
"""
import base64
import sys
from playwright.sync_api import sync_playwright

url, clip = sys.argv[1:3]
fails = []


def check(name, ok, info=''):
    print(('ok  ' if ok else 'FAIL'), name, info)
    if not ok:
        fails.append(name)


DROP = """async ([b64, name, type]) => {
  const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  const dt = new DataTransfer();
  dt.items.add(new File([bytes], name, { type }));
  for (const t of ['dragenter', 'dragover']) window.dispatchEvent(new DragEvent(t, { dataTransfer: dt, bubbles: true, cancelable: true }));
  await new Promise((r) => setTimeout(r, 100));
  const shown = document.querySelector('.file-drop-overlay').matches(':popover-open');
  window.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
  return shown;
}"""

with sync_playwright() as p:
    b = p.chromium.launch(args=['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'])
    ctx = b.new_context(viewport={'width': 1400, 'height': 900})
    ctx.grant_permissions(['microphone'])
    page = ctx.new_page()
    errs = []
    page.on('pageerror', lambda e: errs.append(str(e)))
    page.goto(url, wait_until='networkidle'); page.wait_for_function('window.__signavis')
    page.keyboard.press('Escape')
    n_rec = lambda: page.evaluate('window.__signavis.recordingCount()')
    file_label = lambda: page.evaluate("document.getElementById('fileLabel')?.textContent || ''")

    # Drop of a non-audio file: error, nothing loaded
    n0 = n_rec()
    page.evaluate(DROP, [base64.b64encode(b'hello').decode(), 'notes.txt', 'text/plain'])
    page.wait_for_timeout(300)
    check('non-audio drop rejected', n_rec() == n0 and page.evaluate("document.body.innerText.includes('is not an audio file')"))
    page.keyboard.press('Escape')

    # Drop of an audio file: overlay shown, then hidden, recording added
    data = base64.b64encode(open(clip, 'rb').read()).decode()
    shown = page.evaluate(DROP, [data, 'dropped.wav', 'audio/wav'])
    page.wait_for_function(f'window.__signavis.recordingCount() > {n0}', timeout=15000)
    check('overlay while dragging', shown)
    check('overlay hidden after drop', not page.evaluate("document.querySelector('.file-drop-overlay').matches(':popover-open')"))
    check('dropped file opened', file_label() == 'dropped.wav', file_label())

    # Microphone: button visible, record ~2 s, stop → new recording opened
    btn = page.locator('#recordBtn')
    check('record button visible', btn.is_visible())
    n1 = n_rec()
    btn.click()
    page.wait_for_timeout(500)
    check('recording state', 'is-recording' in (btn.get_attribute('class') or '') and btn.inner_text().strip() == 'Stop', btn.inner_text())
    page.wait_for_timeout(1500)
    btn.click()
    # A recording is open already: the app asks replace or keep → keep both
    page.click('.app-modal button[data-v="keep"]', timeout=10000)
    try:
        page.wait_for_function(f'window.__signavis.recordingCount() > {n1}', timeout=15000)
        added = True
    except Exception:
        added = False
    check('recording opened as new entry', added and file_label().startswith('Recording_'), file_label())
    check('button back to Record', 'is-recording' not in (btn.get_attribute('class') or '') and btn.inner_text().strip() == 'Record')
    check('no page errors', not errs, '; '.join(errs))
    b.close()

sys.exit(1 if fails else 0)
