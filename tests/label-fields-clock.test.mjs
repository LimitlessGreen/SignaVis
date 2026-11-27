import test from 'node:test';
import assert from 'node:assert/strict';
import { parseClock } from '../src/ui/components/label-modal/label-fields-form.ts';

// Recording starts 21:31:00 → offset 9 s is 21:31:09.
const clock = (s) => { const t = 21 * 3600 + 31 * 60 + s; const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), sec = t % 60;
    return `${h}:${String(m).padStart(2, '0')}:${sec.toFixed(2).padStart(5, '0')}`; };

test('parseClock: a plain number with the clock on is the second of the current minute', () => {
    assert.equal(parseClock('12.4', 9, clock).toFixed(2), '12.40');
    assert.ok(Number.isNaN(parseClock('75', 9, clock)), 'not a second of a minute');
});

test('parseClock: without a clock a plain number is the offset in the recording', () => {
    assert.equal(parseClock('12.4', 9, null), 12.4);
});

test('parseClock: a full clock time', () => {
    assert.equal(parseClock('21:31:20', 9, clock), 20);
});
