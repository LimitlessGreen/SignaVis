// Taxonomy build: BirdNET+ V3 labels as base, V2.4 + Cornell for names,
// synonyms and species outside the model.
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildRecords, mergeNames, parseV3Labels } from '../scripts/build-birdnet-taxonomy.js';

const V3_CSV = [
    'ix,birdnet_id,scientific_name,common_name,taxon_group,inat_id,ebird_code,common_name_en,common_name_de,common_name_pt,common_name_zh-CN,common_name_es_MX',
    '0,BN1,Turdus merula,Common Blackbird,Aves,12716,eurbla,Common Blackbird,Amsel,Melro-preto,乌鸫,Mirlo',
    '1,BN2,Pseudacris regilla,Pacific Chorus Frog,Amphibia,,,Pacific Chorus Frog,"Pazifischer Laubfrosch",,,',
].join('\n');

test('parseV3Labels reads names per language', () => {
    const [blackbird] = parseV3Labels(V3_CSV);
    assert.equal(blackbird.s, 'Turdus merula');
    assert.equal(blackbird.birdnet_id, 'BN1');
    assert.equal(blackbird.names.de, 'Amsel');
});

test('mergeNames maps language codes and lets later sources win', () => {
    const n = mergeNames({ de: 'Schwarzdrossel', en_uk: 'Blackbird' }, { en: 'Common Blackbird', de: 'Amsel', pt: 'Melro', 'zh-CN': '乌鸫', es_MX: 'Mirlo', fr: '' });
    assert.deepEqual(n, { de: 'Amsel', en_uk: 'Common Blackbird', pt_BR: 'Melro', zh: '乌鸫' });
});

test('buildRecords: V3 base, V2.4-only and Cornell extras flagged, synonyms kept', () => {
    const v24 = new Map([
        ['Turdus merula', { en_uk: 'Eurasian Blackbird', af: 'Merel' }],
        ['Hyliola regilla', { en_uk: 'Pacific Chorus Frog' }],          // renamed in V3
        ['Gryllus campestris', { en_uk: 'Field Cricket' }],             // not in V3
    ]);
    const cornell = [
        { scientific_name: 'Pseudacris regilla', scientific_name_aliases: ['Hyliola regilla'], xc_name: 'Hyliola regilla', inat_id: 23930, record_type: 'species', taxon_group: 'Amphibia', common_names: { fr: 'Rainette du Pacifique' } },
        { scientific_name: 'Zosterops borbonicus', record_type: 'species', taxon_group: 'Aves', birdnet_id: 'BN9', common_name: 'Reunion Grey White-eye', common_names: {} },
        { scientific_name: 'Rain', record_type: 'sound_class', common_names: {} },
    ];
    const { records, modelCount, extraCount } = buildRecords({ v3: parseV3Labels(V3_CSV), v24, cornell });
    const by = Object.fromEntries(records.map((r) => [r.s, r]));

    assert.equal(modelCount, 2);
    assert.equal(extraCount, 2);
    assert.equal(by['Turdus merula'].n.en_uk, 'Common Blackbird');   // V3 wins
    assert.equal(by['Turdus merula'].n.af, 'Merel');                 // V2.4-only language kept
    assert.equal(by['Turdus merula'].x, undefined);
    assert.deepEqual(by['Pseudacris regilla'].a, ['Hyliola regilla']);
    assert.equal(by['Pseudacris regilla'].n.fr, 'Rainette du Pacifique');
    assert.equal(by['Hyliola regilla'], undefined);                  // merged, not duplicated
    assert.equal(by['Gryllus campestris'].x, 1);
    assert.equal(by['Zosterops borbonicus'].x, 1);
    assert.equal(by['Rain'], undefined);
});

test('buildRecords: external IDs (eBird, iNaturalist, Xeno-canto name)', () => {
    const cornell = [{ scientific_name: 'Pseudacris regilla', scientific_name_aliases: ['Hyliola regilla'], xc_name: 'Hyliola regilla', inat_id: 23930, record_type: 'species', common_names: {} }];
    const { records } = buildRecords({ v3: parseV3Labels(V3_CSV), cornell });
    const by = Object.fromEntries(records.map((r) => [r.s, r]));
    assert.equal(by['Turdus merula'].ebird, 'eurbla');
    assert.equal(by['Turdus merula'].inat, 12716);
    assert.equal(by['Turdus merula'].xc, undefined);
    assert.equal(by['Pseudacris regilla'].inat, 23930);           // from Cornell when V3 has none
    assert.equal(by['Pseudacris regilla'].xc, 'Hyliola regilla');
});
