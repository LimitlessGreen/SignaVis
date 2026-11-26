import test from 'node:test';
import assert from 'node:assert/strict';
import { matchScore, rankActions, paletteSections, flatItems, speciesItems, paletteActions } from '../src/app/lite/command-search.ts';
import { projectMenu, settingsMenu } from '../src/app/lite/top-menus.ts';

const act = (id, label, extra = {}) => ({ id, group: 'actions', label, ...extra });

test('command search: every query word must match; start beats word start beats inside', () => {
  assert.equal(matchScore('xyz', 'Panel: Labels'), 0);
  assert.equal(matchScore('panel lab', 'Panel: Labels'), 3 + 2);
  assert.ok(matchScore('lab', 'Labels') > matchScore('lab', 'Panel: Labels'));
  assert.ok(matchScore('bel', 'Panel: Labels') > 0);
  assert.ok(matchScore('lab', 'Panel: Labels') > matchScore('bel', 'Panel: Labels'));
  // umlauts and case as the species search treats them
  assert.ok(matchScore('rotkehl', 'Rotkehlchen') > 0);
});

test('command search: actions ranked by label before keywords; empty query keeps the order', () => {
  const items = [act('a', 'Rescan folder', { keywords: 'labels' }), act('b', 'Export labels', { keywords: 'raven json' }), act('c', 'Panel: Labels')];
  // label hits first (equal scores keep their order), keyword-only hits after them
  assert.deepEqual(rankActions(items, 'lab').map((i) => i.id), ['b', 'c', 'a']);
  assert.deepEqual(rankActions(items, 'raven').map((i) => i.id), ['b']);
  assert.deepEqual(rankActions(items, '', 2).map((i) => i.id), ['a', 'b']);
});

test('command search: sections in mockup order; species and recordings only with a query', () => {
  const sp = [{ id: 'species:x', group: 'species', label: 'Sperlingskauz' }];
  const rec = [{ id: 'rec:1', group: 'recordings', label: 'SK17.wav' }];
  const actions = [act('p', 'Panel: Species lists')];
  assert.deepEqual(paletteSections({ species: sp, recordings: rec }, actions, '').map((s) => s.heading), ['Actions & panels']);
  const s = paletteSections({ species: sp, recordings: rec }, actions, 'sp');
  assert.deepEqual(s.map((x) => x.heading), ['Species', 'Recordings', 'Actions & panels']);
  assert.deepEqual(flatItems(s).map((i) => i.id), ['species:x', 'rec:1', 'p']);
  // nothing found in a group → no heading
  assert.deepEqual(paletteSections({ species: [], recordings: [] }, [], 'zz'), []);
});

test('command search: species become template items; the first one offers the view filter when detections exist', () => {
  const found = [
    { name: 'Sperlingskauz', scientificName: 'Glaucidium passerinum', color: '#5c8', count: 1204 },
    { name: 'Sperlingskauz', scientificName: 'Glaucidium passerinum' },   // duplicate from another source
    { name: 'Sperber', scientificName: 'Accipiter nisus' },
  ];
  const items = speciesItems(found, (sci) => sci === 'Glaucidium passerinum');
  assert.deepEqual(items.map((i) => i.id), ['species:Glaucidium passerinum', 'filter-species:Glaucidium passerinum', 'species:Accipiter nisus']);
  assert.equal(items[0].hint, 'Enter = label template');
  assert.equal(items[0].sub, 'Glaucidium passerinum · 1204 labels');
  assert.equal(items[0].altId, 'filter-species:Glaucidium passerinum');
  assert.match(items[1].label, /Filter view: detected Sperlingskauz/);
  // no detections → no filter row
  assert.equal(speciesItems(found, () => false).length, 2);
});

test('command search: actions from state, spaces except the active one, menus without disabled or nested settings', () => {
  const pm = projectMenu({ kind: 'folder', hasCatalog: true, canRecord: false, xcToFolder: true, recentCount: 0 });
  const sm = settingsMenu({ language: 'de', hasXcKey: false, dark: true });
  const a = paletteActions({
    spaces: [{ id: 'browse', title: 'Browse' }, { id: 'annotate', title: 'Annotate' }], activeSpace: 'annotate',
    panels: [{ id: 'labels', title: 'Labels', space: 'Annotate' }],
    inView: true, hasRecording: true, canAnalyze: true, projectMenu: pm, settingsMenu: sm,
  });
  const ids = a.map((x) => x.id);
  assert.ok(ids.includes('run-birdnet') && ids.includes('mark-done') && ids.includes('space:browse'));
  assert.ok(!ids.includes('space:annotate'));
  assert.ok(ids.includes('panel:labels'));
  assert.ok(!ids.includes('project:open-recent'), 'disabled entry left out');
  assert.ok(!ids.includes('settings:language'), 'nested settings menu left out');
  assert.equal(a.find((x) => x.id === 'settings:theme').hint, 'on');
  assert.equal(a.find((x) => x.id === 'project:add-file').label, 'Audio file');
  // without a recording: no recording actions
  const b = paletteActions({ spaces: [], activeSpace: '', panels: [], inView: false, hasRecording: false, canAnalyze: false, projectMenu: [], settingsMenu: [] });
  assert.deepEqual(b.map((x) => x.id), ['shortcuts']);
});

test('command search: species map to the catalog detection class by scientific, common or BirdNET name', async () => {
  const { detectionClassFor } = await import('../src/app/lite/command-search.ts');
  const classes = ['Strix aluco_Tawny Owl', 'Sperlingskauz', 'Turdus merula'];
  assert.equal(detectionClassFor(classes, 'Strix aluco', 'Waldkauz'), 'Strix aluco_Tawny Owl');
  assert.equal(detectionClassFor(classes, 'Glaucidium passerinum', 'sperlingskauz'), 'Sperlingskauz');
  assert.equal(detectionClassFor(classes, 'turdus merula', ''), 'Turdus merula');
  assert.equal(detectionClassFor(classes, 'Strix', 'Owl'), null, 'no partial names');
  // eBird codes (BirdNET tables exported with codes)
  assert.equal(detectionClassFor(['eurbla', 'cangoo'], 'Turdus merula', 'Common Blackbird', 'eurbla'), 'eurbla');
  assert.equal(detectionClassFor(['eurbla'], 'Turdus merula', 'Common Blackbird'), null);
});

test('command search: an action starting with the query comes before unfamiliar species, not before familiar ones', () => {
  const actions = [act('settings:theme', 'Dark theme')];
  const far = [{ id: 'species:Batis crypta', group: 'species', label: 'Dark Batis' }];
  assert.deepEqual(paletteSections({ species: far }, actions, 'dark').map((s) => s.group), ['actions', 'species']);
  const near = [{ ...far[0], familiar: true }];
  assert.deepEqual(paletteSections({ species: near }, actions, 'dark').map((s) => s.group), ['species', 'actions']);
  // only inside a word ("theme" in "Dark theme" is a word start, "ark" is not) → species stay first
  assert.deepEqual(paletteSections({ species: far }, actions, 'ark').map((s) => s.group), ['species', 'actions']);
  // familiar flag from the taxonomy groups
  const items = speciesItems([{ name: 'A', scientificName: 'a a', group: 'project' }, { name: 'B', scientificName: 'b b', listed: true }, { name: 'C', scientificName: 'c c' }], () => false);
  assert.deepEqual(items.map((i) => !!i.familiar), [true, true, false]);
});
test('Xeno-canto row after the first species, first for "xc …"', () => {
    const found = [{ name: 'Waldkauz', scientificName: 'Strix aluco' }, { name: 'Habichtskauz', scientificName: 'Strix uralensis' }];
    const items = speciesItems(found, () => false, { xc: true });
    assert.deepEqual(items.map((i) => i.id).slice(0, 3), ['species:Strix aluco', 'xc-species:Strix aluco', 'species:Strix uralensis']);
    assert.equal(speciesItems(found, () => false, { xc: true, xcFirst: true })[0].id, 'xc-species:Strix aluco');
    assert.ok(!speciesItems(found, () => false).some((i) => i.id.startsWith('xc-')));
});
