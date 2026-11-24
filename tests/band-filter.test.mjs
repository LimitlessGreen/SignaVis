import test from 'node:test';
import assert from 'node:assert/strict';
import {
    BandFilter, effectiveBand, filterRange, bandPeaksAsync, cachedBandPeaks, peaksAbsMax, warmupSamples,
} from '../src/domain/bandFilter.ts';
import { channelPeaks } from '../src/domain/waveformEnvelope.ts';

const SR = 48_000;
const sine = (f, n, a = 1) => Float32Array.from({ length: n }, (_, i) => a * Math.sin(2 * Math.PI * f * i / SR));
const steadyPeak = (x) => { let m = 0; for (let i = x.length >> 1; i < x.length; i++) m = Math.max(m, Math.abs(x[i])); return m; };
const run = (band, x) => { const y = new Float32Array(x.length); new BandFilter(band, SR).process(x, y); return y; };

test('effectiveBand drops edges outside the signal and empty bands', () => {
    assert.deepEqual(effectiveBand({ lo: 2000, hi: 8000 }, SR), { lo: 2000, hi: 8000 });
    assert.deepEqual(effectiveBand({ lo: 0, hi: 10_000 }, SR), { lo: 0, hi: 10_000 });
    assert.deepEqual(effectiveBand({ lo: 1000, hi: 24_000 }, SR), { lo: 1000, hi: 0 }, 'no low-pass at Nyquist');
    assert.equal(effectiveBand({ lo: 0, hi: 24_000 }, SR), null, 'full band: nothing to filter');
    assert.equal(effectiveBand({ lo: 5000, hi: 4000 }, SR), null);
    assert.equal(effectiveBand(null, SR), null);
});

test('4th-order Butterworth: passes the band, −3 dB at the edges, −48 dB two octaves out', () => {
    const band = { lo: 2000, hi: 8000 };
    const n = SR / 2;
    assert.ok(Math.abs(steadyPeak(run(band, sine(4000, n))) - 1) < 0.02, 'passband');
    for (const f of [2000, 8000]) assert.ok(Math.abs(steadyPeak(run(band, sine(f, n))) - Math.SQRT1_2) < 0.03, `−3 dB at ${f}`);
    for (const f of [500, 20_000]) {   // two octaves below lo; > one octave above hi (nearer Nyquist, steeper)
        assert.ok(steadyPeak(run(band, sine(f, n))) < 0.02, `stopband ${f}`);
    }
    const hpOnly = { lo: 1000, hi: 0 };
    assert.ok(steadyPeak(run(hpOnly, sine(250, n))) < 0.005, 'high-pass alone: 250 Hz two octaves down');
    assert.ok(Math.abs(steadyPeak(run(hpOnly, sine(10_000, n))) - 1) < 0.01);
});

test('filterRange with its lead-in matches the same samples filtered from the start', () => {
    const x = new Float32Array(SR);
    let s = 1;
    for (let i = 0; i < x.length; i++) { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; x[i] = (s / 2 ** 32) * 2 - 1 + 0.5 * Math.sin(i / 400); }
    for (const band of [{ lo: 1500, hi: 9000 }, { lo: 200, hi: 0 }, { lo: 0, hi: 3000 }]) {
        const full = run(band, x);
        const start = 30_000, end = 31_000;
        assert.ok(start > warmupSamples(band, SR));
        const part = filterRange(x, SR, band, start, end);
        let err = 0;
        for (let i = 0; i < part.length; i++) err = Math.max(err, Math.abs(part[i] - full[start + i]));
        assert.ok(err < 1e-3, `${JSON.stringify(band)}: max deviation ${err}`);
    }
    assert.equal(filterRange(x, SR, { lo: 1000, hi: 0 }, 0, 10).length, 10, 'at the file start: no lead-in available');
});

test('bandPeaksAsync builds the pyramid of the filtered signal in slices, cached and cancellable', async () => {
    const x = Float32Array.from({ length: 300_017 }, (_, i) => Math.sin(i / 3) + 0.8 * Math.sin(i / 900));
    const band = { lo: 3000, hi: 12_000 };
    let ticks = 0;
    const timer = setInterval(() => ticks++, 0);
    let p;
    try { p = await bandPeaksAsync(x, SR, band, { sliceSamples: 8192 }); } finally { clearInterval(timer); }
    assert.ok(ticks > 3, 'yields while filtering');
    const ref = channelPeaks(run(band, x));
    for (const lvl of ['fine', 'coarse']) {
        assert.deepEqual(p[lvl].min, ref[lvl].min, `${lvl} min`);
        assert.deepEqual(p[lvl].max, ref[lvl].max, `${lvl} max`);
        for (let i = 0; i < ref[lvl].sq.length; i++) assert.ok(Math.abs(p[lvl].sq[i] - ref[lvl].sq[i]) < 1e-3 * Math.max(1, ref[lvl].sq[i]));
    }
    assert.equal(cachedBandPeaks(x, band), p);
    assert.equal(await bandPeaksAsync(x, SR, band), p, 'second call from the cache');
    // The slow drift (~8 Hz) is removed: far less than the raw peak of ~1.8.
    assert.ok(peaksAbsMax(p) < 1.05, `filtered peak ${peaksAbsMax(p)}`);
    const other = { lo: 100, hi: 0 };
    assert.equal(await bandPeaksAsync(x, SR, other, { sliceSamples: 8192, isCancelled: () => true }), null);
    assert.equal(cachedBandPeaks(x, other), null, 'cancelled builds are not cached');
});

test('effectiveBand drops a high-pass edge at or above the Nyquist limit (unstable filter)', () => {
    assert.equal(effectiveBand({ lo: 23_800, hi: 0 }, SR), null);
    assert.equal(effectiveBand({ lo: 30_000, hi: 40_000 }, SR), null);
    const y = run({ lo: 23_800, hi: 0 }, sine(1000, 4800));   // would blow up if the band were used
    assert.ok(y.every(Number.isFinite));
});

test('filterRange settles for slow poles too: near-Nyquist low-pass and 1 Hz high-pass', () => {
    const n = 6 * SR;
    const x = new Float32Array(n);
    let s = 9;
    for (let i = 0; i < n; i++) { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; x[i] = (s / 2 ** 32) * 2 - 1 + 0.7 * Math.sin(i / 7000); }
    for (const band of [{ lo: 0, hi: 23_000 }, { lo: 1, hi: 0 }, { lo: 1000, hi: 10_000 }]) {
        const full = run(band, x);
        const start = 5 * SR, end = start + 2000;
        const part = filterRange(x, SR, band, start, end);
        let err = 0;
        for (let i = 0; i < part.length; i++) err = Math.max(err, Math.abs(part[i] - full[start + i]));
        assert.ok(err < 1e-3, `${JSON.stringify(band)}: max deviation ${err} (lead-in ${warmupSamples(band, SR)})`);
    }
    assert.ok(warmupSamples({ lo: 1000, hi: 10_000 }, SR) <= 2000, 'interior bands keep a short lead-in');
});
