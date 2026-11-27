import test from 'node:test';
import assert from 'node:assert/strict';

import { calendarBrush, cellAt, cellInView, sunLines } from '../src/domain/catalog/calendar.ts';

const days = ['2023-03-13', '2023-03-14', '2023-03-15', '2023-03-16'];

test('cellInView: period (local days or older UTC bounds) and time of day', () => {
    const f = { localDayFrom: '2023-03-14', hourFrom: 18, hourTo: 7 };
    assert.equal(cellInView('2023-03-14', 23, f), true);
    assert.equal(cellInView('2023-03-14', 12, f), false);
    assert.equal(cellInView('2023-03-13', 23, f), false);
    assert.equal(cellInView('2023-03-13', 12, {}), true);
});

test('cellAt clamps to the grid', () => {
    const g = { left: 24, top: 6, cw: 10, ch: 5, days: 4 };
    assert.deepEqual(cellAt(25, 7, g), { i: 0, hour: 0 });
    assert.deepEqual(cellAt(999, 999, g), { i: 3, hour: 23 });
    assert.deepEqual(cellAt(0, 0, g), { i: 0, hour: 0 });
    assert.deepEqual(cellAt(45, 6 + 5 * 18 + 1, g), { i: 2, hour: 18 });
});

test('calendarBrush: click picks a day, again clears it', () => {
    const a = { i: 1, hour: 20 };
    assert.deepEqual(calendarBrush(days, a, a, {}), { localDayFrom: '2023-03-14', localDayTo: '2023-03-14', fromMs: null, toMs: null });
    assert.deepEqual(calendarBrush(days, a, a, { localDayFrom: '2023-03-14', localDayTo: '2023-03-14' }),
        { localDayFrom: null, localDayTo: null, fromMs: null, toMs: null });
});

test('calendarBrush: rectangle sets days and hours, one row only days', () => {
    assert.deepEqual(calendarBrush(days, { i: 2, hour: 22 }, { i: 1, hour: 18 }, {}),
        { localDayFrom: '2023-03-14', localDayTo: '2023-03-15', fromMs: null, toMs: null, hourFrom: 18, hourTo: 23 });
    assert.deepEqual(calendarBrush(days, { i: 0, hour: 5 }, { i: 2, hour: 5 }, { hourFrom: 1, hourTo: 3 }),
        { localDayFrom: '2023-03-13', localDayTo: '2023-03-15', fromMs: null, toMs: null });
    assert.deepEqual(calendarBrush(days, { i: 0, hour: 0 }, { i: 3, hour: 23 }, {}),
        { localDayFrom: null, localDayTo: null, fromMs: null, toMs: null, hourFrom: null, hourTo: null });
});

test('sunLines: local sunrise/sunset with the day offset (Bielefeld, March)', () => {
    const offsets = [{ day: '2023-03-13', count: 1, offsetMin: 60 }, { day: '2023-03-27', count: 1, offsetMin: 120 }];
    const ds = ['2023-03-13', '2023-03-26', '2023-03-27'];
    const s = sunLines(ds, offsets, [52.0, 8.4]);
    // Bielefeld 13 Mar: sunrise ~06:55, sunset ~18:35 CET.
    assert.ok(Math.abs(s[0].rise - 6.9) < 0.25, String(s[0].rise));
    assert.ok(Math.abs(s[0].set - 18.6) < 0.25, String(s[0].set));
    // 26 Mar keeps the earlier offset, 27 Mar jumps by an hour (summer time).
    assert.ok(s[2].rise - s[1].rise > 0.9);
    assert.equal(sunLines(ds, offsets, null), null);
    assert.deepEqual(sunLines(['2023-06-21'], [], [78, 15]), [{ rise: null, set: null }]);
});
