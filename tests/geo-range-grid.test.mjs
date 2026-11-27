import test from 'node:test';
import assert from 'node:assert/strict';
import { mercY, invMercY, gridForView, scoreColor, gridToRgba } from '../src/ui/components/geo-range-map/range-grid.ts';

test('mercator round trip', () => {
  for (const lat of [-80, -45, 0, 12.5, 51.34, 80]) assert.ok(Math.abs(invMercY(mercY(lat)) - lat) < 1e-9);
});

test('grid: rows evenly spaced in mercator y, north first, inside the view', () => {
  const g = gridForView({ north: 60, south: 40, west: 0, east: 30 }, 600, 400, 10);
  assert.equal(g.cols, 60);
  assert.equal(g.lats.length, 40);
  assert.ok(g.lats[0] < 60 && g.lats[0] > g.lats[1] && g.lats.at(-1) > 40);
  const dy = g.lats.slice(1).map((l, i) => mercY(g.lats[i]) - mercY(l));
  for (const d of dy) assert.ok(Math.abs(d - dy[0]) < 1e-9);
});

test('grid: capped cell count, world view limited to 360° and polar latitudes clamped', () => {
  const g = gridForView({ north: 89, south: -89, west: -400, east: 400 }, 4000, 3000, 2, 10000);
  assert.ok(g.lats.length * g.cols <= 10000);
  assert.equal(g.east - g.west, 360);
  assert.ok(g.north < 85.1 && g.south > -85.1);
});

test('colours: transparent below min, more opaque for higher scores', () => {
  assert.equal(scoreColor(0.005)[3], 0);
  assert.equal(scoreColor(NaN)[3], 0);
  assert.ok(scoreColor(0.9)[3] > scoreColor(0.1)[3]);
  const px = gridToRgba([0, 1], 1, 2);
  assert.equal(px.length, 8);
  assert.equal(px[3], 0);
  assert.ok(px[7] > 0);
});
