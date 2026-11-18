// ═══════════════════════════════════════════════════════════════════════
// similar-calls.test.mjs — "find similar calls": spectrogram correlation
// (domain/similar/ncc.ts), the band spectrogram of a recording, suggestion
// labels (app/suggest-similar.ts) and their provenance when copied.
// ═══════════════════════════════════════════════════════════════════════

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fft, nccCurve, pickPeaks, findSimilar, timeIoU, Reranker, createSearch, templateFrom, fitTemplate, findWithTemplate } from '../src/domain/similar/ncc.ts';
import { SimilarSession } from '../src/app/similarSpectrogram.ts';
import { bandSpectrogram } from '../src/app/similarSpectrogram.ts';
import { buildSuggestions, suggestionKey, searchBand, SIMILAR_ORIGIN, correctionOf, userEdited, hitMove, meanCorrection, applyCorrection } from '../src/app/suggest-similar.ts';
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
    assert.deepEqual(out[0].similar, { sourceLabelId: 'ex', score: 0.9, sources: ['correlation'], key: suggestionKey('Turdus merula', 5),
        found: { start: 5, end: 5.4, freqMin: 2000, freqMax: 3000 }, hit: out[0].similar.hit });
    assert.deepEqual(out[1].similar.sources, ['correlation', 'BirdBox']);
    assert.equal(out[1].freqMin, 2300);

    const [copy] = adoptLabels([out[1]], 'own', new Date(0));
    assert.equal(copy.origin, 'manual');
    assert.equal(copy.similar, undefined);
    assert.deepEqual(copy.adoptedFrom, { id: 's2', setId: 'sim', origin: SIMILAR_ORIGIN, similar: out[1].similar });
});

/** Noise spectrogram with type-A calls (rising sweep) and type-B calls (flat tone) at given frames. */
function twoTypes(frames, rows, a, b) {
    const r = rng(11), values = new Float32Array(rows * frames);
    for (let i = 0; i < values.length; i++) values[i] = 3 * r();
    for (const at of a) for (let t = 0; t < 40; t++) values[(20 + Math.round(t / 4)) * frames + at + t] += 20;
    for (const at of b) for (let t = 0; t < 40; t++) values[25 * frames + at + t] += 20;
    return { values, rows, frames, f0: 0, df: 100, t0: 0, dt: 0.01 };
}

test('Reranker: a rejected call type drops, an accepted one rises', () => {
    const A = [500, 1500, 2500], B = [1000, 2000, 3000];
    const spec = twoTypes(3600, 60, [100, ...A], B);
    const win = { r0: 17, r1: 34, c0: 100, c1: 140 };
    // Initial scores as if correlation had liked the B calls better
    const hits = [...B.map((f) => ({ frame: f, shift: 0, score: 0.6 })), ...A.map((f) => ({ frame: f, shift: 0, score: 0.5 }))]
        .map((h) => ({ ...h, start: h.frame * 0.01, end: h.frame * 0.01 + 0.4, freqMin: 1700, freqMax: 3300 }));
    const rr = new Reranker(spec, win, hits, 1);
    assert.ok(rr.similarity(0, 1) > 0.8, 'B calls are alike');
    assert.ok(rr.similarity(0, 3) < 0.6, 'A and B differ');
    const ranks = rr.decide(0, false);                       // reject one B
    assert.equal(ranks[0], -Infinity);
    for (const b of [1, 2]) for (const a of [3, 4, 5]) assert.ok(ranks[a] > ranks[b], `A ${a} above B ${b}`);
    const after = rr.decide(3, true);                        // accept one A
    for (const a of [4, 5]) assert.ok(after[a] > 0.8, 'accepted A lifts the other A calls');
});

test('Reranker: an accepted hit whose box was corrected compares from the corrected place', () => {
    const A = [500, 1500, 2500];
    const spec = twoTypes(3600, 60, [100, ...A], []);
    const win = { r0: 17, r1: 34, c0: 100, c1: 140 };
    // Hit 0 sits 30 frames early (the user drags it onto the call); hits 1, 2 are on the calls
    const hits = [470, 1500, 2500].map((f) => ({ frame: f, shift: 0, score: 0.4, start: f * 0.01, end: f * 0.01 + 0.4, freqMin: 1700, freqMax: 3300 }));
    const plain = new Reranker(spec, win, hits, 1).decide(0, true);
    const fixed = new Reranker(spec, win, hits, 1).decide(0, true, { dt: 0.3, df: 0 });
    for (const j of [1, 2]) assert.ok(fixed[j] > 0.8 && fixed[j] > plain[j] + 0.2, `corrected exemplar lifts call ${j}`);
    assert.equal(hits[0].frame, 470, 'the caller\'s hits stay as found');
});

test('corrections: only user edits count, measured from the box as found; re-rank move from the hit', () => {
    const found = { start: 1, end: 1.4, freqMin: 2000, freqMax: 4000 };
    assert.equal(correctionOf({ ...found, similar: { found } }), null, 'unchanged');
    const d = correctionOf({ start: 0.9, end: 1.5, freqMin: 2000, freqMax: 4500, similar: { found } });
    assert.deepEqual(Object.fromEntries(Object.entries(d).map(([k, v]) => [k, Math.round(v * 1000) / 1000])), { start: -0.1, end: 0.1, freqMin: 0, freqMax: 500 });
    // Moved by a carried-over correction, then copied untouched: no user edit, no re-rank move
    const shown = { start: 1.1, end: 1.5, freqMin: 2000, freqMax: 4000 };
    const carried = { ...shown, similar: { found, shown } };
    assert.equal(userEdited(carried), false);
    assert.equal(correctionOf(carried), null);
    assert.equal(hitMove(carried), undefined);
    // Edited after the carry-over: full offset from found
    const edited = { ...shown, end: 1.7, similar: { found, shown } };
    assert.ok(Math.abs(correctionOf(edited).end - 0.3) < 1e-9 && Math.abs(correctionOf(edited).start - 0.1) < 1e-9);
    // BirdBox refined the hit 15.00–15.40 to 15.10–15.50; the user moves it to 15.15–15.55: 0.15 s from the hit
    const hit = { start: 15, end: 15.4, freqMin: 2000, freqMax: 4000 }, bb = { start: 15.1, end: 15.5, freqMin: 2000, freqMax: 4000 };
    const m = hitMove({ start: 15.15, end: 15.55, freqMin: 2000, freqMax: 4000, similar: { found: bb, hit } });
    assert.ok(Math.abs(m.dt - 0.15) < 1e-9 && Math.abs(m.df) < 1e-9);
    const mean = meanCorrection([d, { start: -0.3, end: 0.1, freqMin: 0, freqMax: 0 }]);
    assert.ok(Math.abs(mean.start + 0.2) < 1e-9 && Math.abs(mean.freqMax - 250) < 1e-9);
    assert.equal(meanCorrection([]), null);
});

test('applyCorrection keeps the box inside the recording with a minimum size', () => {
    const b = applyCorrection({ start: 0.05, end: 0.2, freqMin: 100, freqMax: 7900 }, { start: -0.1, end: -0.5, freqMin: -200, freqMax: 500 }, 8000);
    assert.deepEqual(b, { start: 0, end: 0.01, freqMin: 0, freqMax: 8000 });
    // Both edges up past Nyquist: not inverted
    const up = applyCorrection({ start: 1, end: 2, freqMin: 7800, freqMax: 7900 }, { start: 0, end: 0, freqMin: 400, freqMax: 400 }, 8000);
    assert.ok(up.freqMin < up.freqMax && up.freqMax <= 8000 && up.freqMax - up.freqMin >= 10, JSON.stringify(up));
    // Past the end of the recording
    const late = applyCorrection({ start: 59.8, end: 59.95, freqMin: 1000, freqMax: 2000 }, { start: 0.3, end: 0.3, freqMin: 0, freqMax: 0 }, 8000, 60);
    assert.ok(late.start < late.end && late.end <= 60, JSON.stringify(late));
    // A recording shorter than the minimum box: the box is the whole recording, not longer
    const tiny = applyCorrection({ start: 0, end: 0.005, freqMin: 1000, freqMax: 2000 }, { start: 0, end: 0.01, freqMin: 0, freqMax: 0 }, 8000, 0.008);
    assert.ok(tiny.start === 0 && Math.abs(tiny.end - 0.008) < 1e-12, JSON.stringify(tiny));
    // A box that fits stays as moved
    assert.deepEqual(applyCorrection({ start: 1, end: 2, freqMin: 1000, freqMax: 2000 }, { start: 0.1, end: 0.2, freqMin: -100, freqMax: 100 }, 8000, 60),
        { start: 1.1, end: 2.2, freqMin: 900, freqMax: 2100 });
});

test('suggestions remember the box as found', () => {
    const sug = buildSuggestions({ id: 'ex', label: 'X', start: 0, end: 0.4, freqMin: 1000, freqMax: 2000 },
        [{ start: 5, end: 5.4, freqMin: 1000, freqMax: 2000, score: 0.7 }], { labels: [], setId: 's', newId: () => 'n1' });
    assert.deepEqual(sug[0].similar.found, { start: 5, end: 5.4, freqMin: 1000, freqMax: 2000 });
    assert.deepEqual(sug[0].similar.hit, { start: 5, end: 5.4, freqMin: 1000, freqMax: 2000 });
});

test('SimilarSession runs find + decide in place without workers', async () => {
    const spec = twoTypes(3600, 60, [100, 500, 1500], [1000]);
    const session = new SimilarSession();
    const hits = await session.find(spec, { start: 1, end: 1.4, freqMin: 2000, freqMax: 3000 }, { minScore: 0.3 });
    assert.ok(hits.length >= 2 && hits.every((h) => Number.isInteger(h.frame)));
    const ranks = await session.decide(0, true);
    assert.equal(ranks.length, hits.length);
    assert.equal(ranks[0], -Infinity);
    session.dispose();
    const st = createSearch(twoTypes(3600, 60, [100, 500], []), { start: 1, end: 1.4, freqMin: 2000, freqMax: 3000 }, { minScore: 0.3 });
    assert.equal(st.hits.length, st.reranker.ranks().length);
});

test('template from one recording finds the call in another, also at another sample rate', async () => {
    const chirps = (sr, ats, seed) => {
        const n = sr * 10, x = new Float32Array(n), r = rng(seed);
        for (let i = 0; i < n; i++) x[i] = 0.01 * r();
        for (const at of ats) {
            let ph = 0;
            for (let i = 0; i < 0.25 * sr; i++) {
                const t = i / sr;
                ph += 2 * Math.PI * (3000 + 4000 * t) / sr;
                x[Math.round(at * sr) + i] += 0.3 * Math.sin(ph) * Math.sin(Math.PI * t / 0.25);
            }
        }
        return { sampleRate: sr, length: n, numberOfChannels: 1, getChannelData: () => x };
    };
    const exemplar = { start: 2, end: 2.25, freqMin: 2900, freqMax: 4100 };
    const a = await bandSpectrogram(chirps(32000, [2], 1), ...searchBand(exemplar, 32000));
    const t = templateFrom(a, exemplar);
    assert.ok(t && t.rows > 5 && t.frames > 40);
    for (const sr of [32000, 48000]) {
        const b = await bandSpectrogram(chirps(sr, [1.5, 6.2], 2), ...searchBand(exemplar, sr));
        const fit = fitTemplate(t, b);
        assert.ok(Math.abs(fit.T * b.dt - t.frames * t.dt) < 2 * b.dt, `duration kept at ${sr} Hz`);
        const { hits } = findWithTemplate(b, t, { minScore: 0.3 });
        const starts = hits.map((h) => h.start).sort((x, y) => x - y);
        assert.equal(hits.length, 2, `${sr} Hz: ${starts}`);
        assert.ok(Math.abs(starts[0] - 1.5) < 0.03 && Math.abs(starts[1] - 6.2) < 0.03, `${sr} Hz: ${starts}`);
        const st = createSearch(b, { template: t }, { minScore: 0.3 });
        assert.equal(st.hits.length, 2);
        assert.equal(st.reranker.decide(0, true)[1] > 0.5, true);
    }
});

test('a rejection is checked against the correlation start, even when BirdBox moved the box', () => {
    const exemplar = { id: 'ex', label: 'Blackbird', start: 1, end: 1.4, freqMin: 2000, freqMax: 3000 };
    const hit = { start: 15.04, end: 15.44, freqMin: 2000, freqMax: 3000, score: 0.7 };
    const box = { start: 15.08, end: 15.4, freqMin: 2100, freqMax: 2900 };
    const opts = { labels: [exemplar], boxes: [box], setId: 'sim', newId: () => 's1' };
    const [sug] = buildSuggestions(exemplar, [hit], opts);
    assert.equal(sug.start, 15.08);                                    // bounds from BirdBox
    assert.equal(sug.similar.key, suggestionKey('Blackbird', 15.04));  // key from the correlation hit
    assert.equal(buildSuggestions(exemplar, [hit], { ...opts, rejected: new Set([sug.similar.key]) }).length, 0);
});

test('a template near the bottom of the band still searches with the shifts that fit', () => {
    const spec = spec_low();
    const t = { values: new Float32Array(3 * 40), rows: 3, frames: 40, f0: 100, df: 100, dt: 0.01, freqMin: 100, freqMax: 300 };
    for (let c = 0; c < 40; c++) t.values[1 * 40 + c] = 20;
    const { hits } = findWithTemplate(spec, t, { minScore: 0.3 });
    assert.ok(hits.some((h) => Math.abs(h.start - 2) < 0.02), JSON.stringify(hits.slice(0, 3)));
});

/** Template rows 1–3 of a 0-Hz-based spectrogram: r0 = 1 < shift 2, only shifts −1..2 fit. */
function spec_low() {
    const frames = 1000, rows = 20, r = rng(4), values = new Float32Array(rows * frames);
    for (let i = 0; i < values.length; i++) values[i] = 3 * r();
    for (let c = 0; c < 40; c++) values[2 * frames + 200 + c] += 20;
    return { values, rows, frames, f0: 0, df: 100, t0: 0, dt: 0.01 };
}

test('a template starting one row below the band is still searched when an upward shift fits', () => {
    const spec = spec_low();   // call on row 2
    // Template rows −1..1 (f0 = −100 Hz): only shifts +1, +2 place it inside the band
    const t = { values: new Float32Array(3 * 40), rows: 3, frames: 40, f0: -100, df: 100, dt: 0.01, freqMin: 0, freqMax: 100 };
    for (let c = 0; c < 40; c++) t.values[2 * 40 + c] = 20;   // its top row → row 1, +1 shift → row 2
    const { hits, win } = findWithTemplate(spec, t, { minScore: 0.3 });
    assert.equal(win.r0, -1);
    const h = hits.find((x) => Math.abs(x.start - 2) < 0.02);
    assert.ok(h && h.shift >= 1, JSON.stringify(hits.slice(0, 3)));
    // Nothing fits at all: no hits, no error
    assert.deepEqual(findWithTemplate(spec, { ...t, f0: -1000 }).hits, []);
});
