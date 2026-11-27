import test from 'node:test';
import assert from 'node:assert/strict';
import { geoWeek, summarizeSeason, presentText, seasonChartSvg, weekLabel } from '../src/ui/components/geo-season.ts';

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
