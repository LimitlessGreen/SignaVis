import test from 'node:test';
import assert from 'node:assert/strict';
import { dedupeLabels } from '../src/app/labeling/dedupe-labels.ts';

test('dedupeLabels keeps the first label per id, in order', () => {
    const a = { id: 'a', start: 1 }, b = { id: 'b', start: 2 }, a2 = { id: 'a', start: 9 };
    assert.deepEqual(dedupeLabels([a, b, a2]), [a, b]);
});

test('dedupeLabels without id keys by set, time and species', () => {
    const x = { setId: 's', start: 1, end: 2, scientificName: 'Turdus merula' };
    const same = { ...x };
    const other = { ...x, setId: 't' };
    assert.deepEqual(dedupeLabels([x, same, other]), [x, other]);
});

test('dedupeLabels on no array returns []', () => {
    assert.deepEqual(dedupeLabels(null), []);
    assert.deepEqual(dedupeLabels(undefined), []);
});
