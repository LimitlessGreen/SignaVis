// Species search: ranking helpers + grouped suggestion provider
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  speciesCodes, matchTier, compareRanked, splitHighlight, MATCH,
} from '../src/ui/components/taxonomy-ui/species-ranking.ts';
import { createSuggestionProvider } from '../src/ui/components/taxonomy-ui/taxonomy-ui.ts';
import { TaxonomyResolver } from '../src/infrastructure/taxonomyResolver.ts';

test('speciesCodes builds 4- and 6-letter codes', () => {
  assert.deepEqual(speciesCodes('Parus major'), ['pama', 'parmaj']);
  assert.deepEqual(speciesCodes('Phylloscopus collybita'), ['phco', 'phycol']);
  assert.deepEqual(speciesCodes('Noise'), []);
});

test('matchTier orders exact > code > prefix > word > sci > substring > other language', () => {
  assert.equal(matchTier('kohlmeise', 'Kohlmeise', 'Parus major'), MATCH.EXACT);
  assert.equal(matchTier('pama', 'Kohlmeise', 'Parus major'), MATCH.CODE);
  assert.equal(matchTier('kohl', 'Kohlmeise', 'Parus major'), MATCH.PREFIX);
  assert.equal(matchTier('specht', 'Grün-Specht', 'Picus viridis'), MATCH.WORD);
  assert.equal(matchTier('major', 'Kohlmeise', 'Parus major'), MATCH.SCI);
  assert.equal(matchTier('meise', 'Kohlmeise', 'Parus major'), MATCH.SUBSTRING);
  assert.equal(matchTier('great tit', 'Kohlmeise', 'Parus major', ['Great Tit']), MATCH.ALT);
  assert.equal(matchTier('amsel', 'Kohlmeise', 'Parus major', ['Great Tit']), MATCH.NONE);
  assert.equal(matchTier('mesange', 'Kohlmeise', 'Parus major', ['Mésange charbonnière']), MATCH.ALT);
});

test('compareRanked: exact first, local before remote, other-language matches last', () => {
  const rows = [
    { name: 'Meisengimpel', tier: MATCH.PREFIX, geo: 0 },
    { name: 'Weidespreeuw-Stärling', tier: MATCH.ALT, geo: 0.9 },
    { name: 'Sumpfmeise', tier: MATCH.SUBSTRING, geo: 0.4 },
    { name: 'Meise', tier: MATCH.EXACT, geo: 0 },
    { name: 'Bartmeise', tier: MATCH.SUBSTRING, geo: 0.1 },
  ];
  assert.deepEqual(rows.sort(compareRanked).map((r) => r.name),
    ['Meise', 'Sumpfmeise', 'Bartmeise', 'Meisengimpel', 'Weidespreeuw-Stärling']);
});

test('splitHighlight is diacritic-insensitive', () => {
  assert.deepEqual(splitHighlight('Mésange', 'mes'), ['', 'Més', 'ange']);
  assert.deepEqual(splitHighlight('Kohlmeise', 'xyz'), ['Kohlmeise', '', '']);
});

const rec = (s, de, en, extra = {}) => ({ s, n: { de, en_uk: en }, ...extra });
const tax = new TaxonomyResolver();
tax.load({
  languages: ['de', 'en_uk'],
  records: [
    rec('Carpodacus sibiricus', 'Meisengimpel', 'Long-tailed Rosefinch'),
    rec('Poecile palustris', 'Sumpfmeise', 'Marsh Tit'),
    rec('Parus major', 'Kohlmeise', 'Great Tit'),
    rec('Cyanistes caeruleus', 'Blaumeise', 'Eurasian Blue Tit'),
    rec('Poecile montanus', 'Weidenmeise', 'Willow Tit', { x: 1 }),
    rec('Tachybaptus ruficollis', 'Zwergtaucher', 'Little Grebe'),
  ],
});
const provider = (labels = [], geo = {}) => createSuggestionProvider({
  taxonomy: tax,
  getLang: () => 'de',
  getLabels: () => labels,
  getPool: () => [],
  getGeoScore: (sci) => geo[sci] ?? null,
});

test('provider groups project labels (with counts) before taxonomy and extra species', () => {
  const labels = [
    { label: 'Blaumeise', scientificName: 'Cyanistes caeruleus' },
    { label: 'Kohlmeise', scientificName: 'Parus major' },
    { label: 'Kohlmeise', scientificName: 'Parus major' },
  ];
  const out = provider(labels, { 'Poecile palustris': 0.5 })('meise');
  assert.deepEqual(out.map((r) => [r.group, r.name]), [
    ['project', 'Kohlmeise'],
    ['project', 'Blaumeise'],
    ['taxonomy', 'Sumpfmeise'],   // local species first,
    ['taxonomy', 'Meisengimpel'], // then by match quality
    ['extra', 'Weidenmeise'],
  ]);
  assert.equal(out[0].count, 2);
  assert.equal(out.find((r) => r.name === 'Sumpfmeise').local, true);
  assert.equal(out.find((r) => r.name === 'Weidenmeise').detail, 'not in BirdNET model');
});

test('provider finds species by code and by other languages, and marks how they matched', () => {
  const byCode = provider()('pama');
  assert.equal(byCode.find((r) => r.group === 'taxonomy').name, 'Kohlmeise');
  assert.equal(byCode.find((r) => r.name === 'Kohlmeise').code, 'PAMA');

  const byEnglish = provider()('grebe');
  assert.deepEqual(byEnglish.map((r) => r.name), ['Zwergtaucher']);
  assert.match(byEnglish[0].matchedAlt, /Little Grebe/);
});

test('empty query lists project labels only, most used first', () => {
  const labels = [{ label: 'Blaumeise', scientificName: 'Cyanistes caeruleus' },
    { label: 'Kohlmeise', scientificName: 'Parus major' }, { label: 'Kohlmeise', scientificName: 'Parus major' }];
  const out = provider(labels)('');
  assert.deepEqual(out.map((r) => r.name), ['Kohlmeise', 'Blaumeise', 'Noise']);
  assert.ok(out.every((r) => r.group === 'project'));
});

test('label list filter: diacritics, codes, other languages and tags', async () => {
  const { LabelList } = await import('../src/ui/panels/label-list.ts');
  const ctx = {
    _resolveName: (l) => ({ display: l.label, scientific: l.scientificName }),
    _altNames: (sci) => (sci === 'Parus major' ? ['Kohlmeise', 'Great Tit', 'Mésange charbonnière'] : []),
  };
  const lbl = { label: 'Kohlmeise', scientificName: 'Parus major', tags: { sound: 'Gesang' } };
  const matches = (f) => { ctx._filter = f; return LabelList.prototype._matches.call(ctx, lbl); };
  for (const f of ['kohl', 'pama', 'parmaj', 'great tit', 'mesange', 'gesang', 'major']) assert.ok(matches(f), f);
  for (const f of ['amsel', 'tumu']) assert.ok(!matches(f), f);
});

test('labels with a variant scientific name count towards the canonical species', () => {
  const t = new TaxonomyResolver();
  t.load({ languages: ['de'], records: [{ s: 'Parus major', n: { de: 'Kohlmeise' } }] });
  assert.equal(t.resolve('Parus majr')?.s, 'Parus major');   // resolver maps the variant
  const out = createSuggestionProvider({ taxonomy: t, getLang: () => 'de', getPool: () => [],
    getLabels: () => [{ label: 'a', scientificName: 'Parus major' }, { label: 'b', scientificName: 'Parus majr' }] })('kohl');
  assert.deepEqual(out.map((r) => [r.scientificName, r.count]), [['Parus major', 2]]);
});

test('species on the active list rank first, before local ones, and are marked', () => {
  const p = createSuggestionProvider({
    taxonomy: tax, getLang: () => 'de', getLabels: () => [], getPool: () => [],
    getGeoScore: (sci) => ({ 'Poecile palustris': 0.5 })[sci] ?? null,
    isListed: (sci) => sci === 'Carpodacus sibiricus',
  });
  const out = p('meise').filter((r) => r.group === 'taxonomy');
  assert.deepEqual(out.map((r) => r.name).slice(0, 2), ['Meisengimpel', 'Sumpfmeise']);
  assert.equal(out[0].listed, true);
  assert.equal(out[1].listed, false);
});

test('compareRanked: listed beats local within the same match bucket only', () => {
  const rows = [
    { name: 'local', tier: MATCH.PREFIX, geo: 0.5 },
    { name: 'listed', tier: MATCH.PREFIX, listed: true },
    { name: 'exact', tier: MATCH.EXACT },
  ];
  assert.deepEqual(rows.sort(compareRanked).map((r) => r.name), ['exact', 'listed', 'local']);
});
