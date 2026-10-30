import test from 'node:test';
import assert from 'node:assert/strict';

import { buildUploadChecklist, sameName } from '../src/app/upload-checklist.ts';
import { buildAnnotaPayload, validateAnnotaPayload } from '../src/infrastructure/xeno-canto/annotaPayload.ts';

const SET = { name: 'Garden', license: 'CC-BY-NC', creator: 'Jo Tester', creatorId: 'ABC', owner: 'Jo', taxonCoverage: 'Aves', completeness: 'all' };
const PROFILE = { name: 'Jo Tester', xcUsername: 'ABC' };

function run(labels, extra = {}) {
    const payload = buildAnnotaPayload({ set: SET, labels, softwareNameAndVersion: 'test' });
    return buildUploadChecklist({
        apiKey: 'k', profile: PROFILE, set: SET, payload, validation: validateAnnotaPayload(payload),
        recordings: [{ id: 'r1', name: 'a.wav', xcNr: '123', recordist: 'Jo Tester', labelCount: labels.length }],
        ...extra,
    });
}

const full = (id, over = {}) => ({
    id, start: 1, end: 2, freqMin: 1000, freqMax: 4000, scientificName: 'Turdus merula', author: 'Jo', xc_nr: '123',
    tags: { soundType: 'song', sex: 'male', lifeStage: 'adult' }, ...over,
});

test('complete set is ready without issues', () => {
    const r = run([full('l1'), full('l2')]);
    assert.equal(r.ready, true);
    assert.equal(r.errorCount, 0);
    assert.equal(r.warningCount, 0);
    assert.equal(r.labelCount, 2);
    assert.deepEqual(r.steps.map((s) => s.id), ['key', 'profile', 'set', 'recordings', 'labels']);
});

test('missing key and species are errors; label issues point at label ids', () => {
    const r = run([full('l1', { scientificName: '' }), full('l2', { scientificName: '' })], { apiKey: '' });
    assert.equal(r.ready, false);
    assert.equal(r.steps.find((s) => s.id === 'key').status, 'error');
    const labels = r.steps.find((s) => s.id === 'labels');
    assert.equal(labels.status, 'error');
    assert.equal(labels.issues[0].message, '2 labels without species');
    assert.deepEqual(labels.issues[0].targets.map((t) => t.id), ['l1', 'l2']);
});

test('recording without XC number blocks; foreign recordist only warns', () => {
    const r = run([full('l1', { xc_nr: '' })], {
        recordings: [
            { id: 'r1', name: 'a.wav', xcNr: '', labelCount: 1 },
            { id: 'r2', name: 'b.wav', xcNr: '9', recordist: 'Someone Else', labelCount: 0 },
        ],
    });
    const rec = r.steps.find((s) => s.id === 'recordings');
    assert.equal(rec.status, 'error');
    assert.deepEqual(rec.issues[0].targets, [{ kind: 'recording', id: 'r1' }]);
    assert.equal(rec.issues[1].level, 'warning');
    // xc_nr is reported per recording, not again per label
    assert.equal(r.steps.find((s) => s.id === 'labels').issues.length, 0);
});

test('export mode skips the key and ownership checks', () => {
    const r = run([full('l1')], { mode: 'export', apiKey: '', recordings: [{ id: 'r', name: 'x', xcNr: '1', recordist: 'Other', labelCount: 1 }] });
    assert.equal(r.steps.some((s) => s.id === 'key'), false);
    assert.equal(r.ready, true);
    assert.equal(r.warningCount, 0);
});

test('optional label fields are grouped warnings', () => {
    const r = run([full('l1', { tags: {} }), full('l2', { freqMin: null, freqMax: null })]);
    assert.equal(r.ready, true);
    const msgs = r.steps.find((s) => s.id === 'labels').issues.map((i) => i.message);
    assert.ok(msgs.includes('1 label without sound type'));
    assert.ok(msgs.includes('1 label without frequency range'));
});

test('sameName ignores case, accents and punctuation', () => {
    assert.equal(sameName('José  Müller', 'jose muller'), true);
    assert.equal(sameName('A', ''), false);
});
