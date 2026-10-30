// Parity + single-thread speed of the wasm build vs. the JS reference.
// Run from Audio-Workbench/ after `wasm-pack build --target web`:
//   node src-tauri/crates/aw-dsp-wasm/tests/node-parity.mjs
import { readFileSync } from 'node:fs';
import { computeSpectrogram } from '../../../../src/domain/dsp.ts';
import init, { WasmEngine, WasmPyramidBuilder, decodeF16 } from '../pkg/aw_dsp_wasm.js';

const pkg = new URL('../pkg/', import.meta.url);
await init({ module_or_path: readFileSync(new URL('aw_dsp_wasm_bg.wasm', pkg)) });

const fx = new URL('../../aw-dsp/tests/fixtures/', import.meta.url);
const f32 = (name) => { const b = readFileSync(new URL(`${name}.f32`, fx)); return new Float32Array(b.buffer, b.byteOffset, b.byteLength / 4); };

const base = { sampleRate: 32000, fftSize: 2048, hopSize: 320, winLength: 1280, nMels: 160, scale: 'mel', window: 'hann' };
const pcen = { gain: 0.8, bias: 0.01, root: 4, smoothing: 0.025 };
const cases = {
    mel_pcen: { ...base, pcen },
    mel_db: { ...base, pcen: null },
    linear_db: { ...base, scale: 'linear', fftSize: 1024, winLength: 1024, hopSize: 512, pcen: null },
};

/** Same flow as the browser: blocks computed independently, finalized in order. */
function runBlocks(params, audio, block) {
    const eng = new WasmEngine(JSON.stringify(params));
    const total = eng.nFrames(audio.length);
    const out = new Float32Array(total * eng.outBins());
    for (let f0 = 0; f0 < total; f0 += block) {
        const n = Math.min(block, total - f0);
        const s0 = f0 * params.hopSize;
        const data = eng.bandEnergies(audio.subarray(s0, s0 + eng.samplesForFrames(n)), n);
        eng.finalize(data);
        out.set(data, f0 * eng.outBins());
    }
    eng.free();
    return out;
}

const audio = f32('audio');
let ok = true;
for (const [name, p] of Object.entries(cases)) {
    const want = f32(name);
    for (const block of [37, 5000]) {
        const got = runBlocks(p, audio, block);
        let lo = Infinity, hi = -Infinity, err = 0;
        for (let i = 0; i < want.length; i++) { lo = Math.min(lo, want[i]); hi = Math.max(hi, want[i]); err = Math.max(err, Math.abs(got[i] - want[i])); }
        const pass = got.length === want.length && err <= 1e-3 * (hi - lo);
        ok &&= pass;
        console.log(`${pass ? 'ok  ' : 'FAIL'} ${name} block=${block}: max err ${err.toExponential(2)} (range ${(hi - lo).toFixed(2)})`);
    }
}

// Pyramid builder round trip: level 0 decodes back to finalized values.
{
    const p = cases.mel_pcen;
    const ref = runBlocks(p, audio, 5000);
    const b = new WasmPyramidBuilder(JSON.stringify(p), audio.length);
    b.pushBlock(ref);
    const meta = JSON.parse(b.finish());
    const l0 = decodeF16(b.takeLevel(0));
    let err = 0;
    for (let i = 0; i < ref.length; i++) err = Math.max(err, Math.abs(l0[i] - ref[i]) / Math.max(1, Math.abs(ref[i])));
    const pass = l0.length === ref.length && err < 1e-3;
    ok &&= pass;
    console.log(`${pass ? 'ok  ' : 'FAIL'} pyramid: ${meta.levels.length} levels, f16 rel err ${err.toExponential(2)}`);
}

// Speed: 10 min synthetic, single thread, JS vs wasm.
{
    const SR = 32000, N = SR * 600;
    const long = new Float32Array(N);
    for (let i = 0; i < N; i++) long[i] = 0.3 * Math.sin(2 * Math.PI * (500 + (i % SR)) * i / SR) + 0.01 * Math.sin(i);
    let t = performance.now();
    computeSpectrogram({ channelData: long, sampleRate: SR, frameRate: 100, nMels: 160, fftSize: 2048, windowSize: 1280, hopSize: 320,
        pcenGain: 0.8, pcenBias: 0.01, pcenRoot: 4, pcenSmoothing: 0.025, usePcen: true, scale: 'mel' });
    const js = performance.now() - t;
    t = performance.now();
    runBlocks(cases.mel_pcen, long, 6000);
    const wasm = performance.now() - t;
    console.log(`10 min audio, 1 thread: JS ${(js / 1000).toFixed(2)} s, wasm ${(wasm / 1000).toFixed(2)} s → ${(js / wasm).toFixed(1)}×`);
}
process.exit(ok ? 0 : 1);
