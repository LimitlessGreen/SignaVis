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
