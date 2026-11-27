import test from 'node:test';
import assert from 'node:assert/strict';
import { groupQuickRows } from '../src/ui/components/label-editor/QuickLabelPicker.ts';

const found = [
  { name: 'Sperber', scientificName: 'Accipiter nisus', group: 'taxonomy', listed: true },
  { name: 'Sperbergrasmücke', scientificName: 'Curruca nisoria', group: 'taxonomy' },
  { name: 'Sperlingskauz', scientificName: 'Glaucidium passerinum', group: 'project' },
];

test('quick picker: recording first, then species list, then all; no duplicates', () => {
  const rows = groupQuickRows([{ name: 'Sperlingskauz', scientificName: 'Glaucidium passerinum', color: '#0f0' }], found, 'sper');
  assert.deepEqual(rows.map((r) => [r.group, r.s.name]), [
    ['recording', 'Sperlingskauz'], ['list', 'Sperber'], ['all', 'Sperbergrasmücke'],
  ]);
  assert.equal(rows[0].s.color, '#0f0');
});

test('quick picker: existing labels are filtered by the query, at most 9 rows', () => {
  const rows = groupQuickRows([{ name: 'Amsel' }], found, 'sper');
  assert.ok(!rows.some((r) => r.s.name === 'Amsel'));
  const many = Array.from({ length: 20 }, (_, i) => ({ name: `Art ${i}`, group: 'taxonomy' }));
  const r = groupQuickRows([], many, '');
  assert.equal(r.length, 9);
  assert.equal(r.more, 11);
});

test('quick picker: hints (count + sound here, unexpected only when the place is known)', () => {
  const rows = groupQuickRows([{ name: 'Sperlingskauz', count: 2, tags: { soundType: 'song' } }],
    [{ name: 'Sperbergrasmücke', group: 'taxonomy' }, { name: 'Sperber', group: 'taxonomy', local: true }], 'sper');
  assert.deepEqual(rows.map((r) => r.hint), ['2× · song', 'unexpected here', '']);
  assert.equal(groupQuickRows([], [{ name: 'Sperber', group: 'taxonomy' }], '')[0].hint, '');
});
