import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setMenuItems, setBarActions, setKeyAction } from '../src/ui/panels/set-actions.ts';
import { removeSetLabels, soloHidden, isSoloSet, setDisplayName } from '../src/app/annotation-sets.ts';

const noop = () => {};
const labels = (items) => items.filter((i) => !i.separator).map((i) => i.label);
const base = { id: 's', name: 'S', hidden: false, solo: false, locked: false, lockable: true, pending: 0, total: 3, recordings: 1, scope: 'session' };
const all = { rename: noop, toggleHidden: noop, solo: noop, adopt: noop, toggleAdopted: noop, toggleLock: noop, openSource: noop, remove: noop, addLayer: noop };

test('imported set: copy first, remove last and red', () => {
  const s = { ...base, kind: 'imported', locked: true, pending: 12, uri: 'https://xeno-canto.org/1', sourceName: 'xeno-canto', showAdopted: false };
  const items = setMenuItems(s, all);
  assert.equal(items[0].label, 'Copy 12 labels to my labels');
  assert.equal(items[0].shortcut, 'C');
  assert.ok(labels(items).includes('Rename…'));
  assert.ok(labels(items).includes('Open on xeno-canto ↗'));
  assert.ok(labels(items).includes('Show labels already in my labels'));
  assert.equal(items.at(-1).label, 'Remove set');
  assert.equal(items.at(-1).danger, true);
  assert.equal(items.at(-2).separator, true);
});

test('own set: rename, new layer, clear instead of remove, never lockable', () => {
  const s = { ...base, kind: 'own', lockable: false, recordings: 4 };
  const l = labels(setMenuItems(s, all));
  assert.deepEqual(l.filter((x) => /Rename|layer|Lock/.test(x)), ['Rename…', 'New layer…']);
  assert.equal(l.at(-1), 'Clear my labels in all 4 recordings');
  assert.ok(!l.some((x) => x.startsWith('Copy')));
});

test('Labels tab names the scope when the set is used in several recordings', () => {
  const s = { ...base, kind: 'imported', scope: 'recording', recordings: 6 };
  const calls = [];
  const items = setMenuItems(s, { remove: (w) => calls.push(w) });
  assert.deepEqual(labels(items), ['Remove from this recording', 'Remove from all 6 recordings']);
  items.forEach((i) => i.action());
  assert.deepEqual(calls, ['recording', 'all']);
  // one recording only → plain "Remove set" for the whole set
  assert.deepEqual(labels(setMenuItems({ ...s, recordings: 1 }, { remove: noop })), ['Remove set']);
  // own set without labels here: clearing is disabled
  const own = setMenuItems({ ...base, kind: 'own', scope: 'recording', total: 0, recordings: 1 }, { remove: noop });
  assert.equal(own[0].disabled, true);
});

test('missing handlers leave entries out; nothing left → one disabled entry', () => {
  assert.deepEqual(setMenuItems({ ...base, kind: 'manual' }, {}).map((i) => i.disabled), [true]);
  const l = labels(setMenuItems({ ...base, kind: 'manual' }, { rename: noop }));
  assert.deepEqual(l, ['Rename…']);
});

test('action bar: copy (primary) · rename · source · remove (danger), as short labels', () => {
  const s = { ...base, kind: 'imported', pending: 9, uri: 'u', sourceName: 'xeno-canto' };
  const bar = setBarActions(s, all);
  assert.deepEqual(bar.map((a) => a.label), ['Copy 9', 'Rename', 'XC', 'Remove']);
  assert.equal(bar[0].tone, 'primary');
  assert.equal(bar.at(-1).tone, 'danger');
  const own = setBarActions({ ...base, kind: 'own', lockable: false }, all);
  assert.deepEqual(own.map((a) => a.label), ['Rename', 'Layer', 'Clear']);
  // nothing to copy any more → no copy button
  assert.ok(!setBarActions({ ...s, pending: 0 }, all).some((a) => a.key === 'adopt'));
});

test('keys: F2 rename, Del first remove entry, H hide, C copy; modifiers do nothing', () => {
  const calls = [];
  const h = { rename: () => calls.push('rename'), toggleHidden: () => calls.push('hide'), adopt: () => calls.push('copy'), remove: (w) => calls.push('rm:' + w) };
  const s = { ...base, kind: 'imported', pending: 2, scope: 'recording', recordings: 3 };
  for (const key of ['F2', 'Delete', 'h', 'c']) setKeyAction(s, h, { key })();
  assert.deepEqual(calls, ['rename', 'rm:recording', 'hide', 'copy']);
  assert.equal(setKeyAction(s, h, { key: 'c', ctrlKey: true }), null);
  assert.equal(setKeyAction({ ...s, pending: 0 }, h, { key: 'c' }), null);
});

test('removeSetLabels: all recordings, or only the one on screen', () => {
  const live = [{ id: 1, setId: 'xc' }, { id: 2, setId: 'own' }, { id: 3 }];
  const entries = [
    { id: 'a', annotations: live },
    { id: 'b', annotations: [{ id: 4, setId: 'xc' }, { id: 5, setId: 'bn' }] },
    { id: 'c', annotations: [{ id: 6, setId: 'bn' }] },
  ];
  const r = removeSetLabels('xc', 'all', live, entries, 'a', 'own');
  assert.deepEqual(r.live.map((l) => l.id), [2, 3]);
  assert.deepEqual([...r.entries.keys()], ['b']);
  assert.deepEqual(r.entries.get('b').map((l) => l.id), [5]);
  assert.equal(r.removed, 2);
  assert.equal(r.usedElsewhere, false);

  const one = removeSetLabels('xc', 'recording', live, entries, 'a', 'own');
  assert.equal(one.entries.size, 0);
  assert.equal(one.removed, 1);
  assert.equal(one.usedElsewhere, true);   // b still has an xc label → set stays

  // labels without setId belong to the own set
  assert.deepEqual(removeSetLabels('own', 'recording', live, entries, 'a', 'own').live.map((l) => l.id), [1]);
});

test('solo: hide the others; again → show all', () => {
  const ids = ['own', 'xc', 'bn'];
  const h1 = soloHidden(new Set(), ids, 'xc');
  assert.deepEqual([...h1].sort(), ['bn', 'own']);
  assert.equal(isSoloSet(h1, ids, 'xc'), true);
  assert.deepEqual([...soloHidden(h1, ids, 'xc')], []);
  // a hidden set made solo is shown
  assert.deepEqual([...soloHidden(new Set(['xc']), ids, 'xc')].sort(), ['bn', 'own']);
});

test('display name: imported sets keep their XC name and show the user\'s name', () => {
  assert.equal(setDisplayName({ name: 'XC123 set', displayName: 'Owls (Smith)' }), 'Owls (Smith)');
  assert.equal(setDisplayName({ name: 'XC123 set' }), 'XC123 set');
  assert.equal(setDisplayName(null, 'My labels'), 'My labels');
});
