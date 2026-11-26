#!/usr/bin/env node
/**
 * Write the manifest for the AnuraPAM classifier head (head.bin, written by
 * scripts/anurapam_head.py from the SavedModel).
 *
 * AnuraPAM ("Raw" export of a BirdNET-Analyzer custom classifier) computes
 *   sigmoid(concat(v2.4 logits, dense_1_2(relu(dense_1(v2.4 embeddings)))))
 * and its graph contains the BirdNET v2.4 backbone twice (once per signature).
 * SignaVis runs the bundled v2.4 model once and applies this head to its
 * embeddings (GLOBAL_AVG_POOL):
 *
 *   model.json  { format: "signavis-head", base, embeddingLayer, layers: [...], weightsFile }
 *   head.bin    float32 kernel/bias of each layer, in order
 *
 * Usage: node scripts/anurapam-head.mjs <dir with head.bin>
 */
import { statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const HEAD_LAYERS = [
    { name: 'dense_1', units: 1024, activation: 'relu', kernelShape: [1024, 1024] },
    { name: 'dense_1_2', units: 14, activation: 'linear', kernelShape: [1024, 14] },
];

export function headManifest() {
    return {
        format: 'signavis-head',
        base: '../birdnet-v2.4/',
        embeddingLayer: 'GLOBAL_AVG_POOL',
        baseLogitsLayer: 'CLASS_DENSE_LAYER',
        layers: HEAD_LAYERS,
        weightsFile: 'head.bin',
    };
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop())) {
    const dir = process.argv[2];
    if (!dir) { console.error('usage: anurapam-head.mjs <dir with head.bin>'); process.exit(2); }
    const values = HEAD_LAYERS.reduce((n, l) => n + l.kernelShape[0] * l.kernelShape[1] + l.units, 0);
    const size = statSync(join(dir, 'head.bin')).size;
    if (size !== values * 4) throw new Error(`head.bin: ${size} bytes, expected ${values * 4}`);
    writeFileSync(join(dir, 'model.json'), JSON.stringify(headManifest(), null, 1) + '\n');
}
