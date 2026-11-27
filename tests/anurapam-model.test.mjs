// AnuraPAM model folder (`npm run models:fetch -- anurapam`): the anuran classifier head the
// TF.js worker runs on the BirdNET v2.4 embeddings. Skipped when the model was not fetched.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';

const dir = new URL('../models/anurapam/', import.meta.url);
const skip = !existsSync(new URL('model.json', dir)) && 'models/anurapam not fetched';
const read = (f) => JSON.parse(readFileSync(new URL(f, dir), 'utf8'));

const ANURANS = [
    'Alytes obstetricans', 'Bombina bombina', 'Bombina variegata', 'Bufo bufo', 'Bufotes viridis',
    'Epidalea calamita', 'Hyla arborea', 'Pelobates fuscus', 'Pelophylax esculentus', 'Pelophylax lessonae',
    'Pelophylax ridibundus', 'Rana arvalis', 'Rana dalmatina', 'Rana temporaria',
];

test('model.json is a head on the v2.4 embeddings with one output per anuran', { skip }, () => {
    const m = read('model.json');
    assert.equal(m.format, 'signavis-head');
    const baseLayers = read(`${m.base}model.json`).modelTopology.model_config.config.layers.map((l) => l.config.name);
    assert.ok(baseLayers.includes(m.embeddingLayer) && baseLayers.includes(m.baseLogitsLayer));
    assert.deepEqual(m.layers.map((l) => l.kernelShape), [[1024, 1024], [1024, 14]]);
    const values = m.layers.reduce((n, l) => n + l.kernelShape[0] * l.kernelShape[1] + l.units, 0);
    assert.equal(readFileSync(new URL(m.weightsFile, dir)).length, values * 4);
    assert.equal(6522 + m.layers.at(-1).units, read('labels.json').length);
});

test('labels.json is the BirdNET v2.4 labels in order, then the 14 anurans in order', { skip }, () => {
    const labels = read('labels.json');
    assert.deepEqual(labels.slice(0, 6522), read('../birdnet-v2.4/labels.json'));
    // "kl." dropped to match the taxonomy
    assert.deepEqual(labels.slice(6522).map((l) => l.split('_')[0]), ANURANS);
});
