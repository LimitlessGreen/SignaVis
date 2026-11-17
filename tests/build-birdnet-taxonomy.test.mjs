// Taxonomy build: BirdNET+ V3 labels as base, V2.4 + Cornell for names,
// synonyms and species outside the model.
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildRecords, isPlausibleXcName, fetchCornellSpecies, imageCredit, mergeNames, parseV3Labels } from '../scripts/build-birdnet-taxonomy.js';

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

test('running the script directly executes main() (usage error without --output)', async () => {
    const { spawnSync } = await import('node:child_process');
    const { fileURLToPath } = await import('node:url');
    const script = fileURLToPath(new URL('../scripts/build-birdnet-taxonomy.js', import.meta.url));
    const res = spawnSync(process.execPath, [script], { encoding: 'utf8' });
    assert.equal(res.status, 1);
    assert.match(res.stderr, /Usage:/);
});

test('buildRecords drops implausible synonyms and Xeno-canto names from the BirdNET taxonomy', () => {
    const cornell = [
        { scientific_name: 'Strix aluco', taxon_group: 'Aves', record_type: 'species', common_names: {} },
        { scientific_name: 'Scinax x-signatus', taxon_group: 'Amphibia', record_type: 'species', common_names: {} },
        { scientific_name: 'Tarentola mauritanica', taxon_group: 'Reptilia', record_type: 'species', common_names: {},
          scientific_name_aliases: ['Strix mauritanica', 'Tarentola mauritanicus'], xc_name: 'Strix mauritanica' },
        { scientific_name: 'Crotalus ruber', taxon_group: 'Reptilia', record_type: 'species', common_names: {}, xc_name: 'Scinax ruber' },
        { scientific_name: 'Masticophis lateralis', taxon_group: 'Reptilia', record_type: 'species', common_names: {}, xc_name: 'Mantophryne lateralis' },
        { scientific_name: 'Rana aurora', taxon_group: 'Amphibia', record_type: 'species', common_names: {}, xc_name: 'Amerana aurora' },
        { scientific_name: 'Lithobates sylvaticus', taxon_group: 'Amphibia', record_type: 'species', common_names: {}, xc_name: 'Hylarana daemeli' },
        { scientific_name: 'Aerospiza tachiro', taxon_group: 'Aves', record_type: 'species', common_names: {}, xc_name: 'Accipiter tachiro' },
    ];
    const { records } = buildRecords({ v3: [], cornell });
    const by = Object.fromEntries(records.map((r) => [r.s, r]));
    assert.deepEqual(by['Tarentola mauritanica'].a, ['Tarentola mauritanicus']);
    assert.equal(by['Tarentola mauritanica'].xc, undefined);
    assert.equal(by['Crotalus ruber'].xc, undefined);
    assert.equal(by['Masticophis lateralis'].xc, undefined);
    assert.equal(by['Lithobates sylvaticus'].xc, undefined);
    assert.equal(by['Rana aurora'].xc, 'Amerana aurora');
    assert.equal(by['Aerospiza tachiro'].xc, 'Accipiter tachiro');
});

test('assertSameIdScheme rejects a BirdNET taxonomy with another ID numbering', async () => {
    const { assertSameIdScheme } = await import('../scripts/build-birdnet-taxonomy.js');
    const v3 = parseV3Labels(V3_CSV);
    assert.doesNotThrow(() => assertSameIdScheme(v3, [{ scientific_name: 'Turdus merula', birdnet_id: 'BN1' }]));
    assert.throws(() => assertSameIdScheme(v3, [{ scientific_name: 'Turdus merula', birdnet_id: 'BN15446' }]), /outdated/);
});

test('imageCredit reads author and license from the nested image object', () => {
    const c = { image: { medium: 'x', author: 'Daniel Mérida', license: '© Macaulay Library' } };
    assert.deepEqual(imageCredit(c), { author: 'Daniel Mérida', license: '© Macaulay Library' });
    assert.deepEqual(imageCredit({ image_author: 'A', image_license: 'CC BY' }), { author: 'A', license: 'CC BY' });
    assert.deepEqual(imageCredit({}), { author: '', license: '' });
});

test('buildRecords: Cornell names win, V3 names only fill gaps, Indonesian id -> in', () => {
    const v3 = parseV3Labels(V3_CSV);
    const cornell = [{ scientific_name: 'Turdus merula', birdnet_id: 'BN1', record_type: 'species', taxon_group: 'Aves', common_names: { en: 'Eurasian Blackbird', id: 'Burung hitam' } }];
    const { records } = buildRecords({ v3, cornell });
    const blackbird = records.find((r) => r.s === 'Turdus merula');
    assert.equal(blackbird.n.en_uk, 'Eurasian Blackbird');
    assert.equal(blackbird.n.de, 'Amsel');
    assert.equal(blackbird.n.in, 'Burung hitam');
    assert.equal(blackbird.n.id, undefined);
});

test('fetchCornellSpecies pages through the API and keeps the taxonomy version', async () => {
    const pages = [
        { taxonomy_version: 'v0.5', total: 3, results: [{ scientific_name: 'A a' }, { scientific_name: 'B b' }] },
        { taxonomy_version: 'v0.5', total: 3, results: [{ scientific_name: 'C c' }] },
    ];
    const urls = [];
    const fetchFn = async (url) => { urls.push(url); const p = Number(new URL(url).searchParams.get('page')); return { ok: true, json: async () => pages[p - 1] }; };
    const data = await fetchCornellSpecies(fetchFn, () => {});
    assert.equal(data.taxonomy_version, 'v0.5');
    assert.deepEqual(data.species.map((s) => s.scientific_name), ['A a', 'B b', 'C c']);
    assert.equal(urls.length, 2);
    assert.match(urls[0], /fields=scientific_name,.*&per_page=500&page=1/);

    pages[1] = { ...pages[1], taxonomy_version: 'v0.6' };
    await assert.rejects(fetchCornellSpecies(fetchFn, () => {}), /changed while downloading/);
});

test('isPlausibleXcName rejects known wrong Xeno-canto names, keeps genus revisions', () => {
    const groups = new Map([['Bos', new Set(['Mammalia'])], ['Stenella', new Set(['Mammalia'])], ['Eptesicus', new Set(['Mammalia'])]]);
    assert.equal(isPlausibleXcName({ s: 'Stenella frontalis', taxon_group: 'Mammalia' }, 'Bos frontalis', groups), false);
    assert.equal(isPlausibleXcName({ s: 'Cnephaeus serotinus', taxon_group: 'Mammalia' }, 'Eptesicus serotinus', groups), true);
});
