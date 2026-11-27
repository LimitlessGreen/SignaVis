import test from 'node:test';
import assert from 'node:assert/strict';

import { gridWindow, moveIndex, scrollToShow, heatLut, thumbPixels, clockDuration } from '../src/domain/catalog/thumb-grid.ts';

test('gridWindow: columns from width, one spare row each side, clipped to total', () => {
    // 700 px / 170 → 4 columns; 10 items → 3 rows.
    assert.deepEqual(gridWindow(700, 10, 0, 200, 170, 100), { cols: 4, height: 300, first: 0, last: 10 });
    // Scrolled to row 5 of 250 rows, 2 rows visible → rows 4..8.
    const w = gridWindow(700, 1000, 500, 200, 170, 100);
    assert.equal(w.first, 16);
    assert.equal(w.last, 32);
    // Narrower than one tile: still one column.
    assert.equal(gridWindow(50, 3, 0, 100, 170, 100).cols, 1);
});

test('moveIndex: arrows in grid and table', () => {
    assert.equal(moveIndex(5, 'ArrowDown', 4, 20), 9);
    assert.equal(moveIndex(5, 'ArrowUp', 4, 20), 1);
    assert.equal(moveIndex(2, 'ArrowUp', 4, 20), 2, 'top row stays');
    assert.equal(moveIndex(18, 'ArrowDown', 4, 20), 18, 'no row below');
    assert.equal(moveIndex(3, 'ArrowRight', 4, 20), 4, 'wraps to next row');
    assert.equal(moveIndex(0, 'ArrowLeft', 4, 20), 0);
    assert.equal(moveIndex(3, 'ArrowRight', 1, 20), -1, 'table ignores left/right');
    assert.equal(moveIndex(3, 'ArrowDown', 1, 20), 4);
    assert.equal(moveIndex(-1, 'ArrowDown', 4, 20), 0, 'nothing selected → first');
    assert.equal(moveIndex(0, 'x', 4, 20), -1);
});

test('scrollToShow', () => {
    assert.equal(scrollToShow(100, 50, 200, 300), 100);
    assert.equal(scrollToShow(480, 50, 200, 300), 230);
    assert.equal(scrollToShow(250, 50, 200, 300), null);
});

test('heatLut / thumbPixels: dark for 0, bright for 255', () => {
    const lut = heatLut();
    const px = thumbPixels({ w: 2, h: 1, data: [0, 255] }, lut);
    assert.deepEqual([...px.slice(0, 4)], [8, 8, 24, 255]);
    assert.deepEqual([...px.slice(4, 8)], [252, 245, 170, 255]);
    // Monotonic brightness.
    const lum = (i) => lut[i * 3] + lut[i * 3 + 1] + lut[i * 3 + 2];
    for (let i = 1; i < 256; i++) assert.ok(lum(i) >= lum(i - 1) - 2, `step ${i}`);
});

test('clockDuration', () => {
    assert.equal(clockDuration(42), '0:42');
    assert.equal(clockDuration(725), '12:05');
    assert.equal(clockDuration(3720), '1:02:00');
    assert.equal(clockDuration(null), '');
});

test('gridWindow: a scroll position past a smaller result keeps first ≤ last ≤ total', async () => {
    const { gridWindow } = await import('../src/domain/catalog/thumb-grid.ts');
    const w = gridWindow(400, 5, 10_000, 300, 100, 100);
    assert.ok(w.first <= w.last && w.last <= 5, JSON.stringify(w));
});

test('heatGeometry: the "00" label at the first row stays inside the canvas', async () => {
    const { heatGeometry, HEAT_FONT } = await import('../src/domain/catalog/thumb-grid.ts');
    for (const H of [110, 150, 400]) {
        const { top, rowH } = heatGeometry(H);
        const labelTop = top + rowH / 2 - HEAT_FONT / 2;   // text centred on the first row
        assert.ok(labelTop >= 0, `H=${H}: label starts at ${labelTop}`);
        assert.ok(top + 24 * rowH <= H - 14 + 1e-9, `H=${H}: rows overlap the date labels`);
    }
});
