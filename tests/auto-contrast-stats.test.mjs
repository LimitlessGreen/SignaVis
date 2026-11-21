import test from 'node:test';
import assert from 'node:assert/strict';
import { autoContrastStats } from '../src/domain/spectrogram.ts';

function reference(data, lo, hi) {
    const stride = Math.max(1, Math.floor(data.length / 200000));
    const m = [];
    for (let i = 0; i < data.length; i += stride) m.push(data[i] || 0);
    m.sort((a, b) => a - b);
    const a = m[Math.floor(m.length * lo / 100)], b = m[Math.min(m.length - 1, Math.floor(m.length * hi / 100))];
    return (!Number.isFinite(a) || !Number.isFinite(b) || b - a < 1e-6) ? { logMin: 0, logMax: 1 } : { logMin: a, logMax: b };
}

test('autoContrastStats keeps its percentiles', () => {
    let s = 7;
    for (const n of [10, 1000, 199_999, 450_001, 3_000_000]) {
        const v = new Float32Array(n);
        for (let i = 0; i < n; i++) { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; v[i] = (s / 2 ** 32) * 120 - 100; }
        v[3] = NaN;
        for (const [lo, hi] of [[2, 98], [50, 99.9]]) assert.deepEqual(autoContrastStats(v, lo, hi), reference(v, lo, hi));
    }
});

test('autoContrastStats on 30 M values takes well under 100 ms', () => {
    const v = new Float32Array(30_000_000);
    for (let i = 0; i < v.length; i++) v[i] = Math.sin(i) * 50;
    const t = performance.now();
    autoContrastStats(v, 50, 99.9);
    assert.ok(performance.now() - t < 100, `${(performance.now() - t).toFixed(0)} ms`);
});
