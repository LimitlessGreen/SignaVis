import test from 'node:test';
import assert from 'node:assert/strict';

import {
    normalizeFilter, sameFilter, isEmptyFilter, sunWindowLabel, sameSunWindow, copyName, datasetCountText, SUN_PRESETS,
} from '../src/domain/catalog/catalog-types.ts';

test('sameFilter ignores empty parts, key order and id order', () => {
    assert.ok(sameFilter({ siteIds: [3, 1], pathContains: '', hasLabels: null, unassigned: false }, { siteIds: [1, 3] }));
    assert.ok(!sameFilter({ siteIds: [1] }, { siteIds: [1, 2] }));
    assert.ok(sameFilter({ sun: { from: { event: 'sunset' }, to: { event: 'sunrise', offsetMin: 0 } } },
        { sun: { from: { event: 'sunset', offsetMin: 0 }, to: { event: 'sunrise' } } }));
    assert.ok(isEmptyFilter({ siteIds: [], bbox: null }));
    assert.ok(!isEmptyFilter({ datasetId: 4 }));
    assert.deepEqual(Object.keys(normalizeFilter({ toMs: 1, fromMs: 0 })), ['fromMs', 'toMs']);
});

test('sun window labels and comparison', () => {
    assert.equal(sunWindowLabel(SUN_PRESETS[0].w), 'sunset − 1 h → sunrise');
    assert.equal(sunWindowLabel({ from: { event: 'dusk', offsetMin: 90 }, to: { event: 'dawn', offsetMin: -30 } }), 'civil dusk + 1 h 30 min → civil dawn − 30 min');
    assert.ok(sameSunWindow(null, undefined));
    assert.ok(!sameSunWindow(SUN_PRESETS[0].w, SUN_PRESETS[1].w));
});

test('copyName avoids taken names (case-insensitive)', () => {
    assert.equal(copyName('Night', ['Night']), 'Night (copy)');
    assert.equal(copyName('Night', ['night (copy)', 'Night (copy 2)']), 'Night (copy 3)');
    assert.equal(copyName('Night', [], true), 'Night (snapshot)');
});

test('datasetCountText', () => {
    const d = { recordings: 1, ranges: 0, error: null };
    assert.equal(datasetCountText(d), '1 recording');
    assert.equal(datasetCountText({ ...d, recordings: 12, ranges: 2 }), '12 recordings · 2 ranges');
    assert.equal(datasetCountText({ ...d, error: 'x' }), 'filter refers to a deleted dataset');
});
