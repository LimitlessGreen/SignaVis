import test from 'node:test';
import assert from 'node:assert/strict';
import { SpectrogramLabelLayer, AnnotationLayer } from '../src/domain/annotations.ts';

// Element stand-in that counts class writes: the highlight runs ~15x/s during playback and
// must only touch the elements whose state flips, not every label.
function fakeEl() {
    const classes = new Set();
    const el = { writes: 0, classList: {
        add(c) { el.writes++; classes.add(c); },
        remove(c) { el.writes++; classes.delete(c); },
        toggle(c, on) { el.writes++; if (on) classes.add(c); else classes.delete(c); },
        contains: (c) => classes.has(c),
    } };
    return el;
}

function layerWith(Layer, items) {
    const layer = new Layer();
    layer.overlay = {};
    layer._items = items;
    layer._elById = new Map(items.map((i) => [i.id, fakeEl()]));
    return layer;
}

for (const Layer of [SpectrogramLabelLayer, AnnotationLayer]) {
    test(`${Layer.name}: highlight marks the items under the playhead`, () => {
        const items = [{ id: 'a', start: 0, end: 1 }, { id: 'b', start: 0.5, end: 2 }, { id: 'c', start: 3, end: 4 }];
        const layer = layerWith(Layer, items);
        const hl = (t) => (Layer === AnnotationLayer ? layer.highlightActiveRegion(t) : layer.highlightActiveLabel(t));
        const active = () => items.filter((i) => layer._elById.get(i.id).classList.contains('active')).map((i) => i.id);
        hl(0.7);
        assert.deepEqual(active(), ['a', 'b']);
        hl(1.5);
        assert.deepEqual(active(), ['b']);
        hl(10);
        assert.deepEqual(active(), []);
    });

    test(`${Layer.name}: highlight writes only to elements whose state changes`, () => {
        const items = Array.from({ length: 1000 }, (_, i) => ({ id: 'l' + i, start: i, end: i + 0.5 }));
        const layer = layerWith(Layer, items);
        const writes = () => [...layer._elById.values()].reduce((n, el) => n + el.writes, 0);
        layer._highlightActive(10.2);
        assert.equal(writes(), 1);
        layer._highlightActive(10.3);   // same label still active: nothing to write
        assert.equal(writes(), 1);
        layer._highlightActive(11.2);   // one off, one on
        assert.equal(writes(), 3);
    });
}

// ── Viewport culling: only items near the view get elements ──

function cullLayer(Layer, items, { scrollLeft = 0, width = 1000, pps = 100 } = {}) {
    const layer = new Layer();
    const sc = { scrollLeft, clientWidth: width };
    layer.player = { _state: { coords: { scrollXToTime: (x) => x / pps } } };
    layer._scrollEl = () => sc;
    layer._items = items;
    return { layer, sc };
}

for (const Layer of [SpectrogramLabelLayer, AnnotationLayer]) {
    test(`${Layer.name}: renders items within one view width of the visible span`, () => {
        // view 100–110 s, window 90–120 s
        const items = [0, 85, 95, 105, 115, 125, 500].map((t) => ({ id: 't' + t, start: t, end: t + 1 }));
        const { layer } = cullLayer(Layer, items, { scrollLeft: 10000 });
        assert.deepEqual(layer._itemsToRender(items).map((i) => i.id), ['t95', 't105', 't115']);
        assert.deepEqual(layer._renderedWindow, { start: 90, end: 120 });
    });

    test(`${Layer.name}: selected, edited and linked items keep their element off-screen`, () => {
        const items = [{ id: 'sel', start: 500, end: 501 }, { id: 'ed', start: 600, end: 601 },
            { id: 'multi', start: 700, end: 701 }, { id: 'other', start: 800, end: 801 }];
        const { layer } = cullLayer(Layer, items);
        layer._selectedLabelId = 'sel';
        layer._editing = { id: 'ed' };
        layer._multiSelectedIds = new Set(['multi']);
        assert.deepEqual(layer._itemsToRender(items).map((i) => i.id), ['sel', 'ed', 'multi']);
    });

    test(`${Layer.name}: without a measurable view every item is rendered`, () => {
        const items = [{ id: 'a', start: 0, end: 1 }, { id: 'b', start: 900, end: 901 }];
        const { layer, sc } = cullLayer(Layer, items);
        sc.clientWidth = 0;   // hidden view
        assert.equal(layer._itemsToRender(items).length, 2);
        assert.equal(layer._renderedWindow, null);
    });
}

// ── Focus / selection visuals: one shared implementation, own class names per layer ──

for (const [Layer, focused, selected] of [[SpectrogramLabelLayer, 'focused', 'selected'], [AnnotationLayer, 'annotation-region--focused', 'annotation-region--selected']]) {
    test(`${Layer.name}: focus, selection and multi-selection mark the rendered elements`, () => {
        const items = [{ id: 'a', start: 0, end: 1 }, { id: 'b', start: 2, end: 3 }, { id: 'c', start: 4, end: 5 }];
        const layer = layerWith(Layer, items);
        const has = (cls) => items.filter((i) => layer._elById.get(i.id).classList.contains(cls)).map((i) => i.id);
        layer._focusedLabelId = 'a'; layer._updateFocusedVisual();
        layer._selectedLabelId = 'b'; layer._updateSelectedVisual();
        layer.setMultiSelected(['b', 'c']);
        assert.deepEqual([has(focused), has(selected), has('multi-selected')], [['a'], ['b'], ['b', 'c']]);
        layer._focusedLabelId = null; layer._updateFocusedVisual();
        assert.deepEqual(has(focused), []);
    });
}
