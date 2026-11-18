import { test } from 'node:test';
import assert from 'node:assert/strict';
import { filterHelp } from '../src/app/labeling/help-menu.ts';

const items = [
  { group: 'Learn', icon: '', label: 'Shortcuts & help', keywords: 'keyboard keys', action() {} },
  { group: 'SignaVis', icon: '', label: 'Privacy policy', keywords: 'gdpr datenschutz', action() {} },
];
const shortcuts = [{ keys: 'Space', desc: 'Play / Pause' }, { keys: 'Ctrl + Z', desc: 'Undo' }];

test('empty query lists all items and no shortcuts', () => {
  const r = filterHelp(items, shortcuts, '  ');
  assert.equal(r.items.length, 2);
  assert.equal(r.shortcuts.length, 0);
});

test('query matches labels, keywords and shortcuts, every word must hit', () => {
  assert.deepEqual(filterHelp(items, shortcuts, 'GDPR').items.map((i) => i.label), ['Privacy policy']);
  assert.deepEqual(filterHelp(items, shortcuts, 'undo').shortcuts, [{ keys: 'Ctrl + Z', desc: 'Undo' }]);
  assert.deepEqual(filterHelp(items, shortcuts, 'play pause').shortcuts.map((s) => s.keys), ['Space']);
  assert.equal(filterHelp(items, shortcuts, 'play undo').shortcuts.length, 0);
});

test('matching ignores accents and case', () => {
  assert.equal(filterHelp([{ ...items[0], label: 'Économie' }], [], 'econ').items.length, 1);
});
