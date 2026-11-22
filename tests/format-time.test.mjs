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

test('formatMinSec rounds before splitting into minutes and seconds', async () => {
    const { formatMinSec } = await import('../src/shared/utils.ts');
    assert.equal(formatMinSec(59.6), '1:00');
    assert.equal(formatMinSec(119.5), '2:00');
    assert.equal(formatMinSec(61.2), '1:01');
    assert.equal(formatMinSec(0), '0:00');
    assert.equal(formatMinSec(NaN), '0:00');
});

test('formatMinSecTenths rounds before splitting (label list, similar panel, ultrasound dialog)', async () => {
    const { formatMinSecTenths } = await import('../src/shared/utils.ts');
    assert.equal(formatMinSecTenths(59.96), '1:00.0');
    assert.equal(formatMinSecTenths(65.25), '1:05.3');
    assert.equal(formatMinSecTenths(3.04), '0:03.0');
    assert.equal(formatMinSecTenths(-1), '0:00.0');
});
