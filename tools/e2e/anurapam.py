"""AnuraPAM preset: pick it in the model picker, analyse a frog recording, the anuran shows up as labels.
Dev server + `npm run models:fetch -- anurapam` needed:
  uv run --with playwright python -I tools/e2e/anurapam.py http://localhost:5191/demo/labeling-app.html <frog.wav> <species> [screenshot-dir]
  e.g. Bombina_bombina.wav "Bombina bombina" — passes only when that anuran is detected.
"""
import sys
from playwright.sync_api import sync_playwright
url, wav, expected = sys.argv[1], sys.argv[2], sys.argv[3]; shots = sys.argv[4] if len(sys.argv) > 4 else None
with sync_playwright() as p:
    b = p.chromium.launch(args=['--use-gl=swiftshader', '--enable-unsafe-swiftshader'])
    page = b.new_page(viewport={'width': 1400, 'height': 900})
    errs = []; page.on('pageerror', lambda e: errs.append(str(e)))
    page.goto(url, wait_until='networkidle'); page.wait_for_function('window.__signavis')
    page.set_input_files('#fileInput', wav)
    page.wait_for_function("() => window.__signavis.player._state?.audioBuffer", timeout=60000); page.keyboard.press('Escape')
    page.evaluate("() => { const sv = window.__signavis; sv.labelStore.replaceAll([]); sv.syncToPlayer(); }")
    page.evaluate("document.querySelector('#birdnetModelSeg [data-value=anurapam]').click()")
    preset = page.evaluate("document.getElementById('birdnetModelPreset').value")
    model_url = page.evaluate("document.getElementById('birdnetModelUrl').value")
    print('preset:', preset, '| url:', model_url, '| note:', page.inner_text('#birdnetModelNote'))
    if preset != 'anurapam' or 'anurapam' not in model_url:
        sys.exit(f'AnuraPAM preset not selected (preset={preset!r}, url={model_url!r})')
    page.evaluate("() => { const c = document.getElementById('birdnetConfidence'); c.value = '0.3'; c.dispatchEvent(new Event('input')); }")
    if not page.evaluate("() => window.__signavis.birdnetPanel.analyze()"):
        sys.exit('analysis did not start (analyze() returned false)')
    page.wait_for_function("() => /done|error|found|no /i.test(document.getElementById('birdnetStatus').textContent) && !document.getElementById('birdnetAnalyzeBtn').disabled", timeout=600000)
    print('status:', page.inner_text('#birdnetStatus'))
    labels = page.evaluate("() => window.__signavis.state.labels.map(l => [l.scientificName || l.label, +l.confidence.toFixed(2)])")
    from collections import Counter
    print('labels:', Counter(n for n, _ in labels).most_common(5))
    if shots: page.screenshot(path=f'{shots}/anurapam.png')
    print('page errors:', errs)
    b.close()
    found = any(n == expected for n, _ in labels)
    print(f'{expected} detected:', found)
    sys.exit(0 if found and not errs else 1)
