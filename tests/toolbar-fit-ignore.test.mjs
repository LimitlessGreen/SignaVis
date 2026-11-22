import test from 'node:test';
import assert from 'node:assert/strict';
import { ignoredForFit, readoutLengthChanged } from '../src/app/player/ToolbarFitController.ts';

// The fit observer must skip the live playback time: it changes every frame, and each
// re-fit reset the toolbar classes and forced several layouts.
const el = (ignored) => ({ nodeType: 1, closest: (sel) => (sel === '[data-fit-ignore]' && ignored ? {} : null) });
const text = (parent) => ({ nodeType: 3, parentElement: parent });

test('text changes inside [data-fit-ignore] do not trigger a re-fit', () => {
    assert.equal(ignoredForFit(text(el(true))), true);
    assert.equal(ignoredForFit(el(true)), true);
});

test('other toolbar changes still trigger a re-fit', () => {
    assert.equal(ignoredForFit(text(el(false))), false);
    assert.equal(ignoredForFit(el(false)), false);
    assert.equal(ignoredForFit(text(null)), false);
});

test('an ignored readout that changes its length (99:59.9 → 100:00.0) triggers a re-fit', () => {
    const readout = { textContent: '99:59.8', closest: () => readout };
    const node = { nodeType: 3, parentElement: readout };
    const seen = new WeakMap();
    assert.equal(readoutLengthChanged(seen, node), false);   // first sight: nothing to compare
    readout.textContent = '99:59.9';
    assert.equal(readoutLengthChanged(seen, node), false);   // same width
    readout.textContent = '100:00.0';
    assert.equal(readoutLengthChanged(seen, node), true);
    assert.equal(readoutLengthChanged(seen, node), false);
    assert.equal(readoutLengthChanged(seen, { nodeType: 3, parentElement: { closest: () => null } }), false);
});
