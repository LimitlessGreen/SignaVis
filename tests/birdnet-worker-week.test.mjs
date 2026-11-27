import test from 'node:test';
import assert from 'node:assert/strict';
import { __workerSourcesForTests as src } from '../src/infrastructure/birdnetInference.ts';
import { geoWeek } from '../src/ui/components/geo-season.ts';

// The worker's geoWeek, taken from the source string, must agree with the app's.
function workerGeoWeek(source) {
  const m = source.match(/function geoWeek\(d\) \{[\s\S]*?\n\}/);
  assert.ok(m, 'worker defines geoWeek');
  return new Function(`${m[0]}; return geoWeek;`)();
}

for (const kind of ['tfjs', 'onnx']) {
  test(`${kind} worker: area model week is 1–48 (4 per month), not the ISO week`, () => {
    const s = src[kind];
    assert.doesNotMatch(s, /604800000/, 'no ISO week arithmetic');
    const wk = workerGeoWeek(s);
    for (const d of [new Date(2026, 0, 1), new Date(2026, 4, 20), new Date(2026, 11, 31)]) {
      assert.equal(wk(d), geoWeek(d));
    }
    assert.equal(wk(new Date(2026, 11, 31)), 48);
  });
}
