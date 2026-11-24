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
