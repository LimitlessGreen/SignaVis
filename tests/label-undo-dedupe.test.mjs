import test from 'node:test';
import assert from 'node:assert/strict';
import { BirdNETPlayer } from '../src/app/BirdNETPlayer.ts';
import { UndoStack } from '../src/domain/undoStack.ts';

// Player methods on a bare object: layers and rendering stubbed out.
function bare() {
    const p = Object.create(BirdNETPlayer.prototype);
    const layer = { set() {}, setLiveLinkedId() {} };
    Object.assign(p, {
        _undoStack: new UndoStack(100), _linkedLabels: new Map(), _lastUndoKey: '',
        _isRestoring: false, _isSyncingLabels: false, _activeLabelId: null,
        annotations: layer, spectrogramLabels: layer, events: [],
        _toAnnotationList: () => [], _toSpectrogramLabelList: () => [],
        _rebuildLabelLibrary() {}, _renderOverviewLabelTracks() {},
        _emit(name, detail) { this.events.push({ name, detail }); },
    });
    return p;
}
const A = { id: 'a', start: 1, end: 2, freqMin: 1000, freqMax: 3000, label: 'A', tags: {} };

test('re-pushing unchanged labels (host sync) adds no undo step', () => {
    const p = bare();
    p._syncLinkedLabelsToLayers();                        // initial empty state
    p._linkedLabels.set('a', { ...A });
    p._syncLinkedLabelsToLayers();                        // label created
    p._linkedLabels.set('a', { ...A, updatedAt: 'x', setId: 'own' }); // host echo, bookkeeping only
    p._syncLinkedLabelsToLayers();
    assert.equal(p._undoStack.size, 2);
    p.undo();
    assert.equal(p._linkedLabels.size, 0, 'one undo removes the new label');
});

test('undo emits labelrestore with before/after', () => {
    const p = bare();
    p._syncLinkedLabelsToLayers();
    p._linkedLabels.set('a', { ...A });
    p._syncLinkedLabelsToLayers();
    p.undo();
    const ev = p.events.find((e) => e.name === 'labelrestore');
    assert.deepEqual(ev.detail.before.map((l) => l.id), ['a']);
    assert.deepEqual(ev.detail.after, []);
});
