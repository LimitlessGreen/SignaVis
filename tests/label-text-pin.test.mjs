import test from 'node:test';
import assert from 'node:assert/strict';
import { SpectrogramLabelLayer } from '../src/domain/annotations.ts';

function classes(init = []) {
    const set = new Set(init);
    return { contains: (c) => set.has(c), toggle: (c, on) => (on ? set.add(c) : set.delete(c)), add: (c) => set.add(c), has: (c) => set.has(c) };
}
function setup({ scrollLeft = 0, clientWidth = 500, viewH = 300, box, compact = false, bottom = false, tagH }) {
    const vars = {};
    const textEl = { classList: classes(bottom ? ['label-text-bottom'] : []), offsetHeight: tagH };
    const el = {
        offsetLeft: box.left, offsetTop: box.top, offsetWidth: box.width, offsetHeight: box.height,
        classList: classes(compact ? ['label-compact'] : []),
        querySelector: () => textEl,
        querySelectorAll: () => [],
        style: { setProperty: (k, v) => { vars[k] = v; }, getPropertyValue: (k) => vars[k] ?? '' },
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
    // The tag sits 4 px below the box (label design): bottom 400 + 4 + 16 → visible bottom 300
    const { vars } = setup({ bottom: true, viewH: 300, box: { left: 10, top: 200, width: 200, height: 200 } });
    assert.equal(vars['--label-text-dy'], '-120px');
});

test('bottom name uses the rendered tag height (taller tag on the phone)', () => {
    // 19 px tag: bottom 400 + 4 + 19 → visible bottom 300
    const { vars } = setup({ bottom: true, viewH: 300, tagH: 19, box: { left: 10, top: 200, width: 200, height: 200 } });
    assert.equal(vars['--label-text-dy'], '-123px');
});

test('buttons right of a box past the visible right edge move left into view', () => {
    const vars = {};
    const act = { offsetWidth: 42 };
    const el = {
        offsetLeft: 100, offsetTop: 2, offsetWidth: 2000, offsetHeight: 16,
        classList: classes(['spectrogram-label-region--lane']),
        querySelector: () => ({ classList: classes(), offsetHeight: 16 }),
        querySelectorAll: () => [act],
        style: { setProperty: (k, v) => { vars[k] = v; }, getPropertyValue: (k) => vars[k] ?? '' },
    };
    const layer = new SpectrogramLabelLayer();
    layer.player = { _state: { d: { canvasWrapper: { scrollLeft: 0, clientWidth: 500, clientHeight: 300 } } } };
    layer.overlay = { offsetHeight: 300 };
    layer._pinLabelText(el);
    // right edge 2100 + 4 + 42 must end at the view's right edge 500
    // lane: right edge 2100 + 4 + (42 + 4 gap) must end at the view's right edge 500
    assert.equal(vars['--label-actions-dx'], '-1650px');
});
