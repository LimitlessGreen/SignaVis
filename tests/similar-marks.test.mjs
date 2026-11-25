import test from 'node:test';
import assert from 'node:assert/strict';
import { clickTile, hitLabels, alreadyMarked } from '../src/app/similar-marks.ts';

test('clickTile: toggle, anchor, shift range', () => {
  let s = { sel: new Set(), anchor: -1 };
  s = clickTile(s, 2);
  assert.deepEqual([...s.sel], [2]);
  s = clickTile(s, 5, { shift: true });
  assert.deepEqual([...s.sel].sort(), [2, 3, 4, 5]);
  s = clickTile(s, 3);
  assert.deepEqual([...s.sel].sort(), [2, 4, 5]);
  assert.equal(s.anchor, 3);
});

let n = 0;
const id = () => `L${++n}`;
const tpl = { name: 'Sperlingskauz', scientificName: 'Glaucidium passerinum', color: '#5cc98a' };
const hits = [
  { path: 'a.wav', start: 10, end: 15, score: 0.9 },
  { path: 'a.wav', start: 40, end: 45, score: 0.8 },
  { path: 'b.wav', start: 0, end: 5, score: 0.7 },
];

test('hitLabels: time-only labels per recording, absent flag, provenance', () => {
  const m = hitLabels(hits, tpl, 'present', { setId: 'own', layer: 'L', id, existing: () => [], query: { path: 'q.wav', start: 3 } });
  assert.equal(m.get('a.wav').length, 2);
  const l = m.get('b.wav')[0];
  assert.equal(l.fullBand, true);
  assert.equal(l.scientificName, 'Glaucidium passerinum');
  assert.equal(l.setId, 'own');
  assert.equal(l.polarity, undefined);
  assert.equal(l.adoptedFrom.origin, 'Similar');
  assert.equal(l.adoptedFrom.similar.score, 0.7);
  const abs = hitLabels(hits.slice(2), tpl, 'absent', { setId: 'own', id, existing: () => [] });
  assert.equal(abs.get('b.wav')[0].polarity, 'absent');
});

test('hitLabels: skips hits already marked the same way, not the other way', () => {
  const have = [{ scientificName: 'Glaucidium passerinum', start: 11, end: 16 }];
  const m = hitLabels(hits, tpl, 'present', { setId: 'own', id, existing: (p) => (p === 'a.wav' ? have : []) });
  assert.equal(m.get('a.wav').length, 1);
  assert.equal(m.get('a.wav')[0].start, 40);
  assert.equal(alreadyMarked(hits[0], 'Glaucidium passerinum', '', 'absent', have), false);
});
