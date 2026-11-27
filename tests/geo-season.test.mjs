import test from 'node:test';
import assert from 'node:assert/strict';
import { geoWeek, summarizeSeason, presentText, seasonChartSvg, weekLabel, unusualHintText, GEOMODEL_SOURCE } from '../src/ui/components/geo-season.ts';

test('geoWeek: four weeks per month, days 22–31 are week 4', () => {
  assert.equal(geoWeek(new Date(2026, 0, 1)), 1);
  assert.equal(geoWeek(new Date(2026, 0, 8)), 2);
  assert.equal(geoWeek(new Date(2026, 0, 31)), 4);
  assert.equal(geoWeek(new Date(2026, 4, 15)), 19);
  assert.equal(geoWeek(new Date(2026, 11, 31)), 48);
  assert.equal(geoWeek('2026-05-15T12:00:00'), 19);
  assert.equal(geoWeek(null), null);
  assert.equal(geoWeek('nonsense'), null);
});

const summer = Array.from({ length: 48 }, (_, i) => (i + 1 >= 14 && i + 1 <= 36 ? 0.8 : 0.01));

test('summary: peak, present range, unusual in winter', () => {
  const s = summarizeSeason(summer, 2, 0.03);
  assert.equal(s.peak, 0.8);
  assert.equal(s.peakWeek, 14);
  assert.deepEqual(s.presentRanges, [[14, 36]]);
  assert.equal(s.unusual, true);
  assert.equal(summarizeSeason(summer, 20, 0.03).unusual, false);
});

test('summary without date: no current, never unusual', () => {
  const s = summarizeSeason(summer, null, 0.03);
  assert.equal(s.current, null);
  assert.equal(s.unusual, false);
});

test('presentText: all year, none, range over the new year joined', () => {
  assert.equal(presentText([[1, 48]]), 'all year');
  assert.equal(presentText([]), 'not expected');
  assert.equal(presentText([[1, 8], [37, 48]]), 'early Oct – late Feb');
  assert.equal(presentText([[14, 36]]), `${weekLabel(14)} – ${weekLabel(36)}`);
  assert.equal(weekLabel(14), 'mid Apr');
});

test('chart: marker only with week, 12 month labels', () => {
  const a = seasonChartSvg(summer, { week: 20, threshold: 0.03 });
  assert.match(a, /geo-season-now/);
  assert.match(a, /geo-season-threshold/);
  assert.equal((a.match(/geo-season-month/g) || []).length, 12);
  assert.doesNotMatch(seasonChartSvg(summer), /geo-season-now/);
});



test('unusual hint names score, week, threshold and that it is a prior', () => {
  const t = unusualHintText(0.004, 0.03, 2);
  assert.match(t, /0\.00/);
  assert.match(t, /mid Jan/);
  assert.match(t, /0\.03/);
  assert.match(t, /not an observation/);
});

test('geomodel source: docs URL, license and caveats from the project page', () => {
  assert.equal(GEOMODEL_SOURCE.url, 'https://birdnet-team.github.io/geomodel/');
  assert.match(GEOMODEL_SOURCE.license, /Apache-2\.0/);
  assert.ok(GEOMODEL_SOURCE.caveats.some((c) => /not a species distribution model/.test(c)));
});

test('geoWeek: date-only strings are calendar dates in every time zone', async () => {
  const { execFileSync } = await import('node:child_process');
  const code = `import('${new URL('../src/ui/components/geo-season.ts', import.meta.url).href}').then((m) => process.stdout.write(JSON.stringify([m.geoWeek('2026-01-01'), m.geoWeek('2026-12-31'), m.geoWeek('2026-05-15')])))`;
  for (const tz of ['America/Los_Angeles', 'Pacific/Auckland', 'UTC']) {
    const out = execFileSync(process.execPath, ['--experimental-strip-types', '-e', code], { env: { ...process.env, TZ: tz } }).toString();
    assert.deepEqual(JSON.parse(out), [1, 48, 19], tz);
  }
});
