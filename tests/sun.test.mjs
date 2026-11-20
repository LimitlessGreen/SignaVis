import test from 'node:test';
import assert from 'node:assert/strict';

import {
    sunDay, sunAltitude, dayLengthHours, dayOfYear, guessUtcOffset, phaseOf, seasonOf, formatClock,
} from '../src/domain/sun.ts';

const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg}: ${a} vs ${b}`);

test('Berlin on 2024-06-21: sunrise ~04:43, sunset ~21:33 CEST', () => {
    const s = sunDay(52.52, 13.405, '2024-06-21', 2);
    near(s.events.horizon.rise, 4 * 60 + 43, 3, 'sunrise');
    near(s.events.horizon.set, 21 * 60 + 33, 3, 'sunset');
    near(s.dayLengthH, 16.83, 0.1, 'day length');
    // No astronomical night at midsummer in Berlin
    assert.equal(s.events.astronomical, 'always-above');
});

test('Leipzig on 2026-11-20 (CET): sunrise ~07:38, sunset ~16:15', () => {
    const s = sunDay(51.34, 12.37, '2026-11-20', 1);
    near(s.events.horizon.rise, 7 * 60 + 38, 4, 'sunrise');
    near(s.events.horizon.set, 16 * 60 + 15, 4, 'sunset');
    near(s.events.civil.rise, 7 * 60 + 0, 4, 'civil dawn');
});

test('polar night and midnight sun', () => {
    assert.equal(dayLengthHours(78, dayOfYear('2024-12-21')), 0);
    assert.equal(dayLengthHours(78, dayOfYear('2024-06-21')), 24);
    near(dayLengthHours(0, 80), 12.1, 0.15, 'equator');
});

test('altitude peaks at solar noon and phases follow thresholds', () => {
    const s = sunDay(51.34, 12.37, '2026-11-20', 1);
    const a = sunAltitude(51.34, 12.37, s.doy, s.noon, 1);
    near(a, 90 - 51.34 - 19.8, 0.6, 'noon altitude');
    assert.equal(phaseOf(-3), 'civil');
    assert.equal(phaseOf(-20), 'night');
    assert.equal(phaseOf(20), 'day');
});

test('UTC offset guess, seasons, clock format', () => {
    assert.equal(guessUtcOffset(51.3, 12.4, '2026-07-01'), 2);
    assert.equal(guessUtcOffset(51.3, 12.4, '2026-11-20'), 1);
    assert.equal(guessUtcOffset(51.5, -0.12, '2026-11-20'), 0);
    assert.equal(guessUtcOffset(40.7, -74, '2026-11-20'), -5);
    assert.equal(guessUtcOffset(40.7, -74, '2026-07-01'), -4);
    assert.equal(guessUtcOffset(28.6, 77.2, '2026-07-01'), 5.5);
    assert.equal(guessUtcOffset(43.4, -8.4, '2026-11-20'), 1); // Spain keeps CET in the far west
    assert.equal(seasonOf(11, 51), 'autumn');
    assert.equal(seasonOf(11, -33), 'spring');
    assert.equal(formatClock(-30), '23:30');
});

test('phaseSpans splits a 3 h dawn recording into light phases', async () => {
    const { phaseSpans } = await import('../src/domain/sun.ts');
    // Leipzig 12 May, 03:00–06:00 CEST: nautical → civil → low sun → (day after ~06:1x? no) …
    const spans = phaseSpans(51.34, 12.37, '2026-05-12', 180, 180, 2);
    assert.deepEqual(spans.map((s) => s.phase), ['astronomical', 'nautical', 'civil', 'golden']);
    assert.equal(spans[0].from, 180);
    assert.equal(spans.at(-1).to, 360);
    near(spans.find((s) => s.phase === 'golden').from, 5 * 60 + 25, 3, 'sunrise boundary');
    // Across midnight
    const night = phaseSpans(51.34, 12.37, '2026-11-20', 23 * 60, 120, 1);
    assert.equal(night.at(-1).to, 25 * 60);
});

test('clockDiff wraps event times from large offsets; offsets list has :30 and :45 zones', async () => {
    const { clockDiff, crossing, UTC_OFFSETS } = await import('../src/domain/sun.ts');
    // Equator at 150°W with UTC+14 (CodeRabbit case): sunrise lands near minute 1800 (= 06:00)
    const c = crossing(0, -150, 79, -0.833, 14);
    assert.ok(c.rise > 1440);
    near(clockDiff(12 * 60, c.rise), 6 * 60, 15, 'noon is ~6 h after sunrise');
    assert.equal(clockDiff(30, 1430), 40);
    assert.ok(UTC_OFFSETS.includes(5.5) && UTC_OFFSETS.includes(5.75) && UTC_OFFSETS.includes(-3.5));
});
