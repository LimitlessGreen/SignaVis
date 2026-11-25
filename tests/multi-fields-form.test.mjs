import test from 'node:test';
import assert from 'node:assert/strict';
import { tally, updatesFor } from '../src/ui/components/label-modal/multi-fields-form.ts';

const ls = [
  { id: 'a', label: 'Sperlingskauz', tags: { soundType: 'song', sex: 'male', quality: 'A' } },
  { id: 'b', label: 'Sperlingskauz', tags: { soundType: 'song', sex: 'male' } },
  { id: 'c', label: 'Sperlingskauz', tags: { soundType: 'call' }, colorCustom: true, color: '#123456' },
];

test('tally: counts per value, most frequent first, empty as ""', () => {
  assert.deepEqual(tally(ls, (l) => l.label), [['Sperlingskauz', 3]]);
  assert.deepEqual(tally(ls, (l) => l.tags.soundType), [['song', 2], ['call', 1]]);
  assert.deepEqual(tally(ls, (l) => l.tags.sex), [['male', 2], ['', 1]]);
});

test('updatesFor: a tag is merged into each label\'s own tags; "" removes it', () => {
  assert.deepEqual(updatesFor(ls[0], { tag: 'soundType', value: 'call' }), { tags: { soundType: 'call', sex: 'male', quality: 'A' } });
  assert.deepEqual(updatesFor(ls[0], { tag: 'quality', value: '' }), { tags: { soundType: 'song', sex: 'male' } });
  assert.deepEqual(updatesFor(ls[2], { tag: 'sex', value: 'female' }), { tags: { soundType: 'call', sex: 'female' } });
});

test('updatesFor: species sets the colour unless the label has its own', () => {
  const u = updatesFor(ls[0], { set: { label: 'Waldkauz', scientificName: 'Strix aluco', commonName: '' } });
  assert.equal(u.label, 'Waldkauz');
  assert.ok(u.color);
  assert.equal(updatesFor(ls[2], { set: { label: 'Waldkauz' } }).color, undefined);
});
