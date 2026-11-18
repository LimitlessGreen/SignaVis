import test from 'node:test';
import assert from 'node:assert/strict';
import { dedupeLabels, dedupeBy } from '../src/app/labeling/dedupe-labels.ts';

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

test('dedupeLabels treats id 0 as an id', () => {
    const a = { id: 0, start: 1 }, b = { id: 0, start: 5 };
    assert.deepEqual(dedupeLabels([a, b]), [a]);
});

test('dedupeLabels without id tells start 0 from a missing start', () => {
    const a = { setId: 's', start: 0, end: 1 }, b = { setId: 's', end: 1 };
    assert.deepEqual(dedupeLabels([a, b]), [a, b]);
});

test('dedupeLabels: an id never collides with a composite key', () => {
    const withId = { id: '1:2:Turdus' };
    const noId = { setId: 'id', start: 1, end: 2, scientificName: 'Turdus' };
    assert.deepEqual(dedupeLabels([withId, noId]), [withId, noId]);
});

test('dedupeBy keeps the first item per label and the item itself', () => {
    const items = [{ label: { id: 'a' }, entry: 1 }, { label: { id: 'a' }, entry: 2 }, { label: { id: 'b' }, entry: 2 }];
    assert.deepEqual(dedupeBy(items, (x) => x.label).map((x) => x.entry), [1, 2]);
});
