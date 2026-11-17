// ═══════════════════════════════════════════════════════════════════════
// similar-groups.test.mjs — overview: call patches, features and average-
// linkage grouping (domain/similar/cluster.ts, app/similarSpectrogram.ts).
// ═══════════════════════════════════════════════════════════════════════

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { averageLinkage, callFeature, callDistance, groupCalls, ROWS, COLS } from '../src/domain/similar/cluster.ts';
import { callPatches } from '../src/app/similarSpectrogram.ts';
import { initWasmMain } from '../src/infrastructure/wasm-dsp/wasmMain.ts';

function rng(seed) {
    let s = seed >>> 0;
    return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 31) - 1;
}

test('averageLinkage matches scipy (average, fcluster distance) on a small case', () => {
    // Points on a line: {0, 1, 2}, {10, 11}, {30}
    const xs = [0, 1, 2, 10, 11, 30];
    const d = (i, j) => Math.abs(xs[i] - xs[j]);
    const lab = averageLinkage(xs.length, d, 3);
    assert.deepEqual([...lab], [0, 0, 0, 1, 1, 2]);
    // scipy merge heights: 1, 1, 1.5, 9.5, 25.2
    assert.deepEqual(new Set(averageLinkage(xs.length, d, 10)).size, 2);
    assert.deepEqual(new Set(averageLinkage(xs.length, d, 25)).size, 2);
    assert.deepEqual(new Set(averageLinkage(xs.length, d, 26)).size, 1);
    assert.deepEqual(new Set(averageLinkage(xs.length, d, 0.5)).size, 6);
});

test('callFeature resamples to a unit-norm ROWS × COLS patch', () => {
    const values = Float32Array.from({ length: 7 * 13 }, (_, i) => (i % 13) * 2 + Math.floor(i / 13));
    const f = callFeature({ values, rows: 7, cols: 13, duration: 0.3, centreHz: 3000 });
    assert.equal(f.v.length, ROWS * COLS);
    assert.ok(Math.abs(f.v.reduce((s, x) => s + x * x, 0) - 1) < 1e-5);
    assert.ok(Math.abs(f.v.reduce((s, x) => s + x, 0)) < 1e-4);
    assert.ok(callDistance(f, f) < 1e-6);
});

test('groupCalls separates two call types and different frequencies; medoid first', () => {
    const r = rng(5);
    const patch = (kind, hz) => {
        const values = new Float32Array(10 * 20);
        for (let i = 0; i < values.length; i++) values[i] = r();
        for (let c = 0; c < 20; c++) values[(kind === 'up' ? Math.floor(c / 2) : 5) * 20 + c] += 20;
        return callFeature({ values, rows: 10, cols: 20, duration: 0.3, centreHz: hz });
    };
    const feats = [patch('up', 3000), patch('flat', 3000), patch('up', 3100), patch('flat', 2900), patch('up', 3050), patch('up', 12000)];
    const groups = groupCalls(feats);
    const sets = groups.map((g) => [...g.members].sort().join(','));
    assert.deepEqual(sets, ['0,2,4', '1,3']);          // the 12-kHz sweep is too far off in frequency
    assert.equal(groups[0].scores[0], 1);
    assert.ok(groups[0].scores.slice(1).every((s) => s > 0.8));
});

test('callPatches on real audio: chirps group together, tones apart', async () => {
    initWasmMain(new WebAssembly.Module(fs.readFileSync(new URL('../src/infrastructure/wasm-dsp/pkg/aw_dsp_wasm_bg.wasm', import.meta.url))));
    const sr = 32000, n = sr * 12, x = new Float32Array(n), r = rng(9);
    for (let i = 0; i < n; i++) x[i] = 0.01 * r();
    const tone = (at, f0, f1) => {
        let ph = 0;
        for (let i = 0; i < 0.25 * sr; i++) {
            const t = i / sr;
            ph += 2 * Math.PI * (f0 + (f1 - f0) * t / 0.25) / sr;
            x[Math.round(at * sr) + i] += 0.3 * Math.sin(ph) * Math.sin(Math.PI * t / 0.25);
        }
    };
    const boxes = [];
    for (const at of [1, 3, 5]) { tone(at, 3000, 4500); boxes.push({ start: at, end: at + 0.25, freqMin: 2900, freqMax: 4600 }); }
    for (const at of [7, 9]) { tone(at, 3700, 3700); boxes.push({ start: at, end: at + 0.25, freqMin: 2900, freqMax: 4600 }); }
    const audio = { sampleRate: sr, length: n, numberOfChannels: 1, getChannelData: () => x };
    const patches = await callPatches(audio, boxes);
    assert.ok(patches.every(Boolean));
    // Same box (band, duration), different shape: apart at a fine cut (the default 1.0 trades purity for fewer groups)
    const groups = groupCalls(patches.map(callFeature), { cut: 0.6 });
    assert.deepEqual(groups.map((g) => [...g.members].sort().join(',')), ['0,1,2', '3,4']);
});
