import test from 'node:test';
import assert from 'node:assert/strict';
import { envelopeMinMax, envelopePeakAbs } from '../src/domain/waveformEnvelope.ts';
import { computeAmplitudePeak } from '../src/domain/spectrogram.ts';

function signal(n, seed = 3) {
    const v = new Float32Array(n);
    let s = seed;
    for (let i = 0; i < n; i++) { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; v[i] = (s / 2 ** 32) * 2 - 1; }
    v[17] = NaN;
    return v;
}

function naive(v, a, b) {
    let min = Infinity, max = -Infinity;
    for (let i = a; i < b; i++) { if (v[i] < min) min = v[i]; if (v[i] > max) max = v[i]; }
    return [min, max];
}

test('envelopeMinMax equals a scan of the samples for any range', () => {
    const v = signal(100_003);
    let s = 11;
    const rnd = (n) => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s % n; };
    for (let k = 0; k < 2000; k++) {
        const a = rnd(v.length), b = Math.min(v.length, a + 1 + rnd(k % 2 ? 300 : 40_000));
        assert.deepEqual(envelopeMinMax(v, a, b), naive(v, a, b), `${a}..${b}`);
    }
});

test('envelopePeakAbs equals computeAmplitudePeak', () => {
    for (const n of [1, 255, 256, 257, 100_000]) {
        const v = signal(n, n);
        if (n > 50) v[n - 2] = -1.5;
        assert.equal(envelopePeakAbs(v), computeAmplitudePeak(v));
    }
});

test('channelPeaksAsync builds the same pyramid in slices and fills the cache', async () => {
    const { channelPeaks, channelPeaksAsync } = await import('../src/domain/waveformEnvelope.ts');
    const v = signal(3_000_017, 5), ref = signal(3_000_017, 5);
    let ticks = 0;
    const timer = setInterval(() => ticks++, 0);
    let p;
    try { p = await channelPeaksAsync(v, 4096); } finally { clearInterval(timer); }
    assert.ok(ticks > 3, `event loop ran ${ticks}× while building`);
    assert.equal(channelPeaks(v), p, 'cached');
    const sync = channelPeaks(ref);
    for (const lvl of ['fine', 'coarse']) {
        assert.equal(p[lvl].block, sync[lvl].block);
        assert.deepEqual(p[lvl].min, sync[lvl].min, lvl);
        assert.deepEqual(p[lvl].max, sync[lvl].max, lvl);
    }
});

test('channelPeaksAsync builds the coarse level in several slices too', async () => {
    const { channelPeaks, channelPeaksAsync } = await import('../src/domain/waveformEnvelope.ts');
    // 256 fine blocks per slice → 256 coarse blocks per slice: ~12 coarse slices.
    const v = signal(3_000_017, 6), ref = signal(3_000_017, 6);
    const p = await channelPeaksAsync(v, 256, null);
    const sync = channelPeaks(ref);
    assert.ok(sync.coarse.min.length > 256 * 10);
    assert.deepEqual(p.coarse.min, sync.coarse.min);
    assert.deepEqual(p.coarse.max, sync.coarse.max);
});

test('maxAbsPeaks: max |sample| per bin from the pyramid', async () => {
    const { maxAbsPeaks } = await import('../src/domain/waveformEnvelope.ts');
    const v = signal(1_000_000, 9);
    v[17] = 0;
    const out = maxAbsPeaks(v, 100);
    assert.equal(out.length, 100);
    // Bins follow coarse-block boundaries; each bin covers its samples exactly.
    const per = Math.ceil(Math.ceil(v.length / 1024) / 100) * 1024;
    for (let i = 0; i < 100; i++) {
        const [lo, hi] = naive(v, i * per, Math.min(v.length, (i + 1) * per));
        if (i * per >= v.length) { assert.equal(out[i], 0); continue; }
        assert.equal(out[i], Math.max(-lo, hi), `bin ${i}`);
    }
});

test('channelPeaksAsync in the peaks worker equals the main-thread pyramid', async () => {
    // Run the real worker module in-process: a fake `self` receives its onmessage handler.
    const workerSide = { onmessage: null, postMessage: (msg, transfer) => queueMicrotask(() => fake.onmessage?.({ data: structuredClone(msg, { transfer }) })) };
    const fake = { onmessage: null, onerror: null, terminated: false,
        postMessage(msg, transfer) { const data = structuredClone(msg, { transfer }); setTimeout(() => workerSide.onmessage({ data }), 0); },
        terminate() { this.terminated = true; } };
    globalThis.self = workerSide;
    await import('../src/infrastructure/waveformPeaks.worker.ts');
    delete globalThis.self;
    const { channelPeaksAsync, channelPeaks } = await import('../src/domain/waveformEnvelope.ts');
    const n = (1 << 23) + 12_345;                      // above the worker threshold, partial last piece
    const v = signal(n, 21), ref = signal(n, 21);
    const before = v.slice(0, 1000);
    const p = await channelPeaksAsync(v, 1 << 16, () => fake);
    assert.ok(fake.terminated);
    assert.deepEqual(v.subarray(0, 1000), before, 'source untouched');
    const sync = channelPeaks(ref);
    for (const lvl of ['fine', 'coarse']) {
        assert.deepEqual(p[lvl].min, sync[lvl].min, lvl);
        assert.deepEqual(p[lvl].max, sync[lvl].max, lvl);
    }
    assert.equal(channelPeaks(v), p, 'cached');
});

test('envelopeStats: min/max like envelopeMinMax, RMS like a scan of the samples', async () => {
    const { envelopeStats } = await import('../src/domain/waveformEnvelope.ts');
    const v = signal(200_003, 9);
    let s = 7;
    const rnd = (n) => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s % n; };
    for (let k = 0; k < 500; k++) {
        const a = rnd(v.length), b = Math.min(v.length, a + 1 + rnd(k % 2 ? 300 : 80_000));
        const st = envelopeStats(v, a, b);
        assert.deepEqual([st.lo, st.hi], envelopeMinMax(v, a, b), `${a}..${b}`);
        let acc = 0;
        for (let i = a; i < b; i++) if (v[i] === v[i]) acc += v[i] * v[i];
        const rms = Math.sqrt(acc / (b - a));
        assert.ok(Math.abs(st.rms - rms) < 1e-4 * Math.max(1, rms), `${a}..${b}: ${st.rms} vs ${rms}`);
    }
    assert.equal(envelopeStats(v, 5, 5).rms, 0);
});

test('the pyramid keeps sums of squares; async and worker-shaped builds agree', async () => {
    const { channelPeaks, channelPeaksAsync } = await import('../src/domain/waveformEnvelope.ts');
    const v = signal(1_000_003, 12), ref = signal(1_000_003, 12);
    const p = await channelPeaksAsync(v, 512, null);
    const sync = channelPeaks(ref);
    for (const lvl of ['fine', 'coarse']) assert.deepEqual(p[lvl].sq, sync[lvl].sq, lvl);
    // A coarse block is the sum of its fine blocks.
    const f = sync.fine.sq, c = sync.coarse.sq;
    let sum = 0;
    for (let i = 0; i < 32; i++) sum += f[i];
    assert.ok(Math.abs(c[0] - sum) < 1e-3);
});
