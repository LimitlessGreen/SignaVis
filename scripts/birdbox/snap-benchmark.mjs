#!/usr/bin/env node
/**
 * "Snap to call" by click: region growing (src/domain/snapToCall.ts) against BirdBox boxes,
 * measured on recordings with Raven selection tables (one box per sound, e.g. Powdermill,
 * https://doi.org/10.1002/ecy.3329; 32 kHz mono 16-bit WAV).
 *
 * For every annotated box the click is its loudest cell above the band floor. Region growing
 * runs as in the app (default sensitivity, analysed span widened while the call touches its
 * edge); BirdBox answers with its most confident fused box under the click.
 *
 *   node --import tsx scripts/birdbox/snap-benchmark.mjs [--conf=0.15] [--gap=0.05] [--cache=/tmp/bb-rows] <a.wav> <a.selections.txt> [...]
 * Needs models/birdbox-just-bird (npm run models:birdbox).
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { basename } from 'node:path';
import { BirdBoxGraph } from '../../src/infrastructure/detector/birdboxGraph.ts';
import { fuseBoxes } from '../../src/domain/detector/fusion.ts';
import { snapToCall, bandMedians, SNAP_DEFAULT_SENSITIVITY } from '../../src/domain/snapToCall.ts';
import { computeSnapPatch } from '../../src/app/snapPatch.ts';
import { initWasmMain } from '../../src/infrastructure/wasm-dsp/wasmMain.ts';

const args = process.argv.slice(2);
const opt = (k, d) => args.find(a => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
const files = args.filter(a => !a.startsWith('--'));
const CONFS = opt('conf', '0.15').split(',').map(Number), GAPS = opt('gap', '0.05').split(',').map(Number);
const CACHE = opt('cache', '');
const root = new URL('../../', import.meta.url);
const modelDir = new URL(opt('model', 'models/birdbox-just-bird/'), root);

initWasmMain(new WebAssembly.Module(readFileSync(new URL('src/infrastructure/wasm-dsp/pkg/aw_dsp_wasm_bg.wasm', root))));
const require = createRequire(import.meta.url);
const ort = await import(require.resolve('onnxruntime-web').replace(/ort\.[^/]*$/, 'ort.wasm.min.mjs'));
ort.env.wasm.numThreads = 1;
ort.env.logLevel = 'error';
let graph = null;
async function rawRows(wav, audio) {
    const file = CACHE ? `${CACHE}/${basename(wav)}.rows.f32` : '';
    if (file && existsSync(file)) {
        const b = readFileSync(file);
        const data = new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
        return { data, rows: data.length / 9 };
    }
    graph ??= await BirdBoxGraph.create(ort, {
        spectrogram: readFileSync(new URL('spectrogram.onnx', modelDir)),
        detect: readFileSync(new URL('detect.onnx', modelDir)),
    }, { executionProviders: ['wasm'], graphOptimizationLevel: 'all' }, JSON.parse(readFileSync(new URL('model_config.json', modelDir))));
    const chunks = [];
    for await (const c of graph.run(audio, 0.05, 4)) chunks.push(c);
    const data = new Float32Array(chunks.reduce((s, c) => s + c.rows * 9, 0));
    let o = 0;
    for (const c of chunks) { data.set(c.data.subarray(0, c.rows * 9), o); o += c.rows * 9; }
    if (file) { mkdirSync(CACHE, { recursive: true }); writeFileSync(file, Buffer.from(data.buffer)); }
    return { data, rows: o / 9 };
}

function readWav(path) {
    const buf = readFileSync(path), dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    let ch = 1, sr = 0;
    for (let p = 12; p + 8 <= buf.length;) {
        const id = buf.toString('ascii', p, p + 4), size = dv.getUint32(p + 4, true);
        if (id === 'fmt ') { ch = dv.getUint16(p + 10, true); sr = dv.getUint32(p + 12, true); }
        if (id === 'data') {
            const n = Math.floor(Math.min(size, buf.length - p - 8) / (2 * ch)), out = new Float32Array(n);
            for (let i = 0; i < n; i++) {
                let s = 0;
                for (let c = 0; c < ch; c++) s += dv.getInt16(p + 8 + (i * ch + c) * 2, true) / 32768;
                out[i] = s / ch;
            }
            if (sr !== 32000) throw new Error(`${path}: ${sr} Hz, BirdBox needs 32 kHz`);
            return out;
        }
        p += 8 + size + (size & 1);
    }
    throw new Error('no data chunk');
}

function readSelections(path) {
    const [head, ...lines] = readFileSync(path, 'utf8').split(/\r?\n/).filter(Boolean);
    const cols = head.split('\t'), at = (n) => cols.indexOf(n);
    const [b, e, lo, hi] = [at('Begin Time (s)'), at('End Time (s)'), at('Low Freq (Hz)'), at('High Freq (Hz)')];
    return lines.map((l) => l.split('\t')).map((c) => ({ start: +c[b], end: +c[e], freqMin: +c[lo], freqMax: +c[hi] }))
        .filter((g) => g.end > g.start && g.freqMax > g.freqMin);
}

const ov = (a0, a1, b0, b1) => Math.max(0, Math.min(a1, b1) - Math.max(a0, b0));
/** IoU, share of the answer inside the truth, share of the truth covered. */
function score(box, gt) {
    const inter = ov(box.start, box.end, gt.start, gt.end) * ov(box.freqMin, box.freqMax, gt.freqMin, gt.freqMax);
    const a = (box.end - box.start) * (box.freqMax - box.freqMin), g = (gt.end - gt.start) * (gt.freqMax - gt.freqMin);
    return { iou: inter / (a + g - inter), inside: a ? inter / a : 0, covered: inter / g,
        tIou: ov(box.start, box.end, gt.start, gt.end) / (Math.max(box.end, gt.end) - Math.min(box.start, gt.start)) };
}

/** The click: loudest cell above the band floor inside the annotated box. */
function clickFor(audio, gt) {
    const mid = (gt.start + gt.end) / 2;
    const patch = computeSnapPatch(audio, mid, Math.max(1.5, (gt.end - gt.start) / 2 + 0.5));
    if (!patch) return null;
    const floor = bandMedians(patch);
    let best = -Infinity, time = mid, freq = (gt.freqMin + gt.freqMax) / 2;
    for (let f = 0; f < patch.frames; f++) {
        const t = patch.t0 + f * patch.dt;
        if (t < gt.start || t > gt.end) continue;
        for (let b = 0; b < patch.bins; b++) {
            const hz = patch.f0 + b * patch.df;
            if (hz < gt.freqMin || hz > gt.freqMax) continue;
            const v = patch.values[f * patch.bins + b] - floor[b];
            if (v > best) { best = v; time = t; freq = hz; }
        }
    }
    return { time, freq, snr: best };
}

function classicSnap(audio, time, freq) {
    let result = null;
    for (let half = 1.5; half <= 12; half *= 2) {
        const patch = computeSnapPatch(audio, time, half);
        if (!patch) break;
        result = snapToCall(patch, time, freq, SNAP_DEFAULT_SENSITIVITY, bandMedians(patch));
        if (!result.ok || !result.touchesEdge) break;
    }
    return result?.ok ? result.box : null;
}

const rows = [];   // { snr, classic, bb: { 'conf|gap': score|null } }
for (let i = 0; i + 1 < files.length; i += 2) {
    const samples = readWav(files[i]), truth = readSelections(files[i + 1]);
    const audio = { sampleRate: 32000, length: samples.length, numberOfChannels: 1, getChannelData: () => samples };
    const t = performance.now();
    const raw = await rawRows(files[i], samples);
    const fused = {};
    for (const c of CONFS) for (const g of GAPS) {
        fused[`${c}|${g}`] = fuseBoxes(raw.data, raw.rows, c, g).map((b) => ({ start: b.t0, end: b.t1, freqMin: b.flo, freqMax: b.fhi, conf: b.max }));
    }
    for (const gt of truth) {
        const click = clickFor(audio, gt);
        if (!click) continue;
        const cl = classicSnap(audio, click.time, click.freq);
        const bb = {};
        for (const [k, boxes] of Object.entries(fused)) {
            const hit = boxes.filter((b) => click.time >= b.start && click.time <= b.end && click.freq >= b.freqMin && click.freq <= b.freqMax)
                .sort((a, b) => b.conf - a.conf)[0];
            bb[k] = hit ? score(hit, gt) : null;
        }
        rows.push({ snr: click.snr, dur: gt.end - gt.start, classic: cl ? score(cl, gt) : null, bb });
    }
    console.error(`${basename(files[i])}: ${truth.length} boxes, ${raw.rows} raw rows (${((performance.now() - t) / 1000).toFixed(0)} s)`);
}

const median = (xs) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[s.length >> 1] : NaN; };
function line(name, scores) {
    const got = scores.filter(Boolean), n = scores.length;
    const pct = (x) => `${(100 * x).toFixed(0)} %`.padStart(5);
    return `${name.padEnd(26)} box ${pct(got.length / n)} | IoU≥0.5 ${pct(got.filter((s) => s.iou >= 0.5).length / n)} | median IoU ${median(got.map((s) => s.iou)).toFixed(2)}`
        + ` time-IoU ${median(got.map((s) => s.tIou)).toFixed(2)} | inside truth ${median(got.map((s) => s.inside)).toFixed(2)} | truth covered ${median(got.map((s) => s.covered)).toFixed(2)}`;
}
const snrs = rows.map((r) => r.snr).sort((a, b) => a - b), q1 = snrs[Math.floor(snrs.length / 3)], q2 = snrs[Math.floor(2 * snrs.length / 3)];
const groups = [['all', () => true], [`quiet (< ${q1.toFixed(0)} dB)`, (r) => r.snr < q1], [`middle`, (r) => r.snr >= q1 && r.snr < q2], [`loud (≥ ${q2.toFixed(0)} dB)`, (r) => r.snr >= q2]];
for (const [name, pick] of groups) {
    const sel = rows.filter(pick);
    console.log(`\n${name}: ${sel.length} annotated boxes`);
    console.log(line('region growing', sel.map((r) => r.classic)));
    for (const k of Object.keys(rows[0]?.bb || {})) console.log(line(`BirdBox conf|gap ${k}`, sel.map((r) => r.bb[k])));
}
