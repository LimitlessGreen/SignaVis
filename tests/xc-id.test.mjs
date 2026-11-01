import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toXcId, xcNumber, isXcId, sameXcId } from '../src/domain/xc/xcId.ts';

test('toXcId: canonical form from numbers, prefixed and URL input', () => {
    assert.equal(toXcId(928094), 'XC928094');
    assert.equal(toXcId('928094'), 'XC928094');
    assert.equal(toXcId('XC928094'), 'XC928094');
    assert.equal(toXcId(' xc 0123 '), 'XC123');
    assert.equal(toXcId('https://xeno-canto.org/123/download'), 'XC123');
});

test('toXcId: rejects non-IDs', () => {
    for (const v of [null, undefined, '', 'abc', '12a', 'XC', '0', 'XC000']) assert.equal(toXcId(v), null, String(v));
});

test('xcNumber / isXcId / sameXcId', () => {
    assert.equal(xcNumber('XC42'), '42');
    assert.equal(xcNumber('nope'), '');
    assert.ok(isXcId('42'));
    assert.ok(sameXcId('XC42', 42));
    assert.ok(!sameXcId(null, null));
});
