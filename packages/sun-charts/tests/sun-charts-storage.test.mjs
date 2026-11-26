import test from 'node:test';
import assert from 'node:assert/strict';
import { installFakeDom, find } from './fake-dom.mjs';

installFakeDom();
const { SunCharts } = await import('../src/index.ts');

test('SunCharts reads and writes the view choice through the given storage', () => {
    const store = new Map([['my.view', 'dial']]);
    const storage = { get: (k) => store.get(k) ?? null, set: (k, v) => store.set(k, v) };
    const charts = new SunCharts({ storage, storageKey: 'my.view' });
    charts.render({ lat: 51.34, lon: 12.37 }, '2026-11-20', '07:30');
    assert.ok(find(charts.el, (e) => e.className === 'sun-dials'), 'dial view taken from storage');

    const chartBtn = find(charts.el, (e) => e.tagName === 'button' && e.textContent === 'Chart');
    chartBtn.listeners.click[0]();
    assert.equal(store.get('my.view'), 'chart');
    assert.ok(find(charts.el, (e) => e.className === 'sun-lines'), 're-rendered as charts');
});

test('SunCharts hides itself without date or place', () => {
    const charts = new SunCharts({ storage: { get: () => null, set() {} } });
    charts.render(null, '2026-11-20', null);
    assert.equal(charts.el.hidden, true);
});
