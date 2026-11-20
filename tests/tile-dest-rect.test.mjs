import test from 'node:test';
import assert from 'node:assert/strict';
import { tileDrawRect } from '../src/app/WasmTileManager.ts';

test('adjacent tiles meet on one pixel edge, sources stay inside the tile', () => {
    const w = 1024, tilePx = 546.1333, vw = 1160;
    for (const scroll of [0, 0.3, 17.71, 545.5, 1000.25]) {
        const rects = [];
        for (let i = 0; i < 4; i++) {
            const r = tileDrawRect(i * tilePx - 0.27 - scroll, (i + 1) * tilePx - 0.27 - scroll, vw, w);
            if (r) rects.push(r);
        }
        assert.ok(rects.length >= 2);
        for (const r of rects) {
            assert.ok(r.srcX >= 0 && r.srcX + r.srcW <= w + 1e-9, JSON.stringify(r));
            assert.ok(Number.isInteger(r.dx) && Number.isInteger(r.dw));
        }
        for (let i = 1; i < rects.length; i++) assert.equal(rects[i].dx, rects[i - 1].dx + rects[i - 1].dw, `scroll ${scroll}`);
        assert.equal(rects[0].dx, 0);
    }
});
