import test from 'node:test';
import assert from 'node:assert/strict';

import {
    isOwnSet, normalizeSet, setStatusFromValidation,
    adoptLabels, labelsToAdopt, migrateSessionState,
} from '../src/app/annotation-sets.ts';
import { RecordingManager } from '../src/app/recording-manager.ts';

test('normalizeSet: defaults and locks imported sets', () => {
    const own = normalizeSet({ id: 'a', name: 'Mine' });
    assert.equal(own.origin, 'manual');
    assert.equal(own.status, 'draft');
    assert.equal(isOwnSet(own), true);

    const xc = normalizeSet({ id: 'b', origin: 'xeno-canto', locked: false });
    assert.equal(xc.locked, true);
    assert.equal(isOwnSet(xc), false);
});

test('status: ready after clean check, else draft', () => {
    const s = normalizeSet({ id: 'a' });
    assert.equal(setStatusFromValidation(s, { ok: false }), 'draft');
    assert.equal(setStatusFromValidation(s, { ok: true }), 'ready');
});

test('adoptLabels: editable copies in the own set with new ids', () => {
    const src = [{ id: 'xc1_lbl_1', setId: 'xcset', origin: 'xeno-canto', readonly: true, start: 1, end: 2,
        scientificName: 'Turdus merula', annotationSet: { name: 'x' } }];
    const [c] = adoptLabels(src, 'own', new Date('2026-10-30T00:00:00Z'));
    assert.notEqual(c.id, 'xc1_lbl_1');
    assert.equal(c.setId, 'own');
    assert.equal(c.origin, 'manual');
    assert.equal(c.readonly, false);
    assert.equal('annotationSet' in c, false);
    assert.equal(c.scientificName, 'Turdus merula');
    assert.deepEqual(c.adoptedFrom, { id: 'xc1_lbl_1', setId: 'xcset', origin: 'xeno-canto' });
    assert.equal(c.createdAt, '2026-10-30T00:00:00.000Z');
});

test('migrateSessionState drops the old mode and normalizes sets', () => {
    const removed = [];
    const storage = { removeItem: (k) => removed.push(k) };
    const state = { mode: 'standalone', labelSets: new Map([['a', { id: 'a', origin: 'BirdNET' }]]) };
    migrateSessionState(state, storage);
    assert.equal('mode' in state, false);
    assert.equal(state.labelSets.get('a').locked, true);
    assert.equal(state.labelSets.get('a').status, 'draft');
    assert.deepEqual(removed, ['audio-workbench.mode.v1']);
});

test('RecordingManager.assignXcId links a recording to its XC number', () => {
    const m = new RecordingManager();
    const e = m.add({ filename: 'rec_01.wav' });
    assert.equal(m.assignXcId(e.id, 'XC 12345'), true);
    assert.equal(m.getById(e.id).xcId, 'XC12345');
    assert.equal(m.assignXcId(e.id, 'abc'), false);
    assert.equal(m.getById(e.id).xcId, 'XC12345');
    assert.equal(m.assignXcId(e.id, ''), true);
    assert.equal(m.getById(e.id).xcId, null);
});

test('labelsToAdopt: labels already copied into the target set are skipped', () => {
    const src = [{ id: 'x1', setId: 'xc' }, { id: 'x2', setId: 'xc' }];
    const copies = adoptLabels([src[0]], 'own');
    assert.deepEqual(labelsToAdopt(src, [...src, ...copies], 'own').map((l) => l.id), ['x2']);
    const all = [...src, ...adoptLabels(src, 'own')];
    assert.equal(labelsToAdopt(src, all, 'own').length, 0);          // second click adds nothing
    assert.equal(labelsToAdopt(src, all, 'other').length, 2);        // other target set: not adopted there
});

test('labelsToAdopt: a detection copied as one call box can still give its other boxes', () => {
    const det = { id: 'bn1', setId: 'bn', origin: 'BirdNET' };
    const boxA = { ...det, adoptBox: { start: 1, end: 1.4 } }, boxB = { ...det, adoptBox: { start: 2, end: 2.3 } };
    const [copy] = adoptLabels([boxA], 'own');
    assert.deepEqual(copy.adoptedFrom, { id: 'bn1', setId: 'bn', origin: 'BirdNET', box: { start: 1, end: 1.4 } });
    assert.equal('adoptBox' in copy, false);
    assert.deepEqual(labelsToAdopt([boxA, boxB], [copy], 'own'), [boxB]);
});

// ── Adopting converts: the detection is hidden while a copy exists ──
import { withoutAdopted, adoptedSourceIds } from '../src/app/annotation-sets.ts';

test('withoutAdopted hides a detection once it is in my labels', () => {
    const det = { id: 'd1', setId: 'birdnet', origin: 'BirdNET', start: 0, end: 3 };
    const other = { id: 'd2', setId: 'birdnet', origin: 'BirdNET', start: 3, end: 6 };
    const [copy] = adoptLabels([det], 'own');
    const all = [det, other, copy];
    assert.deepEqual(withoutAdopted(all, 'own').map((l) => l.id), ['d2', copy.id]);
    assert.deepEqual([...adoptedSourceIds(all, 'own')], ['d1']);
});

test('withoutAdopted: deleting the copy brings the detection back', () => {
    const det = { id: 'd1', setId: 'birdnet', origin: 'BirdNET', start: 0, end: 3 };
    assert.deepEqual(withoutAdopted([det], 'own').map((l) => l.id), ['d1']);
});

test('withoutAdopted: one of several call boxes adopted hides the detection, the rest stay adoptable', () => {
    const det = { id: 'd1', setId: 'birdnet', origin: 'BirdNET', start: 0, end: 3 };
    const b1 = { start: 0.5, end: 1, freqMin: 2000, freqMax: 4000 };
    const b2 = { start: 2, end: 2.5, freqMin: 2000, freqMax: 4000 };
    const [copy] = adoptLabels([{ ...det, adoptBox: { ...b1, label: 'x' } }], 'own');
    const all = [det, copy];
    assert.deepEqual(withoutAdopted(all, 'own').map((l) => l.id), [copy.id]);
    // the second box is still offered ("Also the other 1")
    assert.equal(labelsToAdopt([{ ...det, adoptBox: { ...b2, label: 'x' } }], all, 'own').length, 1);
});

import { applyPlayerRestore } from '../src/app/annotation-sets.ts';
test('applyPlayerRestore: redoing a conversion hides the detection, it does not delete it', () => {
    const det = { id: 'd1', setId: 'birdnet', origin: 'BirdNET', start: 0, end: 3 };
    const [copy] = adoptLabels([det], 'own');
    // after undo the app holds only the detection; the player redoes: before = [det], after = [copy]
    const next = applyPlayerRestore([det], [det], [copy], 'own');
    assert.deepEqual(next.map((l) => l.id).sort(), ['d1', copy.id].sort());
    // deleting the copy later brings it back
    assert.deepEqual(withoutAdopted(next.filter((l) => l.id !== copy.id), 'own').map((l) => l.id), ['d1']);
});

test('applyPlayerRestore: a label really removed by undo is deleted', () => {
    const a = { id: 'a', setId: 'own', start: 0, end: 1 };
    assert.deepEqual(applyPlayerRestore([a], [a], [], 'own'), []);
});
