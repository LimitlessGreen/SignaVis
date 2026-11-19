import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inPolygon } from '../src/ui/panels/embedding-map.ts';

test('inPolygon: square and concave lasso', () => {
    const sq: [number, number][] = [[0, 0], [10, 0], [10, 10], [0, 10]];
    assert.equal(inPolygon(5, 5, sq), true);
    assert.equal(inPolygon(15, 5, sq), false);
    // U shape: the notch is outside
    const u: [number, number][] = [[0, 0], [3, 0], [3, 7], [7, 7], [7, 0], [10, 0], [10, 10], [0, 10]];
    assert.equal(inPolygon(5, 3, u), false);
    assert.equal(inPolygon(1, 3, u), true);
    assert.equal(inPolygon(5, 9, u), true);
});
