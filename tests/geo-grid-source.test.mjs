import test from 'node:test';
import assert from 'node:assert/strict';
import { geoTrunkFor } from '../src/infrastructure/geo/geoGrid.ts';

test('trunk folder next to the audio model folder, labels from the model folder', () => {
  assert.deepEqual(geoTrunkFor('https://x.org/SignaVis/models/birdnet-v3.0/', 'G.txt'),
    { base: 'https://x.org/SignaVis/models/geo-trunk-v3.0/', labelsUrl: 'https://x.org/SignaVis/models/birdnet-v3.0/G.txt' });
  assert.deepEqual(geoTrunkFor('http://localhost/models/birdnet-v3.0', 'G.txt')?.base, 'http://localhost/models/geo-trunk-v3.0/');
});

test('no trunk for other models or without a geomodel', () => {
  assert.equal(geoTrunkFor('https://x.org/models/birdnet-v2.4/', 'G.txt'), null);
  assert.equal(geoTrunkFor('https://x.org/models/birdnet-v3.0/', null), null);
});
