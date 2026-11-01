import test from 'node:test';
import assert from 'node:assert/strict';

import {
    isOwnSet, normalizeSet, markSetEdited, setStatusFromValidation, markSetUploaded,
    adoptLabels, ensureOwnSet, migrateSessionState,
} from '../src/app/annotation-sets.ts';
import { RecordingManager } from '../src/app/recording-manager.ts';

test('normalizeSet: defaults and locks imported sets', () => {
    const own = normalizeSet({ id: 'a', name: 'Mine' });
    assert.equal(own.origin, 'manual');
    assert.equal(own.status, 'draft');
    assert.equal(own.uploadedAt, null);
    assert.equal(isOwnSet(own), true);

    const xc = normalizeSet({ id: 'b', origin: 'xeno-canto', locked: false });
    assert.equal(xc.locked, true);
    assert.equal(isOwnSet(xc), false);
});

test('status: ready after clean check, draft + hint after change to uploaded set', () => {
    const s = normalizeSet({ id: 'a' });
    assert.equal(setStatusFromValidation(s, { ok: false }), 'draft');
    assert.equal(setStatusFromValidation(s, { ok: true }), 'ready');

    markSetUploaded(s, new Date('2026-10-30T10:00:00Z'));
    assert.equal(s.status, 'uploaded');
    assert.equal(s.uploadedAt, '2026-10-30T10:00:00.000Z');
    assert.equal(setStatusFromValidation(s, { ok: true }), 'uploaded');

    assert.equal(markSetEdited(s), true);
    assert.equal(s.status, 'draft');
    assert.equal(s.changedAfterUpload, true);
    assert.equal(markSetEdited(s), false);
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

test('ensureOwnSet prefers preferred, then any own set, else creates', () => {
    const sets = new Map([
        ['xc', normalizeSet({ id: 'xc', origin: 'xeno-canto' })],
        ['own', normalizeSet({ id: 'own' })],
    ]);
    assert.equal(ensureOwnSet(sets, 'xc', () => assert.fail('no create')), 'own');
    assert.equal(ensureOwnSet(sets, 'own', () => assert.fail('no create')), 'own');
    const only = new Map([['xc', sets.get('xc')]]);
    assert.equal(ensureOwnSet(only, null, () => ({ id: 'new' })), 'new');
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
