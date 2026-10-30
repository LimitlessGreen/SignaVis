// ═══════════════════════════════════════════════════════════════════════
// visual-xc204513.test.mjs — Visual regression of the default (XC) sonogram
//
// Renders XC 204513 (Zosterops borbonicus, xeno-canto.org/204513) with the
// XC preset through the Rust engine (WASM) and the display mapping, and
// compares the image with an approved reference.
//
// The recording is not redistributed: place it as a WAV at
//   tests/fixtures/local/XC204513.wav  (or set AW_XC204513=<path>)
// e.g. `ffmpeg -i XC204513.mp3 -ac 1 -c:a pcm_f32le tests/fixtures/local/XC204513.wav`.
// Without it the test is skipped. After an intended change to the image,
// approve the new output with UPDATE_VISUAL=1 npm test.
// ═══════════════════════════════════════════════════════════════════════

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { wasmV2ParamsFromDspOptions } from '../src/app/WasmTileManager.ts';
import { buildSpectrogramGrayscale, noiseFloorStats } from '../src/domain/spectrogram.ts';
import { DSP_PROFILES, DB_CONTRAST, windowHopFromOverlap, fftSizeFromOversampling } from '../src/shared/constants.ts';
import { initSync, WasmStft } from '../src/infrastructure/wasm-dsp/pkg/aw_dsp_wasm.js';

const AUDIO = process.env.AW_XC204513 || new URL('./fixtures/local/XC204513.wav', import.meta.url);
const REFERENCE = new URL('./fixtures/xc204513/reference.pgm', import.meta.url);
/** Reference size: the image is box-averaged down to this. */
const REF_W = 960, REF_H = 256;

/** Mono samples of a 16-bit PCM or 32-bit float WAV (first channel). */
function readWav(buf) {
    let fmt = null;
    for (let o = 12; o + 8 <= buf.length;) {
        const id = buf.toString('ascii', o, o + 4), size = buf.readUInt32LE(o + 4);
        if (id === 'fmt ') {
            fmt = { format: buf.readUInt16LE(o + 8), channels: buf.readUInt16LE(o + 10),
                sampleRate: buf.readUInt32LE(o + 12), bits: buf.readUInt16LE(o + 22) };
        } else if (id === 'data' && fmt) {
            const step = fmt.channels * fmt.bits / 8;
            const n = Math.floor(size / step);
            const out = new Float32Array(n);
            for (let i = 0; i < n; i++) {
                const p = o + 8 + i * step;
                out[i] = fmt.bits === 32 ? buf.readFloatLE(p) : buf.readInt16LE(p) / 32768;
            }
            return { samples: out, sampleRate: fmt.sampleRate };
        }
        o += 8 + size + (size & 1);
    }
    throw new Error('unsupported WAV');
}

/** XC preset → v2 values for the whole file (frames × bins). */
function computeXc(samples, sampleRate) {
    const pr = DSP_PROFILES.xc;
    const params = wasmV2ParamsFromDspOptions({
        scale: pr.scale, colourScale: pr.colourScale, windowFunction: pr.windowFunction,
        windowSize: pr.windowSize,
        hopSize: windowHopFromOverlap(pr.windowSize, pr.overlapLevel),
        fftSize: fftSizeFromOversampling(pr.windowSize, pr.oversamplingLevel),
        nMels: pr.nMels, usePcen: pr.usePcen, reassigned: pr.reassigned,
    });
    const stft = new WasmStft(JSON.stringify({ ...params, sampleRate }));
    try {
        const total = stft.nFrames(samples.length);
        const [start] = stft.sampleRange(0, total);
        return { data: stft.blockValues(samples.subarray(Math.max(0, start)), Math.max(0, start), 0, total, total),
            frames: total, bins: stft.outBins() };
    } finally { stft.free(); }
}

/** Display image in [0, 1] with the default dB window, box-averaged to REF_W × REF_H. */
function render(samples, sampleRate) {
    const { data, frames, bins } = computeXc(samples, sampleRate);
    const noise = noiseFloorStats(data).logMin;
    const lo = noise + DB_CONTRAST.floor.def;
    const g = buildSpectrogramGrayscale({
        spectrogramData: data, spectrogramFrames: frames, spectrogramMels: bins,
        sampleRateHz: sampleRate, maxFreq: sampleRate / 2,
        spectrogramAbsLogMin: lo, spectrogramAbsLogMax: lo + DB_CONTRAST.range.def,
        scale: 'linear', colourScale: 'dbSquared',
    });
    const out = new Float32Array(REF_W * REF_H);
    for (let y = 0; y < REF_H; y++) {
        const y0 = Math.floor(y * g.height / REF_H), y1 = Math.max(y0 + 1, Math.floor((y + 1) * g.height / REF_H));
        for (let x = 0; x < REF_W; x++) {
            const x0 = Math.floor(x * g.width / REF_W), x1 = Math.max(x0 + 1, Math.floor((x + 1) * g.width / REF_W));
            let s = 0;
            for (let yy = y0; yy < y1; yy++) for (let xx = x0; xx < x1; xx++) s += g.gray[yy * g.width + xx];
            out[y * REF_W + x] = s / ((y1 - y0) * (x1 - x0));
        }
    }
    return out;
}

const writePgm = (url, img) => fs.writeFileSync(url, Buffer.concat([
    Buffer.from(`P5\n${REF_W} ${REF_H}\n255\n`, 'ascii'),
    Buffer.from(Uint8Array.from(img, (v) => Math.round(Math.min(1, Math.max(0, v)) * 255))),
]));

function readPgm(url) {
    const buf = fs.readFileSync(url);
    const m = /^P5\s+(\d+)\s+(\d+)\s+255\s/.exec(buf.toString('latin1', 0, 32));
    assert.ok(m && +m[1] === REF_W && +m[2] === REF_H, 'reference size');
    return Float32Array.from(buf.subarray(m[0].length), (v) => v / 255);
}

test('XC 204513 renders like the approved reference (XC preset)', { skip: !fs.existsSync(AUDIO) && 'XC204513.wav not present' }, () => {
    initSync({ module: fs.readFileSync(new URL('../src/infrastructure/wasm-dsp/pkg/aw_dsp_wasm_bg.wasm', import.meta.url)) });
    const { samples, sampleRate } = readWav(fs.readFileSync(AUDIO));
    const img = render(samples, sampleRate);
    if (process.env.UPDATE_VISUAL === '1' || !fs.existsSync(REFERENCE)) {
        writePgm(REFERENCE, img);
        return;
    }
    const ref = readPgm(REFERENCE);
    const diff = Float32Array.from(img, (v, i) => Math.abs(v - ref[i])).sort();
    const mean = diff.reduce((a, b) => a + b, 0) / diff.length;
    const p99 = diff[Math.floor(diff.length * 0.99)];
    // 8-bit reference: quantisation alone is ≤ 0.002.
    assert.ok(mean < 0.01, `mean abs difference ${mean.toFixed(4)}`);
    assert.ok(p99 < 0.06, `99th percentile difference ${p99.toFixed(4)}`);
});
