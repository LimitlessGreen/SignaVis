"""Label template: species + tags in the top bar go onto every new label; Alt opens the dialog.
Dev server needed:  uv run --with playwright python -I tools/e2e/label-template.py http://localhost:5191/demo/labeling-app.html [screenshot-dir]
"""
import sys
from playwright.sync_api import sync_playwright
url = sys.argv[1]; shots = sys.argv[2] if len(sys.argv) > 2 else None
OWN = "() => window.__signavis.state.labels.filter(l => l.origin === 'manual').map(l => ({ label: l.label, tags: l.tags }))"
with sync_playwright() as p:
    b = p.chromium.launch(); page = b.new_page(viewport={'width': 1400, 'height': 900})
    errs = []; page.on('pageerror', lambda e: errs.append(str(e)))
    page.goto(url, wait_until='networkidle'); page.wait_for_function('window.__signavis')
    page.evaluate("document.getElementById('loadSampleBtn')?.click()"); page.wait_for_timeout(3500); page.keyboard.press('Escape')
    page.evaluate("() => { const sv = window.__signavis; sv.state.labels = []; sv.syncToPlayer(); }")
    box = page.evaluate("() => { const r = window.__signavis.player.spectrogramLabels.overlay.parentElement.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; }")
    def draw(x0, alt=False):
        y = box['y'] + box['height'] * 0.3
        page.keyboard.down('Shift'); page.mouse.move(box['x'] + x0, y); page.mouse.down()
        page.mouse.move(box['x'] + x0 + 60, y + 80, steps=6)
        if alt: page.keyboard.down('Alt')
        page.mouse.up(); page.keyboard.up('Shift')
        if alt: page.keyboard.up('Alt')
        page.wait_for_timeout(300)

    # 1. species via the search field, tags via the chip
    page.fill('.species-search .species-search-input', 'Chaffinch'); page.keyboard.press('Enter')
    page.click('.template-tags-btn')
    sel = page.locator('.template-tags-pop select')
    names = page.locator('.template-tags-row span').all_text_contents()
    for i, n in enumerate(names):
        sel.nth(i).select_option(index=1)
    if shots: page.screenshot(path=f'{shots}/template-popover.png', clip={'x': 250, 'y': 0, 'width': 900, 'height': 220})
    page.keyboard.press('Escape')
    print('chip:', page.inner_text('.template-tags-btn'))
    draw(120); draw(260)
    print('two boxes, no dialog:', page.evaluate(OWN), '| dialog open:', page.locator('.label-name-editor').count())

    # 2. Alt → dialog, pre-filled from the template; "Keep for next labels" with other tags
    draw(400, alt=True)
    print('Alt: dialog open:', page.locator('.label-name-editor').count(), '| value:', page.input_value('.label-search-input'))
    if shots: page.screenshot(path=f'{shots}/template-dialog.png')
    page.fill('.label-search-input', 'Blackbird'); page.check('.label-search-keep input'); page.click('.label-search-confirm')
    page.wait_for_timeout(300)
    print('after keep: bar =', page.input_value('.species-search .species-search-input'), '| chip:', page.inner_text('.template-tags-btn'))
    draw(540)
    print('labels:', page.evaluate(OWN))

    # 3. clear the species: tags stay, the dialog opens with them
    page.evaluate("() => window.__signavis.player.setSpeciesBar('')")
    draw(680)
    print('no species: dialog open:', page.locator('.label-name-editor').count(), '| chip:', page.inner_text('.template-tags-btn'))
    page.keyboard.press('Escape')

    # 4. context menu → Use as template
    page.evaluate("() => window.__signavis.player.setTemplateTags({})")
    page.locator('.spectrogram-label-region').first.click(button='right'); page.wait_for_timeout(200)
    page.get_by_text('Use as template').click(); page.wait_for_timeout(200)
    print('use as template: bar =', page.input_value('.species-search .species-search-input'), '| chip:', page.inner_text('.template-tags-btn'))
    if shots: page.screenshot(path=f'{shots}/template-final.png')
    print('page errors:', errs)
    b.close()
