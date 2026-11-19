import { test } from 'node:test';
import assert from 'node:assert/strict';
import { listCardMenuItems, speciesRowMenuItems } from '../src/ui/panels/species-lists-panel.ts';
import { similarHitMenuItems } from '../src/ui/panels/similar-panel.ts';

const labels = (items) => items.filter((i) => !i.separator).map((i) => i.label);
const noop = () => {};

test('list card menu: "All species" only offers use, lists get edit/duplicate/export/delete', () => {
  const act = { use: noop, edit: noop, duplicate: noop, exportFile: noop, remove: noop };
  assert.deepEqual(labels(listCardMenuItems(null, false, act)), ['Use for analysis']);
  const items = listCardMenuItems({ id: 'a', name: 'A', species: [], updatedAt: 0 }, true, act);
  assert.equal(items[0].disabled, true);
  assert.equal(items.find((i) => i.label?.startsWith('Export')).disabled, true); // empty list
  assert.equal(items.at(-1).danger, true);
});

test('species row menu copies names and adds to other lists once', () => {
  const calls = [];
  const others = [{ id: 'g', name: 'Garden', species: ['Turdus merula'] }, { id: 'w', name: 'Wood', species: [] }];
  const items = speciesRowMenuItems('Turdus merula', 'Blackbird', others, {
    copy: (t) => calls.push(['copy', t]), addTo: (id) => calls.push(['add', id]), remove: () => calls.push(['rm']),
  });
  assert.deepEqual(labels(items), ['Copy “Blackbird”', 'Copy “Turdus merula”', 'Already on “Garden”', 'Add to “Wood”', 'Remove from list']);
  assert.equal(items.find((i) => i.label === 'Already on “Garden”').disabled, true);
  for (const i of items) if (!i.separator && !i.disabled) i.action();
  assert.deepEqual(calls, [['copy', 'Blackbird'], ['copy', 'Turdus merula'], ['add', 'w'], ['rm']]);
});

test('similar hit menu shows label actions only with a class', () => {
  const h = { path: '/p/a.wav', start: 65, end: 70, score: 0.9 };
  const act = { play: noop, open: noop, label: noop, copy: noop, query: noop };
  assert.ok(!labels(similarHitMenuItems(h, undefined, act)).some((l) => l.startsWith('Mark')));
  const withCls = labels(similarHitMenuItems(h, 'pos', act));
  assert.ok(withCls.includes('Clear positive') && withCls.includes('Mark negative'));
  assert.ok(withCls.includes('Copy “a.wav @ 1:05.0”'));
});

test('explore species card menu leaves out missing actions', async () => {
  const { speciesCardMenuItems } = await import('../src/ui/panels/explore-panel.ts');
  const lists = [{ id: 'g', name: 'Garden', species: ['parus major'] }];
  const all = speciesCardMenuItems({ name: 'Great Tit', scientificName: 'Parus major' }, lists,
    { select: noop, refCalls: noop, addTo: noop, copy: noop });
  assert.deepEqual(labels(all), ['Use as label species', 'Reference calls…', 'Already on “Garden”', 'Copy “Great Tit”', 'Copy “Parus major”']);
  const bare = speciesCardMenuItems({ name: 'Parus major', scientificName: 'Parus major' }, lists,
    { select: null, refCalls: null, addTo: null, copy: noop });
  assert.deepEqual(labels(bare), ['Copy “Parus major”']);
  assert.ok(!bare[0].separator);
});
