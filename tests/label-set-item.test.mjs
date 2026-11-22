import test from 'node:test';
import assert from 'node:assert/strict';
import { SpectrogramLabelLayer, AnnotationLayer } from '../src/domain/annotations.ts';

// A drag mirrored into the other layer replaces one item instead of re-setting the whole list.
for (const Layer of [SpectrogramLabelLayer, AnnotationLayer]) {
    test(`${Layer.name}.setItem replaces by id in place and appends new ids`, () => {
        const layer = new Layer();
        let renders = 0;
        layer.render = () => { renders++; };
        layer.set([{ id: 'a', start: 0, end: 1, freqMin: 100, freqMax: 200 }, { id: 'b', start: 2, end: 3, freqMin: 100, freqMax: 200 }]);
        layer.setItem({ id: 'a', start: 0.5, end: 1.5, freqMin: 100, freqMax: 200 });
        assert.deepEqual(layer.getAll().map((i) => [i.id, i.start]), [['a', 0.5], ['b', 2]]);
        layer.setItem({ id: 'c', start: 4, end: 5, freqMin: 100, freqMax: 200 });
        assert.deepEqual(layer.getAll().map((i) => i.id), ['a', 'b', 'c']);
        assert.equal(renders, 3);
    });
}
