// ═══════════════════════════════════════════════════════════════════════
// v2-bin-frequencies.test.mjs — The frequency axis uses v2BinFrequencies()
// instead of a worker round trip, so it must match the Rust engine exactly.
// ═══════════════════════════════════════════════════════════════════════

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { v2BinFrequencies, wasmV2ParamsFromDspOptions } from '../src/app/WasmTileManager.ts';
import { CoordinateSystem } from '../src/domain/coordinateSystem.ts';
import { buildCQTFrequencies } from '../src/domain/dsp.ts';
import { CQT_FMIN, CQT_BINS_PER_OCTAVE } from '../src/shared/constants.ts';
import { initSync, WasmStft } from '../src/infrastructure/wasm-dsp/pkg/aw_dsp_wasm.js';

initSync({ module: fs.readFileSync(new URL('../src/infrastructure/wasm-dsp/pkg/aw_dsp_wasm_bg.wasm', import.meta.url)) });

const base = { windowSize: 1024, hopSize: 256, fftSize: 2048, windowFunction: 'hann', usePcen: false };

function wasmFreqs(params, sampleRate) {
    const p = { ...params, sampleRate };
    if (p.scale.kind !== 'linear' && !(p.scale.fMax > 0)) p.scale = { ...p.scale, fMax: sampleRate / 2 };
    const stft = new WasmStft(JSON.stringify(p));
    try { return stft.binFrequencies(); } finally { stft.free(); }
}

for (const sr of [22050, 44100, 48000]) {
    const cqtBands = Math.floor(Math.log2((sr / 2) / CQT_FMIN) * CQT_BINS_PER_OCTAVE - 1e-9);
    for (const [scale, nMels] of [['linear', 160], ['mel', 160], ['cqt', cqtBands]]) {
        test(`v2BinFrequencies matches WASM (${scale}, ${sr} Hz)`, () => {
            const params = wasmV2ParamsFromDspOptions({ ...base, scale, nMels });
            const ts = v2BinFrequencies(params, sr);
            const rs = wasmFreqs(params, sr);
            assert.equal(ts.length, rs.length);
            for (let i = 0; i < ts.length; i++) {
                assert.ok(Math.abs(ts[i] - rs[i]) <= 1e-9 * Math.max(1, rs[i]), `row ${i}: ${ts[i]} vs ${rs[i]}`);
            }
        });
    }
}

test('log bands keep the CQT axis', () => {
    const sr = 44100;
    const bands = Math.floor(Math.log2((sr / 2) / CQT_FMIN) * CQT_BINS_PER_OCTAVE - 1e-9);
    const params = wasmV2ParamsFromDspOptions({ ...base, scale: 'cqt', nMels: bands });
    const ts = v2BinFrequencies(params, sr);
    const cqt = buildCQTFrequencies(bands, CQT_FMIN, CQT_BINS_PER_OCTAVE);
    for (let i = 0; i < bands; i++) assert.ok(Math.abs(ts[i] / cqt[i] - 1) < 1e-6);
    assert.ok(params.scale.fMax <= sr / 2);
});

test('CoordinateSystem maps engine bin frequencies exactly', () => {
    const sr = 44100;
    const params = wasmV2ParamsFromDspOptions({ ...base, scale: 'mel', nMels: 160 });
    const binFreqs = v2BinFrequencies(params, sr);
    const cs = new CoordinateSystem({
        sampleRate: sr, canvasHeight: 320, maxFreq: sr / 2, spectrogramMels: 160, scale: 'mel', binFreqs,
    });
    // Row k of the image (bottom = row 0) carries binFreqs[k].
    for (const k of [0, 40, 100, 159]) {
        const y = cs.frequencyToPixelY(binFreqs[k]);
        const expected = (159 - k) / 160 * 320;
        assert.ok(Math.abs(y - expected) < 1e-3, `bin ${k}: y ${y} vs ${expected}`);
        assert.ok(Math.abs(cs.pixelYToFrequency(y) - binFreqs[k]) < 1e-2);
    }
});

test('CoordinateSystem linear table uses k·sr/nFft, not nyquist/nBins', () => {
    const sr = 48000;
    const params = wasmV2ParamsFromDspOptions({ ...base, scale: 'linear', nMels: 160 });
    const binFreqs = v2BinFrequencies(params, sr);
    const cs = new CoordinateSystem({
        sampleRate: sr, canvasHeight: 1025, maxFreq: sr / 2, spectrogramMels: binFreqs.length, scale: 'linear', binFreqs,
    });
    const k = 512; // 12 kHz exactly
    assert.equal(binFreqs[k], 12000);
    assert.ok(Math.abs(cs.pixelYToFrequency(cs.frequencyToPixelY(12000)) - 12000) < 1e-6);
});
