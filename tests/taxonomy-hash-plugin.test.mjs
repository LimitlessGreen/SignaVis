// Regression: the labeling app fetches the taxonomy from JS (main.js), so the
// hash plugin must rewrite JS chunks, not just HTML — otherwise production 404s.
import test from 'node:test';
import assert from 'node:assert/strict';
import { taxonomyHashPlugin } from '../demo/vite.demo.config.js';

test('taxonomy hash plugin rewrites the fetch URL in JS chunks', (t) => {
  const plugin = taxonomyHashPlugin();
  plugin.configResolved({ command: 'build' });
  plugin.buildStart();
  const out = plugin.renderChunk("fetch('./data/birdnet-taxonomy.v2.4.json')");
  if (out === null) { t.skip('taxonomy JSON not built locally'); return; }
  assert.match(out.code, /birdnet-taxonomy\.v2\.4\.[0-9a-f]{8}\.json/);
  assert.equal(plugin.renderChunk('const x = 1;'), null);
});
