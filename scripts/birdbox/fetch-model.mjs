#!/usr/bin/env node
/**
 * Fetch the BirdBox Just-Bird model and split it into the two streaming graphs
 * SignaVis runs (src/infrastructure/detector/birdboxGraph.ts):
 *
 *   spectrogram.onnx  audio -> db (n_mels, frames), sound (frames)
 *   detect.onnx       db, first_frame, times, conf, floor -> raw rows of the windows
 *
 * The model is pulled from a pinned BirdBox commit (the one the BirdNET website
 * pins), verified by SHA-256 and cached in .cache/birdbox/, so repeated builds are
 * offline. Output: models/birdbox-just-bird/ (gitignored; Pages CI runs this
 * before the demo build). Weights: AGPL-3.0, Copyright (c) 2025-2026 BirdNET-Team.
 *
 * Usage: node scripts/birdbox/fetch-model.mjs [--force] [--from=<local Just-Bird_fp16.onnx>]
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { modelMetadata, streamGraphs } from './lib/stream-graphs.mjs';

const ROOT = resolve(fileURLToPath(new URL('../../', import.meta.url)));
const CACHE = join(ROOT, '.cache/birdbox');
const OUT = join(ROOT, 'models/birdbox-just-bird');
const args = process.argv.slice(2);
const FORCE = args.includes('--force');
const FROM = args.find(a => a.startsWith('--from='))?.slice(7);

export const BIRDBOX = {
    repo: 'birdnet-team/BirdBox',
    commit: '24632a5560f6fd93959c2de157e94471be8ea0e7',
    file: 'Just-Bird_fp16.onnx',
    sha256: '34b5720cb4fb65d5201d9e9d7cecd3b670d4838552d2a84a6843964407f7e057',
};
const URL_ = `https://raw.githubusercontent.com/${BIRDBOX.repo}/${BIRDBOX.commit}/docs/models/${BIRDBOX.file}`;
const sha256 = buf => createHash('sha256').update(buf).digest('hex');

async function model() {
    if (FROM) {
        const buf = readFileSync(FROM);
        if (sha256(buf) !== BIRDBOX.sha256) throw new Error(`${FROM}: SHA-256 ${sha256(buf)}, expected ${BIRDBOX.sha256}`);
        return buf;
    }
    const cached = join(CACHE, `${BIRDBOX.sha256}.onnx`);
    if (!FORCE && existsSync(cached)) return readFileSync(cached);
    for (let attempt = 1; ; attempt++) {
        try {
            process.stdout.write(`downloading ${BIRDBOX.file} ... `);
            const res = await fetch(URL_);
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const buf = Buffer.from(await res.arrayBuffer());
            if (sha256(buf) !== BIRDBOX.sha256) throw new Error(`SHA-256 mismatch (${sha256(buf)})`);
            mkdirSync(CACHE, { recursive: true });
            writeFileSync(cached + '.part', buf);
            renameSync(cached + '.part', cached);
            console.log(`${(buf.length / 1048576).toFixed(1)} MB`);
            return buf;
        } catch (err) {
            console.log(`failed: ${err.message}`);
            if (attempt >= 3) throw err;
            await new Promise(r => setTimeout(r, 2000 * attempt));
        }
    }
}

const buf = await model();
const meta = modelMetadata(buf);
const floorWindowSeconds = +meta.floor_window_seconds, frameOrigin = +meta.frame_origin;
if (!(floorWindowSeconds > 0) || !Number.isInteger(frameOrigin)) throw new Error('BirdBox: the model has no rolling noise floor');
const { spectrogram, detect } = streamGraphs(buf);
mkdirSync(OUT, { recursive: true });
writeFileSync(join(OUT, 'spectrogram.onnx'), spectrogram);
writeFileSync(join(OUT, 'detect.onnx'), detect);
const config = {
    name: 'BirdBox Just-Bird (FP16)',
    source: `https://github.com/${BIRDBOX.repo}/tree/${BIRDBOX.commit}/docs/models`,
    sourceSha256: BIRDBOX.sha256,
    license: 'AGPL-3.0 (model weights), Copyright (c) 2025-2026 BirdNET-Team',
    sampleRate: 32000,
    spectrogram: { file: 'spectrogram.onnx', size: spectrogram.length, sha256: sha256(spectrogram) },
    detect: { file: 'detect.onnx', size: detect.length, sha256: sha256(detect) },
    classNames: { 0: 'bird' },
    merge: 'fusion',
    defaultConf: 0.15,
    defaultPhraseGap: 0.05,
    clipSeconds: 3,
    clipHopSeconds: 1.5,
    floorWindowSeconds,
    frameOrigin,
};
writeFileSync(join(OUT, 'model_config.json'), JSON.stringify(config, null, 2));
console.log(`BirdBox stream graphs -> ${OUT} (spectrogram ${(spectrogram.length / 1e6).toFixed(1)} MB, detect ${(detect.length / 1e6).toFixed(1)} MB; floor ${floorWindowSeconds} s, origin ${frameOrigin})`);
