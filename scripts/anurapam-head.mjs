#!/usr/bin/env node
/**
 * Cut the anuran classifier head out of the converted AnuraPAM graph model.
 *
 * AnuraPAM ("Raw" export of a BirdNET-Analyzer custom classifier) computes
 *   sigmoid(concat(v2.4 logits, dense_1_2(relu(dense_1(v2.4 embeddings)))))
 * and its graph contains the BirdNET v2.4 backbone twice (once per signature).
 * SignaVis runs the bundled v2.4 model once and applies this head to its
 * embeddings (GLOBAL_AVG_POOL), so only the head weights are kept:
 *
 *   model.json  { format: "signavis-head", base, embeddingLayer, layers: [...], weightsFile }
 *   head.bin    float32 kernel/bias of each layer, in order
 *
 * Usage: node scripts/anurapam-head.mjs <tfjs graph model dir> <out dir>
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const P = 'StatefulPartitionedCall/combined_model_append_sigmoid_1/sequential_1/';
export const HEAD_LAYERS = [
    { name: 'dense_1', units: 1024, activation: 'relu' },
    { name: 'dense_1_2', units: 14, activation: 'linear' },
];

/** All weights of a TF.js model folder by name, as Float32Arrays. */
export function readWeights(dir) {
    const m = JSON.parse(readFileSync(join(dir, 'model.json'), 'utf8'));
    const out = new Map();
    for (const group of m.weightsManifest) {
        const buf = Buffer.concat(group.paths.map((p) => readFileSync(join(dir, p))));
        let off = 0;
        for (const w of group.weights) {
            const n = w.shape.reduce((a, b) => a * b, 1);
            const bytes = n * (w.dtype === 'float32' || w.dtype === 'int32' ? 4 : 1);
            if (w.dtype === 'float32') {
                out.set(w.name, { shape: w.shape, data: new Float32Array(buf.buffer.slice(buf.byteOffset + off, buf.byteOffset + off + bytes)) });
            }
            off += bytes;
        }
    }
    return out;
}

export function extractHead(graphDir) {
    const w = readWeights(graphDir);
    const parts = [];
    const layers = HEAD_LAYERS.map(({ name, units, activation }) => {
        const kernel = w.get(`${P}${name}/Cast/ReadVariableOp`);
        const bias = w.get(`${P}${name}/BiasAdd/ReadVariableOp`);
        if (!kernel || !bias) throw new Error(`AnuraPAM graph: ${name} weights not found`);
        if (kernel.shape[1] !== units || bias.shape[0] !== units) throw new Error(`AnuraPAM graph: ${name} has shape ${kernel.shape}`);
        parts.push(kernel.data, bias.data);
        return { name, units, activation, kernelShape: kernel.shape };
    });
    return { layers, data: Buffer.concat(parts.map((a) => Buffer.from(a.buffer, a.byteOffset, a.byteLength))) };
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop())) {
    const [src, out] = process.argv.slice(2);
    if (!src || !out) { console.error('usage: anurapam-head.mjs <graph dir> <out dir>'); process.exit(2); }
    const { layers, data } = extractHead(src);
    writeFileSync(join(out, 'head.bin'), data);
    writeFileSync(join(out, 'model.json'), JSON.stringify({
        format: 'signavis-head',
        base: '../birdnet-v2.4/',
        embeddingLayer: 'GLOBAL_AVG_POOL',
        baseLogitsLayer: 'CLASS_DENSE_LAYER',
        layers,
        weightsFile: 'head.bin',
    }, null, 1) + '\n');
    console.log(`head: ${layers.map((l) => `${l.kernelShape.join('x')} ${l.activation}`).join(' -> ')}, ${(data.length / 1048576).toFixed(1)} MB`);
}
