import test from 'node:test';
import assert from 'node:assert/strict';

import { brushDays, brushHours, dayBars, filterDays, hourBars, hourIn, isOnlyBar, setPeriod } from '../src/domain/catalog/histogram.ts';

const days = [{ day: '2023-03-06', count: 5 }, { day: '2023-03-08', count: 2 }, { day: '2023-03-07', count: 1 }];

test('dayBars: one bar per day over the whole span, gaps count 0', () => {
    const bars = dayBars([{ day: '2023-03-06', count: 5 }, { day: '2023-03-09', count: 2 }], {});
    assert.deepEqual(bars.map((b) => [b.from, b.count, b.on]), [
        ['2023-03-06', 5, true], ['2023-03-07', 0, true], ['2023-03-08', 0, true], ['2023-03-09', 2, true]]);
});

test('dayBars: long spans share bars, the last bar ends on the last day', () => {
    const many = Array.from({ length: 100 }, (_, i) => ({ day: new Date(Date.UTC(2023, 0, 1) + i * 86_400_000).toISOString().slice(0, 10), count: 1 }));
    const bars = dayBars(many, {}, 48);
    assert.equal(bars.length, 34); // 3 days per bar
    assert.equal(bars.reduce((s, b) => s + b.count, 0), 100);
    assert.equal(bars[0].to, '2023-01-03');
    assert.equal(bars.at(-1).to, '2023-04-10');
    assert.equal(bars.at(-1).count, 1);
});

test('dayBars: bars outside the filtered period are off (local days and older UTC bounds)', () => {
    assert.deepEqual(dayBars(days, { localDayFrom: '2023-03-07' }).map((b) => b.on), [false, true, true]);
    assert.deepEqual(dayBars(days, { toMs: Date.UTC(2023, 2, 7) }).map((b) => b.on), [true, false, false]);
    assert.deepEqual(filterDays({ fromMs: Date.UTC(2023, 2, 7), toMs: Date.UTC(2023, 2, 9) }), { from: '2023-03-07', to: '2023-03-08' });
});

test('brushDays: dragged bars become local days; the whole span clears the period', () => {
    const bars = dayBars(days, {});
    assert.deepEqual(brushDays(bars, 2, 1), { localDayFrom: '2023-03-07', localDayTo: '2023-03-08', fromMs: null, toMs: null });
    assert.deepEqual(brushDays(bars, 0, 2), { localDayFrom: null, localDayTo: null, fromMs: null, toMs: null });
});

test('hours: wrap over midnight, brush gives [min, max+1), full day clears', () => {
    assert.equal(hourIn(23, 18, 7), true);
    assert.equal(hourIn(7, 18, 7), false);
    assert.equal(hourIn(3, null, null), true);
    const bars = hourBars([1, 2], { hourFrom: 4, hourTo: 6 });
    assert.equal(bars.length, 24);
    assert.deepEqual(bars.filter((b) => b.on).map((b) => b.hour), [4, 5]);
    assert.equal(bars[1].count, 2);
    assert.deepEqual(brushHours(9, 5), { hourFrom: 5, hourTo: 10 });
    assert.deepEqual(brushHours(0, 23), { hourFrom: null, hourTo: null });
});

test('isOnlyBar: clicking the single kept bar clears', () => {
    const bars = hourBars([], { hourFrom: 4, hourTo: 5 });
    assert.equal(isOnlyBar(bars, 4), true);
    assert.equal(isOnlyBar(bars, 5), false);
    assert.equal(isOnlyBar(hourBars([], {}), 4), false);
});

test('setPeriod: period inputs set local days and drop UTC bounds', () => {
    const f = { fromMs: Date.UTC(2023, 2, 7), toMs: Date.UTC(2023, 2, 9) };
    setPeriod(f, 'to', '2023-03-20');
    assert.deepEqual(f, { localDayFrom: '2023-03-07', localDayTo: '2023-03-20', fromMs: null, toMs: null });
    assert.equal(setPeriod(f, 'from', ''), true);
    assert.equal(f.localDayFrom, null);
    for (const bad of ['2023-02-30', '20.03.2023', '2023-3-1']) assert.equal(setPeriod(f, 'from', bad), false, bad);
    assert.equal(f.localDayFrom, null);
});

test('filterDays: an exclusive end inside a day keeps that day', () => {
    assert.deepEqual(filterDays({ fromMs: Date.UTC(2023, 2, 9), toMs: Date.UTC(2023, 2, 9, 18) }), { from: '2023-03-09', to: '2023-03-09' });
});
