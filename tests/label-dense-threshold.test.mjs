import test from 'node:test';
import assert from 'node:assert/strict';
import { SpectrogramLabelLayer, AnnotationLayer } from '../src/domain/annotations.ts';

function select(value = '5') {
    const listeners = [];
    return {
        value, dataset: {}, options: ['3', '4', '5', '6', '8', '999'].map((v) => ({ value: v })),
        addEventListener: (_t, fn) => listeners.push(fn),
        change(v) { this.value = v; listeners.forEach((fn) => fn()); },
    };
}
function layers(sel, options) {
    const player = { options, _state: { d: { labelDenseSelect: sel } } };
    const spec = new SpectrogramLabelLayer(); spec.player = player;
    const wave = new AnnotationLayer(); wave.player = player;
    return { spec, wave };
}

test('each view keeps its own option until the user picks a value', () => {
    const sel = select();
    const { spec, wave } = layers(sel, { labelDenseRows: 5, labelDenseLanes: 8 });
    assert.equal(wave._denseFrom('labelDenseRows'), 5);
    assert.equal(spec._denseFrom('labelDenseLanes'), 8);   // not the select's 5
});

test('a choice in the settings applies to both views', () => {
    const sel = select();
    const { spec, wave } = layers(sel, { labelDenseRows: 5, labelDenseLanes: 8 });
    wave._denseFrom('labelDenseRows');
    sel.change('3');
    assert.equal(wave._denseFrom('labelDenseRows'), 3);
    assert.equal(spec._denseFrom('labelDenseLanes'), 3);
});

test('default is 5 without option or select', () => {
    const { spec } = layers(null, {});
    assert.equal(spec._denseFrom('labelDenseLanes'), 5);
});
