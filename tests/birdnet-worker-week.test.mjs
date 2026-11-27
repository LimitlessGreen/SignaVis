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

test('recording date "YYYY-MM-DD" reaches the worker as that calendar day in every time zone', async () => {
  const { execFileSync } = await import('node:child_process');
  const mod = new URL('../src/infrastructure/birdnetInference.ts', import.meta.url).href;
  // The worker does new Date(date) and reads local month/day.
  const code = `import('${mod}').then((m) => { const d = new Date(m.workerDate('2026-01-01')); process.stdout.write(d.getMonth() + '-' + d.getDate()); })`;
  for (const tz of ['America/Los_Angeles', 'Pacific/Auckland', 'UTC']) {
    const out = execFileSync(process.execPath, [...process.execArgv.filter((a) => !a.startsWith('--test')), '-e', code], { env: { ...process.env, TZ: tz } }).toString();
    assert.equal(out, '0-1', tz);
  }
});
