// Regression: the labeling app fetches the taxonomy from JS (main.js), so the
// hash plugin must rewrite JS chunks, not just HTML — otherwise production 404s.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { taxonomyHashPlugin } from '../demo/vite.demo.config.js';

test('taxonomy hash plugin rewrites the fetch URL in JS chunks', () => {
  const src = join(mkdtempSync(join(tmpdir(), 'taxonomy-')), 'birdnet-taxonomy.json');
  writeFileSync(src, '{"records":[]}');
  const plugin = taxonomyHashPlugin(src);
  plugin.configResolved({ command: 'build' });
  plugin.buildStart();
  const out = plugin.renderChunk("fetch('./data/birdnet-taxonomy.json')");
  assert.ok(out, 'renderChunk must rewrite chunks that reference the taxonomy');
  assert.match(out.code, /birdnet-taxonomy\.[0-9a-f]{8}\.json/);
  assert.equal(plugin.renderChunk('const x = 1;'), null);
});
