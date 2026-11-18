// AnuraPAM model folder (fetched with `npm run models:anurapam`): a TF.js graph model the
// TF.js worker can load like BirdNET v2.4. Skipped when the model was not fetched.
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

test('model.json is a graph model with 3 s of 48 kHz in and one score per label out', { skip }, () => {
    const m = read('model.json');
    assert.equal(m.format, 'graph-model');
    assert.deepEqual(Object.values(m.signature.inputs)[0].tensorShape.dim.map((d) => d.size), ['-1', '144000']);
    const out = Object.values(m.signature.outputs)[0];
    assert.equal(out.tensorShape.dim[1].size, String(read('labels.json').length));
    for (const p of m.weightsManifest.flatMap((g) => g.paths)) assert.ok(existsSync(new URL(p, dir)), p);
});

test('labels.json is the BirdNET v2.4 labels in order, then the 14 anurans in order', { skip }, () => {
    const labels = read('labels.json');
    assert.deepEqual(labels.slice(0, 6522), read('../birdnet-v2.4/labels.json'));
    // "kl." dropped to match the taxonomy
    assert.deepEqual(labels.slice(6522).map((l) => l.split('_')[0]), ANURANS);
});
