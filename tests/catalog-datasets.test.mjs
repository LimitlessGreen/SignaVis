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

import { fmtClock, parseClock, rangeFromDrag } from '../src/domain/catalog/catalog-types.ts';

test('fmtClock / parseClock round trip', () => {
    assert.equal(fmtClock(5), '0:05');
    assert.equal(fmtClock(83.5), '1:23.5');
    assert.equal(fmtClock(3725), '1:02:05');
    assert.equal(parseClock('83'), 83);
    assert.equal(parseClock('1:23,5'), 83.5);
    assert.equal(parseClock('0:01:23'), 83);
    assert.equal(parseClock('1:75'), null);
    assert.equal(parseClock('abc'), null);
    for (const s of [0, 9.9, 61.2, 3599]) assert.equal(parseClock(fmtClock(s)), s);
});

test('rangeFromDrag orders, clamps and rounds; rejects tiny drags', () => {
    assert.deepEqual(rangeFromDrag(600, 300, 1200, 60), [15, 30]);
    assert.deepEqual(rangeFromDrag(-50, 1300, 1200, 60), [0, 60]);
    assert.deepEqual(rangeFromDrag(100, 101, 1200, 60), null);
    assert.deepEqual(rangeFromDrag(0, 10, 0, 60), null);
});

test('normalizeFilter keeps explicit "without" choices, drops default flags, orders detection fields', async () => {
    const { normalizeFilter, sameFilter, isEmptyFilter } = await import('../src/domain/catalog/catalog-types.ts');
    assert.deepEqual(normalizeFilter({ hasPosition: false }), { hasPosition: false });
    assert.equal(sameFilter({ hasLabels: false }, {}), false);
    assert.equal(isEmptyFilter({ hasPosition: false }), false);
    assert.deepEqual(normalizeFilter({ noStart: false, unassigned: false }), {});
    assert.equal(sameFilter({ detection: { class: 'owl', minScore: 0.5 } }, { detection: { minScore: 0.5, class: 'owl' } }), true);
});

test('rangeFromDrag stays within a fractional duration and accepts the minimum length', async () => {
    const { rangeFromDrag, typedRange } = await import('../src/domain/catalog/catalog-types.ts');
    assert.deepEqual(rangeFromDrag(0, 1200, 1200, 60.06), [0, 60.06]);
    assert.deepEqual(rangeFromDrag(300, 304, 1200, 60), [15, 15.2]);
    assert.equal(rangeFromDrag(300, 302, 1200, 60), null, 'shorter than 0.2 s');
    assert.deepEqual(typedRange(1, 10.04, 10), [1, 10], 'rounded display value of the end');
    assert.equal(typedRange(10.01, 10.04, 10), null, 'start past the end after clamping');
    assert.equal(typedRange(2, 1, 10), null);
    assert.equal(typedRange(-1, 1, 10), null);
    assert.equal(typedRange(1, 11, 10), null);
    assert.deepEqual(typedRange(1, 500, null), [1, 500], 'unknown duration');
});

test('coverageMatrix: indexed cells, most recent weeks when there are too many', async () => {
    const { coverageMatrix } = await import('../src/domain/catalog/catalog-types.ts');
    const cell = (week) => ({ siteId: 1, week, recordings: 1, seconds: 1, days: 1 });
    const m = coverageMatrix({ sites: [[1, 'A']], weeks: [cell('2000-01-03'), cell('2000-02-07')] }, 3);
    assert.equal(m.weeks.length, 3);
    assert.equal(m.hiddenWeeks, 3);
    assert.equal(m.weeks.at(-1), '2000-02-07');
    assert.equal(m.rows[0].cells.at(-1)?.week, '2000-02-07', 'the last observation is shown');
});
