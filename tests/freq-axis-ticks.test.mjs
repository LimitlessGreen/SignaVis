import test from 'node:test';
import assert from 'node:assert/strict';
import { computeFreqTicks, formatKhz } from '../src/domain/freqAxisTicks.ts';

const MAX = 24000;
const LOG_MIN = 32.7;
const mel = (f) => 2595 * Math.log10(1 + f / 700);
const AXES = {
    linear: { minHz: 0, toFrac: (f) => 1 - f / MAX },
    mel: { minHz: 0, toFrac: (f) => 1 - mel(f) / mel(MAX) },
    log: { minHz: LOG_MIN, toFrac: (f) => 1 - Math.log(f / LOG_MIN) / Math.log(MAX / LOG_MIN) },
};
const labels = (ticks) => ticks.filter((t) => t.labeled).map((t) => t.hz);

for (const [name, axis] of Object.entries(AXES)) {
    for (const height of [120, 180, 300, 450, 900]) {
        test(`${name} ${height}px: labels keep their gap, stay on the axis, minor ticks too`, () => {
            const ticks = computeFreqTicks({ height, maxHz: MAX, ...axis });
            const ys = labels(ticks).map((f) => axis.toFrac(f) * height).sort((a, b) => a - b);
            assert.ok(ys.length >= 3, `only ${ys.length} labels`);
            for (let i = 1; i < ys.length; i++) assert.ok(ys[i] - ys[i - 1] >= 16 - 1e-6);
            assert.ok(ys[0] >= 16 - 1e-6 && ys.at(-1) <= height + 1e-6);
            const all = ticks.map((t) => axis.toFrac(t.hz) * height).sort((a, b) => a - b);
            for (let i = 1; i < all.length; i++) assert.ok(all[i] - all[i - 1] >= 6 - 1e-6);
        });
    }
}

test('more height gives more labels (Audacity-like density)', () => {
    for (const axis of Object.values(AXES)) {
        const n = (h) => labels(computeFreqTicks({ height: h, maxHz: MAX, ...axis })).length;
        assert.ok(n(900) > n(450) && n(450) > n(180));
    }
});

test('linear axis: even steps only', () => {
    const l = labels(computeFreqTicks({ height: 450, maxHz: MAX, ...AXES.linear }));
    const steps = new Set(l.slice(1).map((f, i) => f - l[i]));
    assert.equal(steps.size, 1, `uneven: ${l}`);
    assert.equal(l[0], 0);
});

test('mel/log: denser at the bottom, round values only, decades emphasized', () => {
    const ticks = computeFreqTicks({ height: 450, maxHz: MAX, ...AXES.log });
    const l = labels(ticks);
    for (const f of [100, 1000, 10000]) assert.ok(l.includes(f), `${f} missing: ${l}`);
    assert.ok(l.filter((f) => f < 1000).length > l.filter((f) => f >= 10000).length);
    for (const f of l) {
        const m = f / 10 ** Math.floor(Math.log10(f) + 1e-9);
        assert.ok([1, 1.5, 2, 2.5, 3, 4, 5, 6, 7, 8, 9].some((n) => Math.abs(n - m) < 1e-6), `odd value ${f}`);
    }
    assert.ok(ticks.find((t) => t.hz === 1000).major);
    assert.ok(!ticks.find((t) => t.hz === 2000)?.major);
});

test('zoomed frequency view: labels within the view, finer steps', () => {
    const lo = 2000, hi = 4000;
    const l = labels(computeFreqTicks({ height: 400, minHz: lo, maxHz: hi, toFrac: (f) => 1 - (f - lo) / (hi - lo) }));
    assert.ok(l.every((f) => f >= lo && f <= hi));
    assert.ok(l.length >= 10, `${l}`);
});

test('degenerate input yields no ticks', () => {
    assert.deepEqual(computeFreqTicks({ height: 0, minHz: 0, maxHz: MAX, toFrac: () => 0 }), []);
    assert.deepEqual(computeFreqTicks({ height: 300, minHz: 5, maxHz: 5, toFrac: () => 0 }), []);
});

test('formatKhz: kHz without unit', () => {
    assert.equal(formatKhz(0), '0');
    assert.equal(formatKhz(250), '0.25');
    assert.equal(formatKhz(1500), '1.5');
    assert.equal(formatKhz(20000), '20');
});
