import test from 'node:test';
import assert from 'node:assert/strict';

// Enter in the label list: Lite opens the label window (onEdit), elsewhere it plays; Space always plays.
test('label list: Enter edits when enterEdits, Space plays', async () => {
  const { LabelList } = await import('../src/ui/panels/label-list.ts');
  const row = { dataset: { labelId: 'a' }, offsetParent: {}, focus() {} };
  const calls = [];
  const ctx = {
    _container: { querySelectorAll: () => [row] },
    _selectedId: 'a',
    _labels: [{ id: 'a' }],
    _onEdit: (id) => calls.push(['edit', id]),
    _onPlaySegment: (l) => calls.push(['play', l.id]),
  };
  const key = (k) => ({ key: k, target: { closest: () => null }, preventDefault() {}, stopPropagation() {} });
  LabelList.prototype._onKey.call({ ...ctx, _enterEdits: true }, key('Enter'));
  LabelList.prototype._onKey.call({ ...ctx, _enterEdits: true }, key(' '));
  LabelList.prototype._onKey.call({ ...ctx, _enterEdits: false }, key('Enter'));
  assert.deepEqual(calls, [['edit', 'a'], ['play', 'a'], ['play', 'a']]);
});
