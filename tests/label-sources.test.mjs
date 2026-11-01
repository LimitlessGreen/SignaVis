import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    OWN_SOURCE_ID, DEFAULT_LAYER_ID, isOwnLabel, labelSource, labelLayer, ownLayers, activeLayerId,
    asOwnLabel, migrateToOwnSource,
} from '../src/app/label-sources.ts';

const sets = () => new Map([
    ['set_a', { id: 'set_a', name: 'Mine', origin: 'manual', status: 'uploaded', license: 'CC-BY-4.0' }],
    ['set_b', { id: 'set_b', name: 'Second pass', origin: 'manual' }],
    ['xc1', { id: 'xc1', name: 'XC set', origin: 'xeno-canto', locked: true }],
    ['bn', { id: 'bn', name: 'BirdNET', origin: 'BirdNET', locked: true }],
]);

test('migrateToOwnSource: own set → own source, extra own sets → layers', () => {
    const s = sets();
    const recA = [{ id: 1, setId: 'set_a' }, { id: 2, setId: 'set_b' }, { id: 3, setId: 'xc1', readonly: true }];
    const active = [{ id: 4, origin: 'manual' }, { id: 5, setId: 'bn', origin: 'BirdNET' }];
    assert.equal(migrateToOwnSource(s, [recA, active], { preferredId: 'set_a' }), true);
    assert.deepEqual([...s.keys()].sort(), ['bn', 'own', 'xc1']);
    const own = s.get(OWN_SOURCE_ID);
    assert.equal(own.id, 'own');
    assert.equal(own.license, 'CC-BY-4.0', 'upload metadata kept');
    assert.deepEqual(own.legacyIds, ['set_a']);
    assert.deepEqual(ownLayers(s).map((x) => x.id), [DEFAULT_LAYER_ID, 'set_b']);
    assert.deepEqual(recA.map((l) => [l.setId, l.layer]), [['own', 'default'], ['own', 'set_b'], ['xc1', undefined]]);
    assert.deepEqual(active.map((l) => [l.setId, l.layer]), [['own', 'default'], ['bn', undefined]]);
    assert.equal(migrateToOwnSource(s, [recA, active]), false, 'idempotent');
    // labels restored later from old storage still find the own source
    const late = [{ id: 9, setId: 'set_a' }];
    migrateToOwnSource(s, [late]);
    assert.equal(late[0].setId, 'own');
});

test('migrateToOwnSource creates the own entry when missing', () => {
    const s = new Map([['xc1', { id: 'xc1', origin: 'xeno-canto', locked: true }]]);
    migrateToOwnSource(s, [], { create: () => ({ id: 'set_new', name: 'My Annotations', origin: 'manual' }) });
    assert.equal(s.get('own').name, 'My Annotations');
    assert.equal(s.has('set_new'), false);
});

test('labelSource / isOwnLabel / labelLayer', () => {
    const s = sets();
    assert.equal(labelSource({ setId: 'own' }, s), 'own');
    assert.equal(labelSource({ setId: 'xc1' }, s), 'xc-set:xc1');
    assert.equal(labelSource({ setId: 'bn' }, s), 'birdnet');
    assert.equal(labelSource({ setId: 'f1', origin: 'file' }, s), 'file:f1');
    assert.ok(isOwnLabel({ origin: 'manual' }));
    assert.ok(!isOwnLabel({ readonly: true }));
    assert.equal(labelLayer({ setId: 'own' }), 'default');
    assert.equal(labelLayer({ setId: 'xc1' }), null);
});

test('layers: active layer and asOwnLabel', () => {
    const s = new Map([['own', { id: 'own', origin: 'manual', layers: [{ id: 'default', name: 'Default' }, { id: 'B', name: 'B' }], activeLayerId: 'B' }]]);
    assert.equal(activeLayerId(s), 'B');
    assert.deepEqual(asOwnLabel({ id: 1, setId: 'xc1' }, s), { id: 1, setId: 'own', layer: 'B' });
    assert.equal(asOwnLabel({ id: 2, setId: 'own', layer: 'default' }, s).layer, 'default');
    s.get('own').activeLayerId = 'gone';
    assert.equal(activeLayerId(s), 'default');
});

test('layer editing: add, rename, activate, remove (labels move to default)', async () => {
    const { addLayer, renameLayer, setActiveLayer, removeLayer } = await import('../src/app/label-sources.ts');
    const s = new Map([['own', { id: 'own', origin: 'manual' }]]);
    const b = addLayer(s, ' Second pass ');
    assert.equal(b.name, 'Second pass');
    assert.equal(activeLayerId(s), b.id);
    assert.ok(renameLayer(s, b.id, 'Annotator B'));
    assert.equal(ownLayers(s)[1].name, 'Annotator B');
    assert.ok(setActiveLayer(s, 'default'));
    assert.ok(!setActiveLayer(s, 'nope'));
    const labels = [{ setId: 'own', layer: b.id }, { setId: 'xc', layer: b.id }];
    setActiveLayer(s, b.id);
    assert.equal(removeLayer(s, b.id, [labels]), 1);
    assert.deepEqual(labels.map((l) => l.layer), ['default', b.id]);
    assert.equal(activeLayerId(s), 'default');
    assert.equal(removeLayer(s, 'default', [labels]), -1);
    assert.equal(addLayer(new Map(), 'x'), null);
});

test('layer annotator: upload fields only for own labels on that layer', async () => {
    const { addLayer, setLayerAnnotator, layerAnnotatorFields } = await import('../src/app/label-sources.ts');
    const s = new Map([['own', { id: 'own', origin: 'manual' }]]);
    const b = addLayer(s, 'B');
    assert.ok(setLayerAnnotator(s, b.id, ' Jane Doe ', 'ABC'));
    assert.deepEqual(layerAnnotatorFields(s, { setId: 'own', layer: b.id }), { author: 'Jane Doe', annotatorXcId: 'ABC' });
    assert.equal(layerAnnotatorFields(s, { setId: 'own', layer: 'default' }), null);
    assert.equal(layerAnnotatorFields(s, { setId: 'xc', layer: b.id }), null);
    setLayerAnnotator(s, b.id, '');
    assert.equal(layerAnnotatorFields(s, { setId: 'own', layer: b.id }), null);
    assert.equal(setLayerAnnotator(s, 'nope', 'x'), false);
});
