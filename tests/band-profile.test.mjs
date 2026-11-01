import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeBandProfile, activeTopHz, autoViewMaxHz, prominentPeakHz } from '../src/domain/bandProfile.ts';

function rng(seed) { let s = seed; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32) * 2 - 1; }

/** White noise plus short tone bursts (calls) at the given frequency. */
function signal(sr, seconds, callHz, callAmp = 0.3) {
    const n = sr * seconds, x = new Float32Array(n), r = rng(7);
    for (let i = 0; i < n; i++) x[i] = 0.01 * r();
    if (callHz) {
        const len = Math.round(sr * 0.02);
        for (let t = 0.1; t < seconds - 0.1; t += 0.25) {
            const i0 = Math.round(t * sr);
            for (let i = 0; i < len; i++) x[i0 + i] += callAmp * Math.sin((2 * Math.PI * callHz * i) / sr) * Math.sin((Math.PI * i) / len);
        }
    }
    return x;
}

test('bird-like calls at 5 kHz in a 48 kHz file: view stops a little above them', () => {
    const p = computeBandProfile(signal(48000, 10, 5000), 48000);
    const top = activeTopHz(p);
    assert.ok(top > 4800 && top < 6500, `top ${top}`);
    const view = autoViewMaxHz(p);
    assert.ok(view >= top && view <= 9000, `view ${view}`);
});

test('pure noise: no auto zoom', () => {
    const p = computeBandProfile(signal(48000, 10, 0), 48000);
    assert.equal(autoViewMaxHz(p), null);
});

test('bat calls at 45 kHz in a 192 kHz file: prominent peak near 45 kHz', () => {
    const p = computeBandProfile(signal(192000, 5, 45000), 192000);
    const peak = prominentPeakHz(p, 18000);
    assert.ok(Math.abs(peak.hz - 45000) < 1500, `peak ${peak.hz}`);
    const view = autoViewMaxHz(p);
    assert.ok(view >= 46000 && view <= 60000, `view ${view}`);
});
