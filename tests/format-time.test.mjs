import test from 'node:test';
import assert from 'node:assert/strict';
import { formatTime } from '../src/shared/utils.ts';

test('formatTime rounds into the next minute instead of showing 60 seconds', () => {
    assert.equal(formatTime(59.96), '01:00.0');
    assert.equal(formatTime(119.97), '02:00.0');
});

test('formatTime keeps the usual mm:ss.t format', () => {
    assert.equal(formatTime(0), '00:00.0');
    assert.equal(formatTime(5.04), '00:05.0');
    assert.equal(formatTime(65.25), '01:05.3');
    assert.equal(formatTime(-3), '00:00.0');
    assert.equal(formatTime(NaN), '00:00.0');
});
