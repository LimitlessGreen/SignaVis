// Playhead clock: after play() the media clock runs in bursts while the audio output starts
// (Chromium, QtWebEngine in the Analyzer window). The playhead must not start, stop and leap.
import test from 'node:test';
import assert from 'node:assert/strict';
import { PlayheadClock } from '../src/app/playheadClock.ts';

const PPS = 100;                    // px per second
const VEL = PPS / 1000;             // px per ms at rate 1
const FRAME = VEL * 1000 / 60;

/** Measured in the Analyzer window (QtWebEngine, 24.11.2026), label click at 6 s: [ms, currentTime]. */
const QT = [[113,6],[128,6],[142,6.0044],[175,6.0106],[192,6.0107],[208,6.0107],[225,6.018],[242,6.0183],[258,6.0183],
    [275,6.0183],[292,6.02],[308,6.0343],[325,6.0508],[342,6.0512],[358,6.0513],[375,6.0583],[392,6.0586],[408,6.0586],
    [425,6.0702],[442,6.087],[458,6.1035],[475,6.1201],[492,6.1204],[508,6.1204],[525,6.1274],[542,6.1278],[558,6.1419],
    [575,6.1585],[592,6.1752],[608,6.1918],[625,6.2085],[642,6.2251],[658,6.2417],[675,6.2584],[692,6.2751],[708,6.2918],
    [725,6.3087],[742,6.3252],[758,6.3419],[775,6.3585],[792,6.3751],[808,6.3917],[825,6.4084],[842,6.425],[858,6.4417],
    [875,6.4582],[892,6.475],[908,6.4917],[925,6.5084],[942,6.5251],[958,6.5417],[975,6.5584],[992,6.5751],[1008,6.5918],
    [1025,6.6083],[1042,6.6253],[1058,6.6417],[1075,6.6582],[1092,6.675],[1108,6.6916],[1125,6.7083],[1142,6.7253]];

/** Chromium (headless, 24.11.2026) from the start of the file: a step, a ~250 ms hold, then runs. */
function chromiumStart() {
    const rows = [];
    for (let ms = 0; ms <= 1500; ms += 1000 / 60) {
        const t = ms < 15 ? 0 : ms < 50 ? 0.0128 : ms < 300 ? 0.0192 : 0.0192 + (ms - 300) / 1000;
        rows.push([ms, t]);
    }
    return rows;
}

function run(rows) {
    const clock = new PlayheadClock();
    return rows.map(([ms, t]) => [ms, clock.update(t * PPS, true, 1000 + ms, VEL, 120)]);
}

/** Once moving, every frame moves forward by at most 1.5 frames of playback, and never stops. */
function assertEven(out, label) {
    const firstMove = out.findIndex(([, x], i) => i && x > out[i - 1][1]);
    assert.ok(firstMove > 0, `${label}: never moved`);
    for (let i = firstMove; i < out.length; i++) {
        const d = out[i][1] - out[i - 1][1];
        const frames = (out[i][0] - out[i - 1][0]) / (1000 / 60);
        assert.ok(d > 0, `${label}: stops at ${out[i][0]} ms`);
        assert.ok(d <= FRAME * frames * 1.5 + 1e-9, `${label}: leaps ${d.toFixed(2)} px at ${out[i][0]} ms`);
    }
}

test('Qt label click: holds, then moves evenly - no start, stop, leap', () => {
    const out = run(QT);
    assertEven(out, 'qt');
    const [ms, x] = out[out.length - 1];
    assert.ok(Math.abs(x - 6.7253 * PPS) < 2, `ends near the clock: ${x} at ${ms}`);
});

test('Chromium from the start: holds through the output start, then moves evenly', () => {
    const out = run(chromiumStart());
    for (const [ms, x] of out) if (ms < 300) assert.equal(x, 0, `ms ${ms}`);
    assertEven(out, 'chromium');
    const [ms, x] = out[out.length - 1];
    assert.ok(Math.abs(x - (0.0192 + (ms - 300) / 1000) * PPS) < 1);
});

test('a coarse clock (steps every 50 ms) still moves every frame', () => {
    const rows = [];
    for (let ms = 0; ms <= 1500; ms += 1000 / 60) rows.push([ms, Math.floor(ms / 50) * 0.05]);
    const out = run(rows).filter(([ms]) => ms > 300);
    assertEven(out, 'coarse');
});

test('a stall slows to a halt, no overshoot past the stall plus 200 ms', () => {
    const rows = [];
    for (let ms = 0; ms <= 2000; ms += 1000 / 60) rows.push([ms, ms < 1000 ? ms / 1000 : ms < 1500 ? 1 : (ms - 500) / 1000]);
    const out = run(rows);
    const at1400 = out.find(([ms]) => ms >= 1400)[1];
    assert.ok(at1400 <= 1.2 * PPS + 1e-9, `${at1400}`);
});

test('a seek backwards and a pause snap to the raw position', () => {
    const c = new PlayheadClock();
    for (let ms = 0; ms < 500; ms += 16) c.update(ms * VEL, true, ms, VEL, 120);
    assert.equal(c.update(10, true, 516, VEL, 120), 10);
    assert.equal(c.update(33, false, 532, VEL, 120), 33);
});

/** Routed through a running AudioContext (QtWebEngine, 24.11.2026, outputLatency 0.048 s): the clock
 *  runs evenly from the first frame, in 10.7 ms quanta. */
const QT_ROUTED = [[1.4,0],[16,0.0213],[32.7,0.032],[49.3,0.0533],[66,0.0723],[82.6,0.0853],[99.3,0.1059],[116.1,0.1173],
    [132.7,0.1387],[149.3,0.1493],[166,0.1707],[182.7,0.1899],[199.3,0.2027],[216,0.2233],[232.7,0.234],[249.3,0.2553],
    [266,0.2667],[282.7,0.288],[299.3,0.2987],[316,0.32],[332.7,0.3307],[349.3,0.352],[366,0.3627],[382.7,0.384],[399.3,0.3947]];

test('routed: holds only for the output latency, then follows the sound evenly', () => {
    const clock = new PlayheadClock();
    const LAT = 0.048;
    const out = QT_ROUTED.map(([ms, t]) => [ms, clock.update(t * PPS, true, 1000 + ms, VEL, 120, LAT * PPS)]);
    // Still while the sound has not started; moving as soon as it has
    for (const [ms, x] of out) if (ms < LAT * 1000) assert.equal(x, 0, `ms ${ms}`);
    const firstMove = out.find(([, x]) => x > 0)[0];
    assert.ok(firstMove <= LAT * 1000 + 20, `starts at ${firstMove} ms`);
    // Once moving, within 1.5 px (15 ms) of the sound
    for (const [ms, x] of out) if (ms > firstMove) assert.ok(Math.abs(x - (ms / 1000 - LAT) * PPS) < 1.5, `lags at ${ms}: ${x}`);
    // Never ahead of what is audible (+ one frame of slack), and close to it at the end
    for (const [ms, x] of out) assert.ok(x <= (ms / 1000 - LAT) * PPS + FRAME + 1e-9 || x === 0, `ahead at ${ms}: ${x}`);
    const [ms, x] = out[out.length - 1];
    assert.ok(Math.abs(x - (ms / 1000 - LAT) * PPS) < 1.5, `ends near the sound: ${x} at ${ms}`);
    // No leap after it started
    for (let i = 1; i < out.length; i++) assert.ok(out[i][1] - out[i - 1][1] <= FRAME * 1.5 + 1e-9, `leap at ${out[i][0]}`);
});
