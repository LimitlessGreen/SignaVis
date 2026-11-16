#!/usr/bin/env node
/**
 * Parity of BirdBoxGraph (src/infrastructure/detector/birdboxGraph.ts) with the whole
 * BirdBox graph: the stream's raw rows, a file one window at a time and a recording
 * pushed in uneven pieces, must equal raw_all of one run of the whole model
 * (tests/fixtures/birdbox-fusion, from make-fusion-fixtures.mjs).
 *
 * Needs models/birdbox-just-bird (fetch-model.mjs) and the fixture's audio:
 *   node --import tsx scripts/birdbox/stream-parity.mjs --audio=<BirdBox>/tests/test.wav [--name=test-120s]
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { BirdBoxGraph } from '../../src/infrastructure/detector/birdboxGraph.ts';
import { BlockSource } from '../../src/domain/detector/birdboxStream.ts';

const args = process.argv.slice(2);
const opt = (k, d) => args.find(a => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
const AUDIO = opt('audio');
if (!AUDIO) throw new Error('--audio=<BirdBox>/tests/test.wav is required');
const NAME = opt('name', 'test-120s');
const root = new URL('../../', import.meta.url);
const fx = JSON.parse(readFileSync(new URL(`tests/fixtures/birdbox-fusion/${NAME}.json`, root)));
const refBytes = readFileSync(new URL(`tests/fixtures/birdbox-fusion/${fx.rawFile}`, root));
const ref = new Float32Array(refBytes.buffer.slice(refBytes.byteOffset, refBytes.byteOffset + refBytes.byteLength));

const require = createRequire(import.meta.url);
const ort = await import(opt('ort', require.resolve('onnxruntime-web').replace(/ort\.[^/]*$/, 'ort.wasm.min.mjs')));
if (fx.source.onnxruntimeWeb && fx.source.onnxruntimeWeb !== ort.env.versions?.web) {
    console.warn(`fixture made with onnxruntime-web ${fx.source.onnxruntimeWeb}, running ${ort.env.versions?.web}: FP16 rows may differ`);
}
ort.env.wasm.numThreads = 1;
ort.env.logLevel = 'error';

function readWav(path, seconds) {
    const buf = readFileSync(path), dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    let ch = 1;
    for (let p = 12; p + 8 <= buf.length;) {
        const id = buf.toString('ascii', p, p + 4), size = dv.getUint32(p + 4, true);
        if (id === 'fmt ') ch = dv.getUint16(p + 10, true);
        if (id === 'data') {
            const n = Math.min(Math.floor(size / (2 * ch)), seconds * 32000), out = new Float32Array(n);
            for (let i = 0; i < n; i++) {
                let s = 0;
                for (let c = 0; c < ch; c++) s += dv.getInt16(p + 8 + (i * ch + c) * 2, true) / 32768;
                out[i] = s / ch;
            }
            return out;
        }
        p += 8 + size + (size & 1);
    }
    throw new Error('no data chunk');
}

const dir = new URL('models/birdbox-just-bird/', root);
const config = JSON.parse(readFileSync(new URL('model_config.json', dir)));
const graph = await BirdBoxGraph.create(ort, {
    spectrogram: readFileSync(new URL('spectrogram.onnx', dir)),
    detect: readFileSync(new URL('detect.onnx', dir)),
}, { executionProviders: ['wasm'], graphOptimizationLevel: 'all' }, config);
const audio = readWav(AUDIO, fx.source.seconds);
const RAW_CONF = 0.05;

function compare(name, data, rows, skipFileEnd = false) {
    let dev = rows === fx.rawRows ? 0 : Infinity;
    for (let i = 0; dev < Infinity && i < rows * 9; i++) {
        if (skipFileEnd && i % 9 === 8) continue;
        dev = Math.max(dev, Math.abs(data[i] - ref[i]) / Math.max(1, Math.abs(ref[i])));
    }
    const ok = dev <= 1e-5;
    console.log(`${ok ? 'PASS' : 'FAIL'} ${name}: ${rows} rows (graph ${fx.rawRows}), max rel deviation ${dev}`);
    return ok;
}

const concat = chunks => {
    const out = new Float32Array(chunks.reduce((s, c) => s + c.rows * 9, 0));
    let o = 0;
    for (const c of chunks) { out.set(c.data.subarray(0, c.rows * 9), o); o += c.rows * 9; }
    return { data: out, rows: o / 9 };
};

let ok = true;
// 1. A file one window at a time, from an array
{
    const t = performance.now(), chunks = [];
    for await (const c of graph.run(audio, RAW_CONF, 1)) chunks.push(c);
    const { data, rows } = concat(chunks);
    ok = compare(`file, 1 window per run (${((performance.now() - t) / 1000).toFixed(1)} s)`, data, rows) && ok;
}
// 2. A file from a BlockSource (as in the worker), 4 windows per run
{
    const src = new BlockSource(audio.length, (from, to) => queueMicrotask(() => src.receive({ from, data: audio.slice(from, to) })));
    const chunks = [];
    for await (const c of graph.run(src, RAW_CONF, 4)) chunks.push(c);
    const { data, rows } = concat(chunks);
    ok = compare('file from BlockSource, 4 windows per run', data, rows) && ok;
}
// 3. A recording pushed in uneven pieces; windows as soon as they are ready
{
    const live = graph.live(), chunks = [];
    let seed = 3, next = 0;
    const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
    for (let i = 0; i < audio.length;) {
        const n = Math.min(audio.length - i, 500 + Math.floor(rnd() * 20000));
        live.push(audio.subarray(i, i + n));
        i += n;
        const ready = live.ready;
        if (ready > next) { const c = await live.windows(RAW_CONF, next, Math.min(8, ready - next)); chunks.push(c); next = c.next; }
    }
    while (next < live.ready) { const c = await live.windows(RAW_CONF, next, Math.min(8, live.ready - next)); chunks.push(c); next = c.next; }
    const { data, rows } = concat(chunks);
    ok = compare('live, uneven pieces (file end NO_END, not compared)', data, rows, true) && ok;
}
console.log(ok ? 'All checks passed.' : 'Some checks FAILED.');
process.exit(ok ? 0 : 1);
