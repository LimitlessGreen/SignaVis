import test from 'node:test';
import assert from 'node:assert/strict';

import { CatalogView, VIEW_PAGE } from '../src/domain/catalog/catalog-view.ts';

/** Fake catalog: `n` recordings with ids 1..n; filter.siteIds keeps ids whose (id % 3) is in it. */
function fakeApi(n, opts = {}) {
    const calls = { facets: 0, list: 0, datasets: 0 };
    const all = Array.from({ length: n }, (_, i) => ({ id: i + 1, path: `r${i + 1}.wav` }));
    const match = (f) => all.filter((r) => !f.siteIds?.length || f.siteIds.includes(r.id % 3));
    return {
        calls,
        datasets: opts.datasets ?? [],
        api: {
            async facets(_root, f) {
                calls.facets++;
                if (opts.fail) throw new Error('db locked');
                await opts.delay?.(f);
                return { total: match(f).length, sites: [], devices: [], tags: [] };
            },
            async heatmap() { return [{ day: '2026-03-15', hour: 20, count: 1 }]; },
            async list(_root, f, _sort, after, limit) {
                calls.list++;
                const rows = match(f);
                const start = after ? rows.findIndex((r) => r.id === after.id) + 1 : 0;
                const page = rows.slice(start, start + limit);
                const last = page[page.length - 1];
                return { rows: page, next: start + limit < rows.length ? { id: last.id } : null };
            },
            async datasets() { calls.datasets++; return opts.datasets ?? []; },
        },
    };
}

const changes = (view) => {
    const seen = [];
    view.subscribe((c) => seen.push(c));
    return seen;
};

test('reload loads facets and the first page, then announces query and rows', async () => {
    const { api } = fakeApi(1200);
    const v = new CatalogView('/p', api);
    const seen = changes(v);
    await v.reload();
    assert.equal(v.total, 1200);
    assert.equal(v.rows.length, VIEW_PAGE);
    assert.ok(v.hasMore);
    assert.deepEqual(seen, ['loading', 'query', 'rows', 'ready']);
    assert.equal(v.loading, false);
});

test('rowAt pages forward until the row is there', async () => {
    const { api } = fakeApi(1200);
    const v = new CatalogView('/p', api);
    await v.reload();
    const r = await v.rowAt(1100);
    assert.equal(r.id, 1101);
    assert.equal(v.rows.length, 1200);
    assert.equal(await v.rowAt(5000), null);
});

test('a newer filter wins over a slower older reload', async () => {
    let release;
    const gate = new Promise((r) => { release = r; });
    const { api } = fakeApi(30, { delay: (f) => (f.siteIds?.[0] === 1 ? gate : null) });
    const v = new CatalogView('/p', api);
    const slow = v.setFilter({ siteIds: [1] });
    await v.setFilter({ siteIds: [2] });
    release();
    await slow;
    assert.deepEqual(v.filter, { siteIds: [2] });
    assert.ok(v.rows.every((r) => r.id % 3 === 2));
    assert.equal(v.total, 10);
});

test('errors are kept in the view, not thrown', async () => {
    const { api } = fakeApi(5, { fail: true });
    const v = new CatalogView('/p', api);
    const seen = changes(v);
    await v.reload();
    assert.equal(v.facets, null);
    assert.match(v.error, /db locked/);
    assert.deepEqual(seen, ['loading', 'query', 'ready']);
});

test('select: click, ctrl and shift build the picks; reload clears them unless kept', async () => {
    const { api } = fakeApi(20);
    const v = new CatalogView('/p', api);
    await v.reload();
    v.select(2);
    assert.deepEqual([...v.picked], [3]);
    v.select(5, { shift: true });
    assert.deepEqual([...v.picked].sort((a, b) => a - b), [3, 4, 5, 6]);
    v.select(9, { ctrl: true });
    assert.equal(v.pickedCount, 5);
    assert.equal(v.current, 9);
    assert.deepEqual(v.selection.ids.length, 5);
    await v.reload({ keepPicks: true });
    assert.equal(v.pickedCount, 5);
    assert.equal(v.current, -1, 'the current row belongs to the old row order');
    await v.reload();
    assert.equal(v.pickedCount, 0);
});

test('selectAllShown: the selection is a copy of the filter', async () => {
    const { api } = fakeApi(20);
    const v = new CatalogView('/p', api);
    await v.setFilter({ siteIds: [1] });
    v.selectAllShown();
    const sel = v.selection;
    assert.equal(v.pickedCount, 7);
    assert.ok(v.isPicked(999));
    v.filter.siteIds.push(2);
    assert.deepEqual(sel.filter.siteIds, [1], 'later edits must not widen a bulk edit');
    v.pickIds([4, 5]);
    assert.equal(v.pickAll, false);
    assert.deepEqual(v.selection, { ids: [4, 5] });
    v.selectNone();
    assert.deepEqual(v.selection, {});
});

test('datasets: open static and dynamic, dirty when the filter differs, dropped when deleted', async () => {
    const datasets = [
        { id: 1, name: 'Fixed', kind: 'static', recordings: 3, ranges: 0 },
        { id: 2, name: 'Night', kind: 'filter', filter: { siteIds: [1] }, recordings: 7, ranges: 0 },
    ];
    const f = fakeApi(20, { datasets });
    const v = new CatalogView('/p', f.api);
    await v.openDataset(1);
    assert.deepEqual(v.filter, { datasetId: 1 });
    assert.equal(v.active.name, 'Fixed');
    await v.openDataset(2);
    assert.deepEqual(v.filter, { siteIds: [1] });
    assert.equal(v.dirty, false);
    await v.updateFilter((x) => { x.siteIds = [1, 2]; });
    assert.equal(v.dirty, true);
    assert.deepEqual(datasets[1].filter, { siteIds: [1] }, 'the saved filter is not changed in place');
    datasets.splice(1, 1);
    v.datasetsChanged();
    await v.reload();
    assert.equal(v.activeDs, null);
    await v.openDataset(null);
    assert.deepEqual(v.filter, {});
});

test('dataset counts are not re-read on every filter change', async () => {
    const f = fakeApi(20);
    const v = new CatalogView('/p', f.api);
    await v.reload();
    await v.updateFilter((x) => { x.siteIds = [1]; });
    await v.updateFilter((x) => { x.siteIds = [2]; });
    assert.equal(f.calls.datasets, 1);
    v.datasetsChanged();
    await v.reload();
    assert.equal(f.calls.datasets, 2);
});

test('dispose: no more events, late pages are dropped', async () => {
    const { api } = fakeApi(20);
    const v = new CatalogView('/p', api);
    const seen = changes(v);
    const p = v.reload();
    v.dispose();
    await p;
    assert.deepEqual(seen, ['loading']);
});

test('allTotal: the whole catalog is counted once, again only after catalogChanged', async () => {
    const { api, calls } = fakeApi(9);
    const v = new CatalogView('/p', api);
    await v.setFilter({ siteIds: [1] });
    assert.equal(v.total, 3);
    assert.equal(v.allTotal, 9);
    const before = calls.facets;
    await v.setFilter({ siteIds: [2] });
    assert.equal(calls.facets - before, 1, 'no second count of the whole catalog');
    v.catalogChanged();
    await v.setFilter({ siteIds: [0] });
    assert.equal(calls.facets - before, 3);
    await v.setFilter({});
    assert.equal(v.allTotal, 9, 'without a filter the facets are the whole catalog');
});

test('clearChip removes one part of the filter and reloads; all clears the dataset too', async () => {
    const ds = [{ id: 4, name: 'Fixed', kind: 'static', count: 2 }];
    const { api } = fakeApi(9, { datasets: ds });
    const v = new CatalogView('/p', api);
    await v.openDataset(4);
    await v.setFilter({ ...v.filter, siteIds: [1, 2] });
    await v.clearChip('site', 1);
    assert.deepEqual(v.filter.siteIds, [2]);
    assert.equal(v.activeDs, 4);
    await v.clearChip('dataset');
    assert.equal(v.filter.datasetId, null);
    assert.equal(v.activeDs, null, 'a static dataset closes with its chip');
    await v.clearChip('all');
    assert.deepEqual(v.filter, {});
});
