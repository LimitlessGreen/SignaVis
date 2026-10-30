// ═══════════════════════════════════════════════════════════════════════
// snap-to-call.test.mjs — Snap to call: region growing on a dB patch and
// the WASM patch around a click (tone burst in noise → tight box).
// ═══════════════════════════════════════════════════════════════════════

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { snapToCall, bandMedians } from '../src/domain/snapToCall.ts';
import { computeSnapPatch } from '../src/app/snapPatch.ts';
import { initWasmMain } from '../src/infrastructure/wasm-dsp/wasmMain.ts';

/** Deterministic noise in [-1, 1). */
function rng(seed) {
    let s = seed >>> 0;
    return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 31) - 1;
}

/** Synthetic patch: noise floor −80 dB, call cells at −30 dB. */
function patch(frames, bins, call) {
    const r = rng(1), values = new Float32Array(frames * bins);
    for (let f = 0; f < frames; f++) for (let b = 0; b < bins; b++)
        values[f * bins + b] = -80 + 3 * r() + (call(f, b) ? 50 : 0);
    return { values, frames, bins, t0: 0, dt: 0.01, f0: 0, df: 100, atStart: true, atEnd: true };
}

test('boxes a rectangular call from a click inside it', () => {
    const p = patch(200, 100, (f, b) => f >= 50 && f <= 80 && b >= 20 && b <= 30);
    const r = snapToCall(p, 0.65, 2500);
    assert.ok(r.ok);
    assert.ok(Math.abs(r.box.start - 0.495) < 1e-9 && Math.abs(r.box.end - 0.805) < 1e-9, JSON.stringify(r.box));
    assert.equal(r.box.freqMin, 1950);
    assert.equal(r.box.freqMax, 3050);
});

test('click next to the call snaps to it (seed search)', () => {
    const p = patch(200, 100, (f, b) => f >= 50 && f <= 80 && b >= 20 && b <= 30);
    const r = snapToCall(p, 0.47, 1700); // 3 frames / 3 bins outside
    assert.ok(r.ok && r.box.start < 0.5 && r.box.freqMax > 3000);
});

test('bridges one-cell gaps but not wider ones', () => {
    const gap1 = patch(200, 100, (f, b) => b === 40 && ((f >= 50 && f <= 60) || (f >= 62 && f <= 70)));
    const r1 = snapToCall(gap1, 0.55, 4000);
    assert.ok(r1.ok && Math.abs(r1.box.end - 0.705) < 1e-9);
    const gap3 = patch(200, 100, (f, b) => b === 40 && ((f >= 50 && f <= 60) || (f >= 64 && f <= 70)));
    const r3 = snapToCall(gap3, 0.55, 4000);
    assert.ok(r3.ok && Math.abs(r3.box.end - 0.605) < 1e-9);
});

test('rejects clicks on background noise', () => {
    const p = patch(200, 100, () => false);
    assert.deepEqual(snapToCall(p, 1, 5000), { ok: false, reason: 'noise' });
});

test('rejects regions that spread over the patch', () => {
    const p = patch(200, 100, (f) => f < 120); // broadband over 60 % of the patch
    const r = snapToCall(p, 0.5, 5000, 0.75, new Float32Array(100).fill(-80));
    assert.deepEqual(r, { ok: false, reason: 'spread' });
});

test('band floor is the per-bin median', () => {
    const p = patch(9, 2, (f, b) => b === 1 && f < 4);
    const m = bandMedians(p);
    assert.ok(m[0] < -76 && m[1] < -76);
});

test('WASM patch: tone burst in noise gets a tight box', () => {
    initWasmMain(new WebAssembly.Module(fs.readFileSync(new URL('../src/infrastructure/wasm-dsp/pkg/aw_dsp_wasm_bg.wasm', import.meta.url))));
    const sr = 44100, n = sr * 4, r = rng(7), x = new Float32Array(n);
    for (let i = 0; i < n; i++) {
        x[i] = 0.001 * r();
        const t = i / sr;
        // 10 ms raised-cosine ramps: hard edges would add broadband clicks
        const env = Math.min(1, Math.max(0, Math.min(t - 1.5, 1.8 - t) / 0.01));
        if (env > 0) x[i] += 0.3 * (0.5 - 0.5 * Math.cos(Math.PI * env)) * Math.sin(2 * Math.PI * 4000 * t);
    }
    const audio = { sampleRate: sr, length: n, numberOfChannels: 1, getChannelData: () => x };
    const p = computeSnapPatch(audio, 1.6, 1.5);
    assert.ok(p && p.atStart === false && p.df > 0);
    const res = snapToCall(p, 1.6, 4000);
    assert.ok(res.ok, JSON.stringify(res));
    // Window (11.6 ms) smears the edges by ~half a window plus the threshold
    assert.ok(Math.abs(res.box.start - 1.5) < 0.03 && Math.abs(res.box.end - 1.8) < 0.03, JSON.stringify(res.box));
    // ~80 dB SNR: threshold (25 % of the peak) reaches into the Hann side lobes → ±~550 Hz
    assert.ok(res.box.freqMin > 3300 && res.box.freqMin < 4000 && res.box.freqMax > 4000 && res.box.freqMax < 4700, JSON.stringify(res.box));
    // Lower sensitivity → threshold closer to the peak → tighter band
    const tight = snapToCall(p, 1.6, 4000, 0.4);
    assert.ok(tight.ok && tight.box.freqMax - tight.box.freqMin < res.box.freqMax - res.box.freqMin, JSON.stringify(tight));
});
