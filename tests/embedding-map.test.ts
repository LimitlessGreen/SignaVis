import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inPolygon, scoreColor, topShares } from '../src/ui/panels/embedding-map.ts';

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

test('scoreColor: blue at 0, grey at 0.5, yellow at 1, clamped', () => {
    assert.equal(scoreColor(0), 'rgb(78,121,216)');
    assert.equal(scoreColor(0.5), 'rgb(150,150,150)');
    assert.equal(scoreColor(1), 'rgb(241,196,15)');
    assert.equal(scoreColor(-3), scoreColor(0));
    assert.equal(scoreColor(7), scoreColor(1));
});

test('topShares: most frequent keys with share', () => {
    assert.deepEqual(topShares(['a', 'b', 'a', 'c', 'a', 'b']), [{ key: 'a', share: 0.5 }, { key: 'b', share: 2 / 6 }]);
    assert.deepEqual(topShares([]), []);
});
