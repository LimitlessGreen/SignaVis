// AnuraPAM model folder (fetched with `npm run models:anurapam`): a TF.js graph model the
// TF.js worker can load like BirdNET v2.4. Skipped when the model was not fetched.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';

const dir = new URL('../models/anurapam/', import.meta.url);
const skip = !existsSync(new URL('model.json', dir)) && 'models/anurapam not fetched';
const read = (f) => JSON.parse(readFileSync(new URL(f, dir), 'utf8'));

test('model.json is a graph model with 3 s of 48 kHz in and one score per label out', { skip }, () => {
    const m = read('model.json');
    assert.equal(m.format, 'graph-model');
    assert.deepEqual(Object.values(m.signature.inputs)[0].tensorShape.dim.map((d) => d.size), ['-1', '144000']);
    const out = Object.values(m.signature.outputs)[0];
    assert.equal(out.tensorShape.dim[1].size, String(read('labels.json').length));
    for (const p of m.weightsManifest.flatMap((g) => g.paths)) assert.ok(existsSync(new URL(p, dir)), p);
});

test('labels.json keeps the BirdNET v2.4 birds and ends with the 14 anurans', { skip }, () => {
    const labels = read('labels.json');
    assert.equal(labels.length, 6522 + 14);
    const frogs = labels.slice(-14).map((l) => l.split('_')[0]);
    assert.ok(frogs.includes('Rana temporaria'));
    assert.ok(frogs.includes('Pelophylax esculentus'), 'taxonomy spelling without "kl."');
    assert.equal(labels[0], read('../birdnet-v2.4/labels.json')[0]);
});
