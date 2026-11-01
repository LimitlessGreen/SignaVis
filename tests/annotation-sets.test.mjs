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
