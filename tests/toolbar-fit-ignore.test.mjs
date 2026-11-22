import test from 'node:test';
import assert from 'node:assert/strict';
import { ignoredForFit } from '../src/app/player/ToolbarFitController.ts';

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
