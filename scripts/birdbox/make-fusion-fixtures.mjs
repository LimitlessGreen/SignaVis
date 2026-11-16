#!/usr/bin/env node
/**
 * Reference data for src/domain/detector/fusion.ts: the BirdBox Just-Bird graph's
 * per-window boxes (raw_all, at the lowest confidence) and its own merged
 * detections for a grid of (confidence, phrase gap) settings. The graph's merge
 * is the ground truth; the TS port must reproduce it from raw_all alone.
 *
 * Needs a BirdBox checkout (https://github.com/birdnet-team/BirdBox) at the
 * commit the BirdNET website pins (for the model and its onnx-graph.js):
 *   node scripts/birdbox/make-fusion-fixtures.mjs --birdbox=/path/to/BirdBox \
 *        [--audio=x.wav] [--seconds=120] [--name=test-wav-120s]
 */
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const args = process.argv.slice(2);
const opt = (k, d) => args.find(a => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
const BB = resolve(opt('birdbox', ''));
if (!opt('birdbox')) throw new Error('--birdbox=<BirdBox checkout> is required');
const AUDIO = opt('audio', join(BB, 'tests/test.wav'));
const SECONDS = +opt('seconds', 120);
const NAME = opt('name', `${basename(AUDIO, '.wav')}-${SECONDS}s`);
const MODEL = join(BB, 'docs/models/Just-Bird_fp16.onnx');
const OUT = resolve(new URL('../../tests/fixtures/birdbox-fusion/', import.meta.url).pathname);

// The runtime SignaVis ships (package.json), unless --ort=<ort.wasm.min.mjs>: FP16 results differ
// slightly between runtime versions, and the stream parity needs the same one
const require = createRequire(import.meta.url);
const ORT = opt('ort', require.resolve('onnxruntime-web').replace(/ort\.[^/]*$/, 'ort.wasm.min.mjs'));
const ort = await import(pathToFileURL(ORT).href);
const { addGraphOutput, FLOAT } = await import(pathToFileURL(join(BB, 'docs/javascripts/demo/onnx-graph.js')).href);

function readWav(path) {
  const buf = readFileSync(path), dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let fmt;
  for (let p = 12; p + 8 <= buf.length;) {
    const id = buf.toString('ascii', p, p + 4), size = dv.getUint32(p + 4, true);
    if (id === 'fmt ') fmt = { ch: dv.getUint16(p + 10, true), rate: dv.getUint32(p + 12, true), bits: dv.getUint16(p + 22, true) };
    if (id === 'data') {
      if (fmt?.rate !== 32000 || fmt.bits !== 16) throw new Error('needs 16-bit PCM at 32 kHz');
      const n = Math.floor(size / (2 * fmt.ch)), out = new Float32Array(n);
      for (let i = 0; i < n; i++) {
        let s = 0;
        for (let c = 0; c < fmt.ch; c++) s += dv.getInt16(p + 8 + (i * fmt.ch + c) * 2, true) / 32768;
        out[i] = s / fmt.ch;
      }
      return out;
    }
    p += 8 + size + (size & 1);
  }
  throw new Error('no data chunk');
}

const CONFS = [0.05, 0.15, 0.3, 0.5];
const GAPS = [0, 0.05, 0.3, 1];
const modelBytes = readFileSync(MODEL);
const audio = readWav(AUDIO).slice(0, SECONDS * 32000);
ort.env.wasm.numThreads = 1;
ort.env.logLevel = 'error';
const session = await ort.InferenceSession.create(
  addGraphOutput(new Uint8Array(modelBytes), 'raw_all', FLOAT, ['num_raw', 9]),
  { executionProviders: ['wasm'], graphOptimizationLevel: 'all' });
const feeds = (conf, gap) => ({
  audio: new ort.Tensor('float32', audio.slice(), [audio.length]),
  conf: new ort.Tensor('float32', Float32Array.of(conf), [1]),
  song_gap: new ort.Tensor('float32', Float32Array.of(gap), [1]),
});

const raw = (await session.run(feeds(0.05, 0), ['raw_all'])).raw_all;
const settings = [];
for (const conf of CONFS) for (const gap of GAPS) {
  const d = (await session.run(feeds(conf, gap), ['detections'])).detections;
  settings.push({ conf, gap, detections: Array.from({ length: d.dims[0] }, (_, i) => Array.from(d.data.subarray(i * 8, i * 8 + 8))) });
  console.log(`conf ${conf} gap ${gap}: ${d.dims[0]} boxes`);
}
mkdirSync(OUT, { recursive: true });
const rawData = new Float32Array(raw.data);
writeFileSync(join(OUT, `${NAME}.raw.f32`), Buffer.from(rawData.buffer));
writeFileSync(join(OUT, `${NAME}.json`), JSON.stringify({
  source: { audio: basename(AUDIO), seconds: SECONDS, model: basename(MODEL),
    modelSha256: createHash('sha256').update(modelBytes).digest('hex'),
    onnxruntimeWeb: ort.env.versions?.web },
  columns: ['t0', 't1', 'flo', 'fhi', 'avg', 'max', 'n', 'cls'],
  rawRows: raw.dims[0], rawFile: `${NAME}.raw.f32`, settings,
}));
console.log(`${raw.dims[0]} raw rows -> ${OUT}/${NAME}.*`);
