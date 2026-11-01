import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    defaultUploadSelection, normalizeUploadSelection, uploadCandidates, selectUploadLabels,
    makeUploadSnapshot, snapshotState, labelsHash, uploadSourceOf,
} from '../src/app/upload-selection.ts';

const sets = new Map([['bn', { id: 'bn', origin: 'BirdNET' }], ['xcs', { id: 'xcs', origin: 'xeno-canto' }]]);
const entries = () => [
    { id: 'r1', xcId: 'XC1', filename: 'XC1.mp3', annotations: [
        { id: 'a', setId: 'own', layer: 'default', scientificName: 'Turdus merula', start: 1, end: 2 },
        { id: 'b', setId: 'own', layer: 'B', scientificName: 'Parus major', start: 3, end: 4 },
        { id: 'c', setId: 'bn', origin: 'BirdNET', scientificName: 'Turdus merula', start: 5, end: 6 },
        { id: 'd', setId: 'xcs', readonly: true, scientificName: 'Turdus merula', start: 7, end: 8 },
    ] },
    { id: 'r2', xcId: null, filename: 'local.wav', annotations: [{ id: 'e', setId: 'own', scientificName: 'Parus major', start: 0, end: 1 }] },
    { id: 'r3', xcId: 'XC3', annotations: [{ id: 'f', setId: 'xcs', readonly: true }] },
];

test('uploadSourceOf', () => {
    assert.equal(uploadSourceOf({ setId: 'own' }, sets), 'own');
    assert.equal(uploadSourceOf({ setId: 'bn' }, sets), 'birdnet');
    assert.equal(uploadSourceOf({ setId: 'xcs', readonly: true }, sets), null);
});

test('uploadCandidates: counts, local-only recordings not included', () => {
    const c = uploadCandidates(entries(), defaultUploadSelection(), sets);
    assert.deepEqual(c.recordings.map((r) => [r.id, r.own, r.birdnet, r.included]), [['r1', 2, 1, true], ['r2', 1, 0, false]]);
    assert.deepEqual([...c.species], [['Turdus merula', 1], ['Parus major', 1]]);
    assert.deepEqual([...c.layers], [['default', 1], ['B', 1]]);
});

test('selectUploadLabels: filters by recording, species, layer, source', () => {
    const sel = defaultUploadSelection();
    let r = selectUploadLabels(entries(), sel, sets);
    assert.deepEqual(r.items.map((x) => x.label.id), ['a', 'b']);
    assert.deepEqual(r.skipped.map((e) => e.id), ['r2']);
    r = selectUploadLabels(entries(), { ...sel, sources: ['own', 'birdnet'], excludedLayers: ['B'] }, sets);
    assert.deepEqual(r.items.map((x) => x.label.id), ['a', 'c']);
    r = selectUploadLabels(entries(), { ...sel, excludedSpecies: ['Turdus merula'], excludedRecordings: ['r2'] }, sets);
    assert.deepEqual(r.items.map((x) => x.label.id), ['b']);
    assert.equal(r.skipped.length, 0);
    assert.deepEqual(normalizeUploadSelection({ sources: ['x'] }).sources, ['own']);
});

test('snapshots detect edits and deletions', () => {
    const e = entries();
    const labels = [e[0].annotations[0], e[0].annotations[1]];
    const snap = makeUploadSnapshot(labels, [e[0]], { name: 'S', license: 'CC-BY-4.0', env: 'acc' }, new Date('2026-11-01T00:00:00Z'));
    assert.deepEqual(snap.recordings, ['XC1']);
    assert.deepEqual(snap.labelIds, ['a', 'b']);
    const all = e.flatMap((x) => x.annotations);
    assert.deepEqual(snapshotState(snap, all), { state: 'current', missing: 0 });
    e[0].annotations[0].end = 2.5;
    assert.equal(snapshotState(snap, all).state, 'changed');
    assert.deepEqual(snapshotState(snap, [e[0].annotations[1]]), { state: 'changed', missing: 1 });
    assert.equal(labelsHash([{ id: 1, tags: { a: 1, b: 2 } }]), labelsHash([{ id: 1, tags: { b: 2, a: 1 } }]));
});

test('candidates carry their folder', () => {
    const c = uploadCandidates([
        { id: 'a', xcId: 'XC1', source: 'file', path: 'g/a.wav', annotations: [{ id: 1, setId: 'own' }] },
        { id: 'b', xcId: 'XC2', source: 'xc', annotations: [{ id: 2, setId: 'own' }] },
    ], defaultUploadSelection(), sets);
    assert.deepEqual(c.recordings.map((r) => r.folder), ['g', '@xc']);
});
