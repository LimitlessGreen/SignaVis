import { test } from 'node:test';
import assert from 'node:assert/strict';
import { catalogFields } from '../src/ui/panels/properties-panel.ts';

test('catalog fields: site, recorder, review (null = new)', () => {
  assert.deepEqual(catalogFields({ site: 'Standort 7', device: 'R17', review: null }),
    [['Site', 'Standort 7'], ['Recorder', 'R17'], ['Review', 'new']]);
  assert.deepEqual(catalogFields({ site: null, device: null, review: 'done' }),
    [['Site', ''], ['Recorder', ''], ['Review', 'done']]);
});
