import test from 'node:test';
import assert from 'node:assert/strict';
import { SpectrogramLabelLayer } from '../src/annotations.js';

// ── Helpers ──

/** Minimal mock player with event system */
function mockPlayer(opts = {}) {
    const listeners = {};
    return {
        duration: opts.duration || 10,
        root: { classList: { add() {}, remove() {}, toggle() {} }, querySelector: () => null },
        _state: {
            audioBuffer: { duration: opts.duration || 10 },
            sampleRateHz: 44100,
            coords: null,
            d: {
                spectrogramCanvas: { width: 800, height: 400 },
                canvasWrapper: null,
                maxFreqSelect: { value: '22050' },
            },
        },
        on(event, fn) {
            (listeners[event] ??= []).push(fn);
            return () => {
                listeners[event] = listeners[event].filter((f) => f !== fn);
            };
        },
        _emit(event, detail) {
            for (const fn of listeners[event] || []) fn({ detail });
        },
        playBandpassedSegment() {},
    };
}

/** Create a SpectrogramLabelLayer attached to a mock player. */
function createLayer(opts = {}) {
    const layer = new SpectrogramLabelLayer();
    const player = mockPlayer(opts);
    // We can't call attach() because there's no DOM, so wire up manually.
    layer.player = player;
    layer.labels = [];
    layer.overlay = null; // no DOM
    return { layer, player };
}

// ── _normalize produces unique IDs ──

test('SpectrogramLabelLayer._normalize generates unique IDs', () => {
    const { layer } = createLayer();
    const a = layer._normalize({ start: 0, end: 1, freqMin: 1000, freqMax: 5000, label: 'A' });
    const b = layer._normalize({ start: 0, end: 1, freqMin: 1000, freqMax: 5000, label: 'A' });
    assert.notEqual(a.id, b.id, 'each normalized label should get a unique ID');
});

test('SpectrogramLabelLayer._normalize preserves explicit ID', () => {
    const { layer } = createLayer();
    const a = layer._normalize({ id: 'keep-me', start: 0, end: 1, freqMin: 1000, freqMax: 5000 });
    assert.equal(a.id, 'keep-me');
});

// ── add() emits copies, not references ──

test('add() pushes label to array and returns ID', () => {
    const { layer } = createLayer();
    const id = layer.add({ start: 1, end: 2, freqMin: 100, freqMax: 3000, label: 'Robin' });
    assert.equal(typeof id, 'string');
    assert.equal(layer.labels.length, 1);
    assert.equal(layer.labels[0].id, id);
});

test('add() emits spectrogramlabelcreate with a COPY, not the internal reference', () => {
    const { layer, player } = createLayer();
    let emitted = null;
    player.on('spectrogramlabelcreate', (e) => { emitted = e.detail.label; });
    layer.add({ start: 1, end: 2, freqMin: 100, freqMax: 3000, label: 'Wren' });
    assert.ok(emitted, 'event should have been emitted');
    assert.notEqual(emitted, layer.labels[0], 'emitted label must not be the same object reference');
    assert.equal(emitted.id, layer.labels[0].id, 'but IDs should match');
});

// ── Stamp: unique IDs per stamped label ──

test('stamped labels each get a unique ID', () => {
    const { layer } = createLayer();
    const id1 = layer.add({ start: 0, end: 1, freqMin: 1000, freqMax: 5000, label: 'Amsel' });
    const id2 = layer.add({ start: 2, end: 3, freqMin: 1000, freqMax: 5000, label: 'Amsel' });
    const id3 = layer.add({ start: 4, end: 5, freqMin: 1000, freqMax: 5000, label: 'Amsel' });
    assert.notEqual(id1, id2);
    assert.notEqual(id2, id3);
    assert.notEqual(id1, id3);
    assert.equal(layer.labels.length, 3);
});

test('stamped labels are independent objects (no shared reference)', () => {
    const { layer } = createLayer();
    layer.add({ start: 0, end: 1, freqMin: 1000, freqMax: 5000, label: 'Meise' });
    layer.add({ start: 2, end: 3, freqMin: 1000, freqMax: 5000, label: 'Meise' });
    // Mutating one should not affect the other
    layer.labels[0].start = 99;
    assert.notEqual(layer.labels[1].start, 99, 'labels must be independent objects');
});

// ── _getReferenceLabelForDefaults priority ──

test('_getReferenceLabelForDefaults returns _stampRefLabelId first', () => {
    const { layer } = createLayer();
    layer.add({ id: 'lbl-a', start: 0, end: 1, freqMin: 100, freqMax: 3000, label: 'A' });
    layer.add({ id: 'lbl-b', start: 2, end: 3, freqMin: 200, freqMax: 4000, label: 'B' });
    layer._stampRefLabelId = 'lbl-a';
    layer._focusedLabelId = 'lbl-b';
    const ref = layer._getReferenceLabelForDefaults();
    assert.equal(ref.id, 'lbl-a', '_stampRefLabelId takes priority over _focusedLabelId');
});

test('_getReferenceLabelForDefaults falls back to _focusedLabelId', () => {
    const { layer } = createLayer();
    layer.add({ id: 'lbl-a', start: 0, end: 1, freqMin: 100, freqMax: 3000, label: 'A' });
    layer.add({ id: 'lbl-b', start: 2, end: 3, freqMin: 200, freqMax: 4000, label: 'B' });
    layer._stampRefLabelId = null;
    layer._focusedLabelId = 'lbl-b';
    const ref = layer._getReferenceLabelForDefaults();
    assert.equal(ref.id, 'lbl-b');
});

test('_getReferenceLabelForDefaults falls back to last label', () => {
    const { layer } = createLayer();
    layer.add({ id: 'lbl-a', start: 0, end: 1, freqMin: 100, freqMax: 3000, label: 'A' });
    layer.add({ id: 'lbl-b', start: 2, end: 3, freqMin: 200, freqMax: 4000, label: 'B' });
    layer._stampRefLabelId = null;
    layer._focusedLabelId = null;
    const ref = layer._getReferenceLabelForDefaults();
    assert.equal(ref.id, 'lbl-b', 'should return last label when no ref or focus');
});

test('_getReferenceLabelForDefaults returns null when no labels', () => {
    const { layer } = createLayer();
    const ref = layer._getReferenceLabelForDefaults();
    assert.equal(ref, null);
});

// ── exitStampMode clears state ──

test('exitStampMode resets stamp state', () => {
    const { layer } = createLayer();
    layer.stampMode = true;
    layer._stampAxisLock = true;
    layer._stampRefLabelId = 'some-id';
    layer.exitStampMode();
    assert.equal(layer.stampMode, false);
    assert.equal(layer._stampAxisLock, false);
    assert.equal(layer._stampRefLabelId, null);
});

// ── _normalize clones tags (no shared nested objects) ──

test('_normalize deep-copies tags', () => {
    const { layer } = createLayer();
    const tags = { quality: 'A', verified: true };
    const a = layer._normalize({ start: 0, end: 1, freqMin: 100, freqMax: 3000, tags });
    const b = layer._normalize({ start: 0, end: 1, freqMin: 100, freqMax: 3000, tags });
    assert.deepEqual(a.tags, b.tags);
    a.tags.quality = 'changed';
    assert.notEqual(b.tags.quality, 'changed', 'tags must be independent copies');
    assert.notEqual(a.tags, tags, 'should not share reference with input');
});

// ── _normalize enforces origin as string ──

test('_normalize sets origin to manual for stamped labels', () => {
    const { layer } = createLayer();
    const label = layer._normalize({ start: 0, end: 1, freqMin: 100, freqMax: 3000, origin: 'manual' });
    assert.equal(label.origin, 'manual');
});

test('_normalize preserves explicit origin', () => {
    const { layer } = createLayer();
    const label = layer._normalize({ start: 0, end: 1, freqMin: 100, freqMax: 3000, origin: 'birdnet' });
    assert.equal(label.origin, 'birdnet');
});

// ── Axis constraint state ──

test('_axisConstraint defaults to null', () => {
    const { layer } = createLayer();
    assert.equal(layer._axisConstraint, null);
});

test('_axisConstraint can be toggled', () => {
    const { layer } = createLayer();
    layer._axisConstraint = 'x';
    assert.equal(layer._axisConstraint, 'x');
    layer._axisConstraint = layer._axisConstraint === 'x' ? null : 'x';
    assert.equal(layer._axisConstraint, null, 'toggling x when already x should clear');
    layer._axisConstraint = layer._axisConstraint === 'y' ? null : 'y';
    assert.equal(layer._axisConstraint, 'y');
});

// ── remove() removes correct label ──

test('remove() deletes only the target label', () => {
    const { layer } = createLayer();
    layer.add({ id: 'a', start: 0, end: 1, freqMin: 100, freqMax: 3000, label: 'A' });
    layer.add({ id: 'b', start: 2, end: 3, freqMin: 100, freqMax: 3000, label: 'B' });
    layer.add({ id: 'c', start: 4, end: 5, freqMin: 100, freqMax: 3000, label: 'C' });
    layer.remove('b');
    assert.equal(layer.labels.length, 2);
    assert.deepEqual(layer.labels.map((l) => l.id), ['a', 'c']);
});

// ── Stamp reference dimensions are preserved ──

test('stamp reference label dimensions are accessible via _getReferenceLabelForDefaults', () => {
    const { layer } = createLayer();
    layer.add({ id: 'ref', start: 1, end: 3, freqMin: 2000, freqMax: 8000, label: 'Amsel' });
    layer._stampRefLabelId = 'ref';
    const ref = layer._getReferenceLabelForDefaults();
    assert.ok(ref);
    // Duration should be ~2s, freq span 6000 Hz
    const duration = ref.end - ref.start;
    const freqSpan = ref.freqMax - ref.freqMin;
    assert.ok(duration >= 1.9 && duration <= 2.1, `duration should be ~2, got ${duration}`);
    assert.ok(freqSpan >= 5900 && freqSpan <= 6100, `freqSpan should be ~6000, got ${freqSpan}`);
});
