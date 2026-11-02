import test from 'node:test';
import assert from 'node:assert/strict';
import { SpectrogramLabelLayer } from '../src/domain/annotations.ts';

function classes(init = []) {
    const set = new Set(init);
    return { contains: (c) => set.has(c), toggle: (c, on) => (on ? set.add(c) : set.delete(c)), add: (c) => set.add(c), has: (c) => set.has(c) };
}
function setup({ scrollLeft = 0, clientWidth = 500, viewH = 300, box, compact = false, bottom = false }) {
    const vars = {};
    const textEl = { classList: classes(bottom ? ['label-text-bottom'] : []) };
    const el = {
        offsetLeft: box.left, offsetTop: box.top, offsetWidth: box.width, offsetHeight: box.height,
        classList: classes(compact ? ['label-compact'] : []),
        querySelector: () => textEl,
        style: { setProperty: (k, v) => { vars[k] = v; } },
    };
    const layer = new SpectrogramLabelLayer();
    layer.player = { _state: { d: { canvasWrapper: { scrollLeft, clientWidth, clientHeight: viewH } } } };
    layer.overlay = { offsetHeight: viewH };
    layer._pinLabelText(el);
    return { vars, el };
}

test('name follows the visible left edge when the box starts off-screen', () => {
    const { vars } = setup({ scrollLeft: 1000, box: { left: 800, top: 50, width: 600, height: 80 } });
    assert.equal(vars['--label-text-dx'], '200px');
    assert.equal(vars['--label-text-dy'], '0px');
});

test('name moves down when the box top is above a zoomed view', () => {
    const { vars } = setup({ box: { left: 10, top: -120, width: 200, height: 200 } });
    assert.equal(vars['--label-text-dy'], '120px');
});

test('name never leaves the box', () => {
    const { vars } = setup({ scrollLeft: 1000, box: { left: 800, top: -500, width: 230, height: 100 } });
    assert.equal(vars['--label-text-dx'], '170px'); // width 230 - text 60
    assert.equal(vars['--label-text-dy'], '84px');  // height 100 - text 16
});

test('compact box at the top edge shows its name inside', () => {
    const { el } = setup({ compact: true, box: { left: 10, top: 4, width: 50, height: 30 } });
    assert.ok(el.classList.has('label-text-inside'));
});

test('bottom name moves up when the box bottom is below the view', () => {
    const { vars } = setup({ bottom: true, viewH: 300, box: { left: 10, top: 200, width: 200, height: 200 } });
    assert.equal(vars['--label-text-dy'], '-100px');
});
