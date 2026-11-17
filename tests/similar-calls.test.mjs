// ═══════════════════════════════════════════════════════════════════════
// similar-calls.test.mjs — "find similar calls": spectrogram correlation
// (domain/similar/ncc.ts), the band spectrogram of a recording, suggestion
// labels (app/suggest-similar.ts) and their provenance when copied.
// ═══════════════════════════════════════════════════════════════════════

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fft, nccCurve, pickPeaks, findSimilar, timeIoU } from '../src/domain/similar/ncc.ts';
import { bandSpectrogram } from '../src/app/similarSpectrogram.ts';
import { buildSuggestions, suggestionKey, searchBand, SIMILAR_ORIGIN } from '../src/app/suggest-similar.ts';
import { adoptLabels } from '../src/app/annotation-sets.ts';
import { initWasmMain } from '../src/infrastructure/wasm-dsp/wasmMain.ts';

function rng(seed) {
    let s = seed >>> 0;
    return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 31) - 1;
}

/** Noise spectrogram (rows × frames) with a rising sweep stamped at the given frames (+ row shift). */
function spec(frames, rows, calls, { amp = 20 } = {}) {
    const r = rng(7), values = new Float32Array(rows * frames);
    for (let i = 0; i < values.length; i++) values[i] = 3 * r();
    for (const { at, shift = 0, gain = 1 } of calls) {
        for (let t = 0; t < 40; t++) {
            const row = 20 + Math.round(t / 4) + shift;   // sweep 20 → 30
            values[row * frames + at + t] += amp * gain;
            values[(row + 1) * frames + at + t] += amp * gain * 0.5;
        }
    }
    return { values, rows, frames, f0: 0, df: 100, t0: 0, dt: 0.01 };
}

test('fft round trip', () => {
    const re = Float64Array.from({ length: 64 }, (_, i) => Math.sin(i) + i % 3), im = new Float64Array(64), orig = re.slice();
    fft(re, im); fft(re, im, true);
    for (let i = 0; i < 64; i++) assert.ok(Math.abs(re[i] - orig[i]) < 1e-9 && Math.abs(im[i]) < 1e-9);
});

test('nccCurve matches a direct Pearson correlation', () => {
    const s = spec(3000, 60, [{ at: 100 }, { at: 2500 }]);
    const { score } = nccCurve(s, 18, 34, 100, 140, 0);
    const R = 16, T = 40, N = s.frames;
    for (const j of [0, 100, 777, 2500, 2960]) {
        let sx = 0, sp = 0;
        for (let r = 0; r < R; r++) for (let t = 0; t < T; t++) { sx += s.values[(18 + r) * N + j + t]; sp += s.values[(18 + r) * N + 100 + t]; }
        const mx = sx / (R * T), mp = sp / (R * T);
        let num = 0, vx = 0, vp = 0;
        for (let r = 0; r < R; r++) for (let t = 0; t < T; t++) {
            const x = s.values[(18 + r) * N + j + t] - mx, p = s.values[(18 + r) * N + 100 + t] - mp;
            num += x * p; vx += x * x; vp += p * p;
        }
        assert.ok(Math.abs(score[j] - num / Math.sqrt(vx * vp)) < 1e-4, `offset ${j}`);
    }
    assert.ok(score[100] > 0.999 && score[2500] > 0.9);
});

test('findSimilar finds shifted and quiet repeats, not the exemplar or noise', () => {
    const s = spec(6000, 60, [{ at: 100 }, { at: 900, shift: 2 }, { at: 2300, gain: 0.4 }, { at: 5000, shift: -1 }]);
    const exemplar = { start: 1.0, end: 1.4, freqMin: 2000, freqMax: 3100 };
    const hits = findSimilar(s, exemplar, { minScore: 0.3 });
    const starts = hits.slice(0, 3).map((h) => Math.round(h.start * 100)).sort((a, b) => a - b);
    assert.deepEqual(starts, [900, 2300, 5000]);
    assert.ok(hits.every((h) => timeIoU(h, exemplar) < 0.3));
    const shifted = hits.find((h) => Math.round(h.start * 100) === 900);
    assert.equal(Math.round(shifted.freqMin), 2200);           // found two rows higher
    assert.ok(hits.length === 3 || hits[3].score < hits[2].score / 2, 'noise peaks far below the calls');
});

test('pickPeaks keeps the best of close maxima', () => {
    const s = Float32Array.from([0, 0.5, 0, 0.9, 0, 0, 0, 0, 0.6, 0]);
    assert.deepEqual(pickPeaks(s, 3, 0.1, 10), [3, 8]);
    assert.deepEqual(pickPeaks(s, 3, 0.7, 10), [3]);
});

test('band spectrogram of real audio: repeated chirps are found end to end', async () => {
    initWasmMain(new WebAssembly.Module(fs.readFileSync(new URL('../src/infrastructure/wasm-dsp/pkg/aw_dsp_wasm_bg.wasm', import.meta.url))));
    const sr = 32000, n = sr * 20, x = new Float32Array(n), r = rng(3);
    for (let i = 0; i < n; i++) x[i] = 0.01 * r();
    const chirp = (at, amp) => {
        let ph = 0;
        for (let i = 0; i < 0.25 * sr; i++) {
            const t = i / sr, f = 3000 + 4000 * t;     // 3000 → 4000 Hz
            ph += 2 * Math.PI * f / sr;
            x[Math.round(at * sr) + i] += amp * Math.sin(ph) * Math.sin(Math.PI * t / 0.25);
        }
    };
    for (const [at, amp] of [[2, 0.3], [7.5, 0.3], [12, 0.05], [17.2, 0.3]]) chirp(at, amp);
    const audio = { sampleRate: sr, length: n, numberOfChannels: 1, getChannelData: () => x };
    const exemplar = { start: 2, end: 2.25, freqMin: 2900, freqMax: 4100 };
    const s = await bandSpectrogram(audio, ...searchBand(exemplar, sr));
    assert.ok(s && s.rows > 10 && Math.abs(s.dt - 0.004) < 1e-9);
    const hits = findSimilar(s, exemplar, { minScore: 0.3 });
    const near = (t) => hits.find((h) => Math.abs(h.start - t) < 0.03);
    for (const t of [7.5, 12, 17.2]) assert.ok(near(t), `chirp at ${t} s`);
    assert.equal(hits.length, 3);
});

test('suggestions: skip labelled places and rejections, take BirdBox bounds, keep provenance', () => {
    const exemplar = { id: 'ex', label: 'Blackbird', scientificName: 'Turdus merula', color: '#123', start: 1, end: 1.4, freqMin: 2000, freqMax: 3000 };
    const hits = [
        { start: 5, end: 5.4, freqMin: 2000, freqMax: 3000, score: 0.9 },
        { start: 9, end: 9.4, freqMin: 2000, freqMax: 3000, score: 0.8 },     // already labelled
        { start: 12, end: 12.4, freqMin: 2000, freqMax: 3000, score: 0.7 },   // rejected before
        { start: 15, end: 15.4, freqMin: 2100, freqMax: 3100, score: 0.6 },
    ];
    let k = 0;
    const out = buildSuggestions(exemplar, hits, {
        labels: [exemplar, { id: 'o', label: 'Blackbird', scientificName: 'Turdus merula', start: 9.05, end: 9.35 }],
        boxes: [{ start: 15.02, end: 15.3, freqMin: 2300, freqMax: 2900 }],
        rejected: new Set([suggestionKey('Turdus merula', 12)]),
        setId: 'sim', recordingId: 'rec', newId: () => `s${++k}`,
    });
    assert.deepEqual(out.map((s) => s.start), [5, 15.02]);
    assert.equal(out[0].origin, SIMILAR_ORIGIN);
    assert.equal(out[0].label, 'Blackbird');
    assert.deepEqual(out[0].similar, { sourceLabelId: 'ex', score: 0.9, sources: ['correlation'] });
    assert.deepEqual(out[1].similar.sources, ['correlation', 'BirdBox']);
    assert.equal(out[1].freqMin, 2300);

    const [copy] = adoptLabels([out[1]], 'own', new Date(0));
    assert.equal(copy.origin, 'manual');
    assert.equal(copy.similar, undefined);
    assert.deepEqual(copy.adoptedFrom, { id: 's2', setId: 'sim', origin: SIMILAR_ORIGIN, similar: out[1].similar });
});
