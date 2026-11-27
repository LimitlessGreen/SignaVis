import test from 'node:test';
import assert from 'node:assert/strict';

import { dropdownPlacement } from '../src/ui/components/taxonomy-ui/taxonomy-ui.ts';

test('dropdownPlacement: below the field when there is room (top bar)', () => {
    assert.deepEqual(dropdownPlacement({ top: 30, bottom: 60 }, 900), { top: 62, maxHeight: 320 });
});

test('dropdownPlacement: above the field near the bottom of the window (label bar)', () => {
    // Field at 842–870 in a 900 px window: 20 px below, 832 above.
    assert.deepEqual(dropdownPlacement({ top: 842, bottom: 870 }, 900), { bottom: 60, maxHeight: 320 });
});

test('dropdownPlacement: little room either way keeps the larger side, list shortened', () => {
    assert.deepEqual(dropdownPlacement({ top: 150, bottom: 180 }, 400), { top: 182, maxHeight: 210 });
    assert.deepEqual(dropdownPlacement({ top: 250, bottom: 280 }, 400), { bottom: 152, maxHeight: 240 });
});
