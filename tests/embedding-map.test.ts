import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inHours, inPolygon, scoreColor, seqColor, timeColor, topShares, windowTimes } from '../src/ui/panels/embedding-map.ts';

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

test('windowTimes: start from the file name plus the window offset, across midnight', () => {
    const files = ['site/UHH_001_S01_20161121_235800.flac', 'x/obs1__dt20230322_065001__s1.wav', 'no-time.wav'];
    const t = windowTimes(files, [0, 0, 1, 2], [0, 300, 10, 0]);
    const day = (iso: string) => Date.parse(`${iso}T00:00:00Z`) / 86_400_000;
    assert.equal(t.known, 3);
    assert.equal(t.minute[0], 23 * 60 + 58);
    assert.equal(t.day[0], day('2016-11-21'));
    // +300 s → 00:03 next day
    assert.equal(t.minute[1], 3);
    assert.equal(t.day[1], day('2016-11-22'));
    assert.equal(t.minute[2], 6 * 60 + 50 + 10 / 60);
    assert.ok(Number.isNaN(t.minute[3]) && Number.isNaN(t.day[3]));
});

test('inHours: plain range, wrap past midnight, whole day', () => {
    assert.equal(inHours(5, 4, 8), true);
    assert.equal(inHours(8, 4, 8), false);
    assert.equal(inHours(23, 20, 6), true);
    assert.equal(inHours(3, 20, 6), true);
    assert.equal(inHours(12, 20, 6), false);
    assert.equal(inHours(12, 0, 24), true);
});

test('timeColor is cyclic, seqColor clamps', () => {
    assert.equal(timeColor(0), timeColor(24));
    assert.equal(timeColor(6), 'rgb(235,130,50)');
    assert.equal(timeColor(-6), timeColor(18));
    assert.equal(seqColor(-1), 'rgb(68,1,84)');
    assert.equal(seqColor(2), 'rgb(253,231,37)');
});
