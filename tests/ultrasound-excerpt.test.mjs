import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findCallExcerpt } from '../src/domain/ultrasound.ts';

test('findCallExcerpt lands on the burst of high-frequency calls', () => {
    const sr = 192000, n = sr * 10, x = new Float32Array(n);
    for (let i = 0; i < n; i++) x[i] = 0.001 * Math.sin(i * 0.01); // low hum
    for (let t = 6.2; t < 7.2; t += 0.1) {
        const i0 = Math.round(t * sr);
        for (let i = 0; i < 1000; i++) x[i0 + i] += 0.3 * Math.sin((2 * Math.PI * 45000 * i) / sr);
    }
    const ex = findCallExcerpt(x, sr, 1.5);
    assert.ok(ex.start <= 6.25 && ex.end >= 7.0, JSON.stringify(ex));
    assert.ok(Math.abs(ex.end - ex.start - 1.5) < 1e-6);
});
