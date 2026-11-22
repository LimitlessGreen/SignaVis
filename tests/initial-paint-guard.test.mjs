import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// App CSS arrives via the module script and phones switch to html.is-mobile only
// after boot. Until then the page must stay hidden, otherwise raw markup (e.g. a
// full-width sponsor heart SVG) or the desktop shell flashes on load.
const html = readFileSync(new URL('../demo/labeling-app.html', import.meta.url), 'utf8');
const main = readFileSync(new URL('../src/app/labeling/main.js', import.meta.url), 'utf8');

test('labeling app hides body while booting, with a safety timeout', () => {
  const head = html.slice(0, html.indexOf('</head>'));
  assert.match(head, /html\.sv-booting body\s*\{\s*visibility:\s*hidden/);
  assert.match(head, /classList\.add\('sv-booting'\)/);
  assert.match(head, /setTimeout\(.*classList\.remove\('sv-booting'\)/);
});

test('main.js reveals the page only after the mobile shell is set up', () => {
  const mobile = main.indexOf('new MobileApp(');
  const reveal = main.indexOf("classList.remove('sv-booting')");
  assert.ok(mobile > 0 && reveal > mobile);
});

test('sponsor heart SVG has intrinsic size as unstyled fallback', () => {
  assert.match(html, /<svg class="heart"[^>]*width="\d+"[^>]*height="\d+"/);
});
