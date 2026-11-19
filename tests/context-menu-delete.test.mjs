// Regression: deleting via context menu must go through the layer event so the
// player's linked-label state drops the label (otherwise the next X-delete revived it).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('../src/app/labeling/main.js', import.meta.url), 'utf8');

test('context-menu delete does not bypass the layer with player._emit', () => {
  assert.doesNotMatch(src, /_emit\?\.\(\s*'(spectrogramlabelremove|annotationremove)'/);
  assert.match(src, /spectrogramLabels\?\.dispatchEvent\(new CustomEvent\('spectrogramlabelremove'/);
  assert.match(src, /annotations\?\.dispatchEvent\(new CustomEvent\('annotationremove'/);
});
