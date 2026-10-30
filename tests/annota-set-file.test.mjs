import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readAnnotaSetFile } from '../src/infrastructure/xeno-canto/annotaSetFile.ts';
import { mapXenoCantoLabelsToSpectrogram } from '../src/infrastructure/xeno-canto/xenoCantoRecordingsApi.ts';

// Shape of an XC "Download set" file (acc, set 500), trimmed to two annotations
const DOWNLOAD = {
    set_name: 'Annotation set for 1159843', set_creator: null, set_owner: null, set_license: 'CC-BY-4.0',
    set_uri: 'https://acc.xeno-canto.org/annotation/set/500', set_creation_date: '2026-10-05 12:18:28', set_remarks: null,
    annotations: [
        { annotation_xc_id: 76352, xc_nr: 1159843, scientific_name: 'Tadorna ferruginea', annotator: 'Nishant Bhagwat',
          start_time: 1.5734, end_time: 1.8925, frequency_high: 2982, frequency_low: 0, sound_type: null, sex: null, life_stage: null, annotation_remarks: null },
        { annotation_xc_id: 76353, xc_nr: 1159843, scientific_name: 'Tadorna ferruginea', annotator: 'Nishant Bhagwat',
          start_time: 2.6338, end_time: 12.3552, frequency_high: 3490, frequency_low: 0, sound_type: null, sex: null, life_stage: null, annotation_remarks: null },
    ],
};

test('readAnnotaSetFile: top-level set metadata is attached to every annotation', () => {
    const f = readAnnotaSetFile(DOWNLOAD);
    assert.deepEqual([...f.byXcNr.keys()], ['1159843']);
    assert.equal(f.skipped, 0);
    assert.equal(f.set.set_license, 'CC-BY-4.0');
    assert.equal('set_creator' in f.set, false, 'null values are left out');
    for (const a of f.byXcNr.get('1159843')) assert.equal(a.original_set_metadata.set_uri, 'https://acc.xeno-canto.org/annotation/set/500');
});

test('readAnnotaSetFile output maps like the recording API (locked set metadata per label)', () => {
    const raw = readAnnotaSetFile(DOWNLOAD).byXcNr.get('1159843');
    const { labels } = mapXenoCantoLabelsToSpectrogram(raw, { xcId: '1159843', sampleRate: 48000 });
    assert.equal(labels.length, 2);
    assert.equal(labels[0].id, 'xc1159843_lbl_76352');
    assert.equal(labels[0].scientificName, 'Tadorna ferruginea');
    assert.equal(labels[1].freqMax, 3490);
    assert.deepEqual(labels[0].annotationSet, {
        name: 'Annotation set for 1159843', license: 'CC-BY-4.0', creator: '',
        uri: 'https://acc.xeno-canto.org/annotation/set/500', date: '2026-10-05 12:18:28',
    });
});

test('readAnnotaSetFile: groups by XC number, keeps per-annotation metadata, rejects non-sets', () => {
    const own = { set_name: 'Mine', set_license: 'CC-BY-NC-SA-4.0', annotations: [
        { xc_nr: 'XC1', start_time: '1.0', end_time: '2.0' },
        { xc_nr: '2', start_time: '1.0', end_time: '2.0', original_set_metadata: [{ set_name: 'Other' }] },
        { start_time: '1.0', end_time: '2.0' },
    ] };
    const f = readAnnotaSetFile(own);
    assert.deepEqual([...f.byXcNr.keys()], ['1', '2']);
    assert.equal(f.skipped, 1);
    assert.equal(f.byXcNr.get('1')[0].original_set_metadata.set_name, 'Mine');
    assert.equal(f.byXcNr.get('2')[0].original_set_metadata[0].set_name, 'Other');
    assert.equal(readAnnotaSetFile({ labels: [] }), null);
    assert.equal(readAnnotaSetFile(null), null);
});
