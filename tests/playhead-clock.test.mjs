// Playhead clock: Chromium's media clock after play() steps a few ms, holds ~250 ms while the
// output starts, then runs. The playhead must not start, stop and leap ahead.
import test from 'node:test';
import assert from 'node:assert/strict';
import { PlayheadClock } from '../src/app/playheadClock.ts';

const PPS = 100;                    // px per second
const VEL = PPS / 1000;             // px per ms at rate 1

/** Measured in the Analyzer tab (Chromium 24.11.2026): [ms since play, media currentTime s]. */
function chromiumStart() {
    const rows = [];
    for (let ms = 0; ms <= 1500; ms += 1000 / 60) {
        let t;
        if (ms < 15) t = 0;
        else if (ms < 50) t = 0.0128;
        else if (ms < 300) t = 0.0192;            // output starting: clock holds
        else t = 0.0192 + (ms - 300) / 1000;      // runs
        rows.push([ms, t]);
    }
    return rows;
}

function run(rows, clock = new PlayheadClock()) {
    return rows.map(([ms, t]) => [ms, clock.update(t * PPS, true, 1000 + ms, VEL, 120)]);
}

test('holds still while the output starts, then moves evenly without a leap', () => {
    const out = run(chromiumStart());
    // During the hold the playhead stays within the raw pre-roll (< 2 px), no run-up
    for (const [ms, x] of out) if (ms < 300) assert.ok(x <= 0.0192 * PPS + 1e-9, `ms ${ms}: ${x}`);
    // Afterwards every frame advances by about one frame at the real rate: no leap, no stop
    const frame = VEL * 1000 / 60;
    const steps = out.filter(([ms]) => ms > 400).map(([, x], i, a) => i ? x - a[i - 1][1] : null).slice(1);
    for (const d of steps) assert.ok(d >= 0 && d < frame * 1.6, `step ${d}`);
});

test('ends close to the true position', () => {
    const out = run(chromiumStart());
    const [ms, x] = out[out.length - 1];
    const truth = (0.0192 + (ms - 300) / 1000) * PPS;
    assert.ok(Math.abs(x - truth) < 1, `${x} vs ${truth}`);
});

test('a coarse clock (steps every 50 ms) still moves every frame', () => {
    const rows = [];
    for (let ms = 0; ms <= 1500; ms += 1000 / 60) rows.push([ms, Math.floor(ms / 50) * 0.05]);
    const out = run(rows).filter(([ms]) => ms > 300);
    const moved = out.map(([, x], i) => i ? x - out[i - 1][1] : 1).slice(1);
    assert.ok(moved.every((d) => d > 0), 'every frame moves');
});

test('a seek backwards and a pause snap to the raw position', () => {
    const c = new PlayheadClock();
    let x = 0;
    for (let ms = 0; ms < 500; ms += 16) x = c.update(ms * VEL, true, ms, VEL, 120);
    assert.equal(c.update(10, true, 516, VEL, 120), 10);
    assert.equal(c.update(33, false, 532, VEL, 120), 33);
});
