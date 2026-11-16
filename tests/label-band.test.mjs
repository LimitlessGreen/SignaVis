import test from 'node:test';
import assert from 'node:assert/strict';
import { labelPlaybackBand } from '../src/domain/labelBand.ts';

test('label with a frequency range is bandpassed', () => {
  assert.deepEqual(labelPlaybackBand({ freqMin: 2000, freqMax: 6000 }), { lo: 2000, hi: 6000 });
});

test('full-band label is not bandpassed although normalization gave it bounds', () => {
  assert.equal(labelPlaybackBand({ freqMin: 0, freqMax: 16000, fullBand: true }), null);
});

test('label without bounds or with an empty range is not bandpassed', () => {
  assert.equal(labelPlaybackBand({}), null);
  assert.equal(labelPlaybackBand({ freqMin: 3000, freqMax: 3000 }), null);
});
