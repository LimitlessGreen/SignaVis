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
