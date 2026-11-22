// Every field in domain/labelFields.ts reaches every consumer: a new field is
// one registry entry, and this test fails if a consumer still lists fields by hand.
import test from 'node:test';
import assert from 'node:assert/strict';
import { ANNOTA_FIELDS, PROP_FIELDS, labelProps, annotaFieldValues, importAnnotaTags } from '../src/domain/labelFields.ts';
import { AnnotationLayer, SpectrogramLabelLayer } from '../src/domain/annotations.ts';
import { BirdNETPlayer } from '../src/app/BirdNETPlayer.ts';
import { buildLabelsJson } from '../src/infrastructure/export/labelTableFormats.ts';
import { buildRavenSelectionTable, RAVEN_COLUMNS } from '../src/infrastructure/export/ravenSelectionTable.ts';
import { ANNOTA_ANNOTATION_FIELDS, buildAnnotaAnnotation } from '../src/infrastructure/xeno-canto/annotaPayload.ts';
import { mapXenoCantoLabelsToSpectrogram } from '../src/infrastructure/xeno-canto/xenoCantoRecordingsApi.ts';
import { LABEL_GRID_COLUMN_KEYS } from '../src/ui/panels/label-grid.ts';

const BASE = { id: 'x1', start: 1, end: 2, freqMin: 1000, freqMax: 3000, label: 'Blackbird', scientificName: 'Turdus merula' };
const withProps = () => Object.fromEntries(PROP_FIELDS.map((f) => [f.key, f.example]));
const annotaExample = (f) => (f.kind === 'yn' ? 'y' : f.kind === 'date' ? '2026-05-01' : `v-${f.key}`);

function barePlayer() {
    const p = Object.create(BirdNETPlayer.prototype);
    Object.assign(p, { _state: { audioBuffer: { duration: 10 }, sampleRateHz: 48000, d: {} }, _labelTaxonomy: [], _linkedLabels: new Map() });
    Object.defineProperty(p, 'duration', { value: 10 });
    return p;
}

test('property fields: normalize keeps the example and drops junk', () => {
    for (const f of PROP_FIELDS) {
        assert.deepEqual(labelProps({ [f.key]: f.example }), { [f.key]: f.normalize(f.example) }, f.key);
        assert.deepEqual(labelProps({ [f.key]: { junk: true } }), {}, `${f.key}: junk dropped`);
    }
});

test('property fields survive the label layers and the player', () => {
    const src = { ...BASE, ...withProps() };
    const spec = new SpectrogramLabelLayer();
    const wave = new AnnotationLayer();
    const p = barePlayer();
    const linked = p._normalizeLinkedLabel(src);
    p._linkedLabels.set(linked.id, linked);
    for (const f of PROP_FIELDS) {
        const want = f.normalize(f.example);
        assert.equal(spec._normalize(src)[f.key], want, `${f.key}: SpectrogramLabelLayer._normalize`);
        assert.equal(wave._normalize(src)[f.key], want, `${f.key}: AnnotationLayer._normalize`);
        assert.equal(linked[f.key], want, `${f.key}: player _normalizeLinkedLabel`);
        assert.equal(p._toSpectrogramLabel(linked)[f.key], want, `${f.key}: player → spectrogram layer`);
    }
});

test('property fields: JSON export, Raven export, table column', () => {
    const l = { ...BASE, ...withProps() };
    const json = JSON.parse(buildLabelsJson([l])).labels[0];
    for (const f of PROP_FIELDS) {
        assert.equal(json[f.key], f.normalize(f.example), `${f.key}: JSON export`);
        assert.ok(LABEL_GRID_COLUMN_KEYS.includes(f.key), `${f.key}: label table column`);
        if (f.raven) {
            assert.ok(RAVEN_COLUMNS.includes(f.raven.column), `${f.key}: Raven column ${f.raven.column}`);
            const [head, row] = buildRavenSelectionTable([l]).trim().split('\n').map((r) => r.split('\t'));
            assert.equal(row[head.indexOf(f.raven.column)], f.raven.value(f.example), `${f.key}: Raven value`);
        }
    }
});

test('tag (Annota) fields: table column, upload payload, XC import', () => {
    const tags = Object.fromEntries(ANNOTA_FIELDS.map((f) => [f.key, annotaExample(f)]));
    const ann = buildAnnotaAnnotation({ ...BASE, tags }, { defaultXcNr: '1' });
    const payloadValues = annotaFieldValues(tags);
    const raw = Object.fromEntries(ANNOTA_FIELDS.map((f) => [f.annota, annotaExample(f)]));
    const imported = mapXenoCantoLabelsToSpectrogram([{ start_time: 1, end_time: 2, frequency_low: 1000, frequency_high: 3000, scientific_name: 'Turdus merula', ...raw }], { xcId: '1', sampleRate: 48000 }).labels[0];
    for (const f of ANNOTA_FIELDS) {
        assert.ok(LABEL_GRID_COLUMN_KEYS.includes(`annota:${f.key}`), `${f.key}: label table column`);
        assert.ok(ANNOTA_ANNOTATION_FIELDS.includes(f.annota), `${f.key}: ${f.annota} is a known Annota field`);
        assert.equal(ann[f.annota], payloadValues[f.annota], `${f.key}: upload payload`);
        assert.notEqual(ann[f.annota], '', `${f.key}: upload payload not empty`);
        assert.equal(imported.tags?.[f.key], annotaExample(f), `${f.key}: XC import`);
        assert.deepEqual(importAnnotaTags({ [f.key]: annotaExample(f) })[f.key], annotaExample(f), `${f.key}: import by own key`);
    }
});
