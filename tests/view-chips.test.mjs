import test from 'node:test';
import assert from 'node:assert/strict';

import { chipsText, viewChips, withoutChip } from '../src/domain/catalog/view-chips.ts';

const facets = { total: 5, sites: [{ id: 1, name: 'S1', count: 3 }, { id: 2, name: 'S2', count: 2 }], devices: [], tags: [{ id: 7, name: 'rain', count: 1 }] };
const datasets = [{ id: 3, name: 'Week 1', kind: 'static', color: '#ff0000' }, { id: 5, name: 'Nights', kind: 'filter', filter: { hourFrom: 18, hourTo: 6 } }];

test('viewChips: one chip per filter part, facet values by name, in a fixed order', () => {
    const chips = viewChips({ datasetId: 3, siteIds: [2, 9], tagIds: [7], hourFrom: 18, hourTo: 6, bbox: [51, 8, 52, 9] }, facets, datasets,
        (field, name) => `${field}:${name}`);
    assert.deepEqual(chips.map((c) => [c.kind, c.field, c.label, c.id ?? null]), [
        ['dataset', 'Dataset', 'Week 1', null],
        ['site', 'Site', 'S2', 2],
        ['site', 'Site', '#9', 9],
        ['tag', 'Tag', '#rain', 7],
        ['tod', 'Time', '18–06 h', null],
        ['bbox', 'Area', chips[5].label, null],
    ]);
    assert.equal(chips[0].color, '#ff0000');
    assert.equal(chips[1].color, 'site:S2');
    assert.equal(chipsText(chips.slice(1, 2)), 'Site S2');
    assert.deepEqual(viewChips({}, facets, datasets), []);
});

test('withoutChip: removes one value, leaves the input alone, closes a static dataset', () => {
    const f = { datasetId: 3, siteIds: [1, 2] };
    const r = withoutChip(f, 3, datasets[0], 'site', 1);
    assert.deepEqual(r.filter.siteIds, [2]);
    assert.deepEqual(f.siteIds, [1, 2], 'input not changed');
    assert.equal(r.activeDs, 3);
    assert.equal(withoutChip(f, 3, datasets[0], 'dataset').activeDs, null);
    // A dynamic dataset stays open (its filter was only edited: "Save filter" / "Revert").
    assert.equal(withoutChip({ hourFrom: 18, hourTo: 6 }, 5, datasets[1], 'tod').activeDs, 5);
    assert.deepEqual(withoutChip(f, 3, datasets[0], 'all'), { filter: {}, activeDs: null });
});

test('viewChips: local days read as Date, one day without a range', () => {
    const one = viewChips({ localDayFrom: '2023-03-20', localDayTo: '2023-03-20' }, facets, datasets, () => '');
    assert.deepEqual(one.map((c) => [c.field, c.label]), [['Date', '2023-03-20']]);
    const open = viewChips({ localDayFrom: '2023-03-20' }, facets, datasets, () => '');
    assert.equal(open[0].label, '2023-03-20 – …');
});

test('viewChips: a detection filter is a removable chip (score shown only above 0)', () => {
    const any = viewChips({ detection: { class: 'Glaucidium passerinum', minScore: 0, runId: null } }, facets, datasets, () => '');
    assert.deepEqual(any.map((c) => [c.kind, c.field, c.label]), [['detection', 'Detected', 'Glaucidium passerinum']]);
    const min = viewChips({ detection: { class: 'Strix aluco', minScore: 0.5 } }, facets, datasets, () => '');
    assert.equal(min[0].label, 'Strix aluco ≥ 0.50');
    assert.equal(withoutChip({ detection: { class: 'x', minScore: 0 } }, null, null, 'detection').filter.detection, null);
    // the app names codes (eBird "eurbla" → Amsel)
    const named = viewChips({ detection: { class: 'eurbla', minScore: 0 } }, facets, datasets, () => '', (c) => (c === 'eurbla' ? 'Amsel' : ''));
    assert.equal(named[0].label, 'Amsel');
});

test('unknown start time is a removable chip; removing it keeps the other filters', () => {
    const chips = viewChips({ noStart: true, hourFrom: 18, hourTo: 6 }, facets, datasets);
    assert.ok(chips.some((c) => c.kind === 'nostart'));
    const r = withoutChip({ noStart: true, hourFrom: 18, hourTo: 6 }, null, null, 'nostart');
    assert.equal(r.filter.noStart, false);
    assert.equal(r.filter.hourFrom, 18);
});

test('period chip: an end inside a day names that day', () => {
    const chips = viewChips({ fromMs: Date.UTC(2023, 2, 9), toMs: Date.UTC(2023, 2, 9, 18) }, facets, datasets);
    assert.match(chips.find((c) => c.kind === 'period').label, /03-09 – .*03-09|9.*–.*9/);
});
