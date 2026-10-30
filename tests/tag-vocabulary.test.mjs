import test from 'node:test';
import assert from 'node:assert/strict';

import { parseGroupProperties, recordingGroup, TagVocabularyCache, FALLBACK_VOCABULARY } from '../src/app/tag-vocabulary.ts';
import { fetchXcGroupProperties } from '../src/infrastructure/xeno-canto/xcGroupProperties.ts';
import { buildAnnotaAnnotation } from '../src/infrastructure/xeno-canto/annotaPayload.ts';

test('parseGroupProperties accepts several list shapes', () => {
    assert.deepEqual(
        parseGroupProperties({ group_properties: { sound_type: ['song', 'call'], sex: [{ value: 'male' }, { name: 'female' }], life_stage: { values: ['adult'] } } }),
        { soundType: ['song', 'call'], sex: ['male', 'female'], lifeStage: ['adult'] },
    );
    assert.deepEqual(parseGroupProperties({ properties: { sound_types: { echolocation: 'x', 'social call': 'y' } } }), { soundType: ['echolocation', 'social call'] });
    // A recording's own "type" string is a value, not a list
    assert.equal(parseGroupProperties({ type: 'song', sex: 'male' }), null);
    assert.equal(parseGroupProperties(null), null);
});

test('recordingGroup reads grp', () => {
    assert.equal(recordingGroup({ grp: 'Birds' }), 'birds');
    assert.equal(recordingGroup(null), '');
});

test('TagVocabularyCache: per group, last group as default, fallback per key', () => {
    const mem = new Map();
    const storage = { getItem: (k) => mem.get(k) ?? null, setItem: (k, v) => mem.set(k, v) };
    const cache = new TagVocabularyCache(storage);
    assert.equal(cache.get('birds').source, 'fallback');
    assert.deepEqual(cache.get().sex, FALLBACK_VOCABULARY.sex);

    cache.set('bats', { soundType: ['echolocation', 'social call'] });
    const bats = cache.get('bats');
    assert.equal(bats.source, 'xc');
    assert.deepEqual(bats.soundType, ['echolocation', 'social call']);
    assert.deepEqual(bats.sex, FALLBACK_VOCABULARY.sex);
    // no XC number → last loaded group
    assert.deepEqual(cache.get('').soundType, ['echolocation', 'social call']);
    // persisted
    assert.equal(new TagVocabularyCache(storage).has('bats'), true);
});

test('fetchXcGroupProperties calls the recording endpoint with key', async () => {
    let url = '';
    const fetchImpl = async (u) => { url = u; return { ok: true, json: async () => ({ recording: { grp: 'birds' }, group_properties: { sound_type: ['song'] } }) }; };
    const r = await fetchXcGroupProperties('XC123', { apiKey: 'k y', fetchImpl });
    assert.equal(url, 'https://xeno-canto.org/api/3/recording/123?key=k%20y&group_properties');
    assert.deepEqual(r, { group: 'birds', vocab: { soundType: ['song'] } });
    assert.equal(await fetchXcGroupProperties('123', { apiKey: '', fetchImpl }), null);
});

test('BirdNET detections (0–Nyquist) export without frequency range', () => {
    const a = buildAnnotaAnnotation({ id: 'x', start: 1, end: 2, freqMin: 0, freqMax: 24000, scientificName: 'A b', aiSuggested: { model: 'BirdNET' } }, {});
    assert.equal('frequency_low' in a, false);
    assert.equal('frequency_high' in a, false);
    const b = buildAnnotaAnnotation({ id: 'y', start: 1, end: 2, freqMin: 1000, freqMax: 4000, scientificName: 'A b', aiSuggested: { model: 'BirdNET' } }, {});
    assert.equal(b.frequency_low, '1000.0');
});
