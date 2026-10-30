import test from 'node:test';
import assert from 'node:assert/strict';

import {
    buildAnnotaPayload,
    validateAnnotaPayload,
    readOriginalSetMetadata,
    ANNOTA_SET_FIELDS,
    ANNOTA_ANNOTATION_FIELDS,
} from '../src/infrastructure/xeno-canto/annotaPayload.ts';
import { mapXenoCantoLabelsToSpectrogram } from '../src/infrastructure/xeno-canto/xenoCantoRecordingsApi.ts';

const SET = {
    name: 'Garden 2026', license: 'CC-BY-NC', creator: 'Jo Tester', creatorId: 'ABCDEFGHIJ',
    owner: 'Org A; Org B', remarks: 'test set', taxonCoverage: 'Aves', completeness: 'partial',
};

const LABEL = {
    id: 'slabel_abc123', start: 1.5, end: 2.25, freqMin: 2000, freqMax: 8000,
    scientificName: 'Turdus merula', author: 'Jo Tester', xcId: 'XC12345',
    createdAt: '2026-10-29T08:00:00.000Z',
    tags: { soundType: 'song', sex: 'male', lifeStage: 'adult', animalSeen: 'yes', playbackUsed: false },
};

test('payload has exactly the Fv0 fields, no recording_context', () => {
    const p = buildAnnotaPayload({ set: SET, labels: [LABEL] });
    assert.deepEqual(Object.keys(p).sort(), [...ANNOTA_SET_FIELDS].sort());
    assert.equal('recording_context' in p, false);
    assert.deepEqual(Object.keys(p.annotations[0]).sort(), [...ANNOTA_ANNOTATION_FIELDS].sort());
});

test('set fields: scope, owner list, creator URI, remarks', () => {
    const p = buildAnnotaPayload({ set: SET, labels: [LABEL] });
    assert.deepEqual(p.scope, [{ taxon_coverage: 'Aves', completeness: 'part' }]);
    assert.equal(p.set_owner, 'Org A, Org B');
    assert.equal(p.set_creator_id, 'ABCDEFGHIJ');
    assert.equal(p.set_remarks, 'test set');
    assert.equal(p.annotations[0].annotator_xc_id, 'ABCDEFGHIJ');
});

test('annotation fields: stable id, xc_nr, date_identified, y/n values', () => {
    const a = buildAnnotaPayload({ set: SET, labels: [LABEL] }).annotations[0];
    assert.equal(a.annotation_source_id, 'slabel_abc123');
    assert.equal(a.xc_nr, '12345');
    assert.equal(a.date_identified, '2026-10-29');
    assert.equal(a.animal_seen, 'y');
    assert.equal(a.playback_used, 'n');
    assert.equal(a.overlap, '');
    assert.equal(a.frequency_low, '2000.0');
    assert.equal(a.start_time, '1.500000');
});

test('frequencies are omitted when unset', () => {
    const labels = [
        { ...LABEL, freqMin: undefined, freqMax: undefined },
        { ...LABEL, freqMin: 0, freqMax: 0 },
        { ...LABEL, freqUnset: true },
    ];
    for (const a of buildAnnotaPayload({ set: SET, labels }).annotations) {
        assert.equal('frequency_low' in a, false);
        assert.equal('frequency_high' in a, false);
    }
});

test('defaultXcNr applies to labels without their own xc_nr', () => {
    const { xcId, ...noXc } = LABEL;
    const p = buildAnnotaPayload({ set: SET, labels: [noXc], defaultXcNr: '999' });
    assert.equal(p.annotations[0].xc_nr, '999');
});

test('validation: errors block, warnings do not', () => {
    const ok = validateAnnotaPayload(buildAnnotaPayload({ set: SET, labels: [LABEL] }));
    assert.equal(ok.ok, true);
    assert.equal(ok.errors.length, 0);

    const { xcId, ...noXc } = LABEL;
    const bad = validateAnnotaPayload(buildAnnotaPayload({
        set: {}, labels: [{ ...noXc, scientificName: '', freqMin: undefined, freqMax: undefined, tags: {} }],
    }));
    assert.equal(bad.ok, false);
    assert.deepEqual(bad.errors.map((e) => e.field).sort(), ['scientific_name', 'xc_nr']);
    const warnFields = new Set(bad.warnings.map((w) => w.field));
    for (const f of ['set_creator', 'set_owner', 'set_license', 'frequency_low', 'sound_type', 'sex', 'life_stage']) {
        assert.ok(warnFields.has(f), f);
    }

    assert.equal(validateAnnotaPayload(buildAnnotaPayload({ set: SET, labels: [] })).ok, false);
});

test('original_set_metadata accepts array (Fv0) and object (legacy)', () => {
    const meta = { set_name: 'Orig', set_license: 'CC-BY', set_uri: 'https://x/1' };
    assert.deepEqual(readOriginalSetMetadata({ original_set_metadata: [meta] }), [meta]);
    assert.deepEqual(readOriginalSetMetadata({ original_set_metadata: meta }), [meta]);
    assert.deepEqual(readOriginalSetMetadata({}), []);

    for (const original_set_metadata of [[meta], meta]) {
        const { labels } = mapXenoCantoLabelsToSpectrogram(
            [{ start_time: 1, end_time: 2, scientific_name: 'Turdus merula', original_set_metadata }],
            { xcId: '1', sampleRate: 48000 },
        );
        assert.equal(labels[0].annotationSet.name, 'Orig');
        assert.equal(labels[0].annotationSet.license, 'CC-BY');
    }
});
