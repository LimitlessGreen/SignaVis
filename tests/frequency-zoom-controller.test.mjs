// ═══════════════════════════════════════════════════════════════════════
// frequency-zoom-controller.test.mjs — Unit tests for FrequencyZoomController
// ═══════════════════════════════════════════════════════════════════════

import test from 'node:test';
import assert from 'node:assert/strict';
import { FrequencyZoomController } from '../src/app/player/FrequencyZoomController.ts';

// ── Minimal fake DOM element ─────────────────────────────────────────

function makeEl(tag = 'div') {
    return {
        tagName: tag.toUpperCase(),
        hidden: false,
        value: '0',
        style: {},
        setAttribute: () => {},
        getAttribute: () => null,
        addEventListener: () => {},
        removeEventListener: () => {},
    };
}

function makeDeps(overrides = {}) {
    let onFreqViewChangeCalled = 0;
    let lastEmitEvent = null;
    const deps = {
        d: {
            freqZoomResetBtn:  makeEl('button'),
            freqScrollbar:     makeEl('div'),
            freqScrollbarThumb: makeEl('div'),
            freqZoomSlider:    makeEl('input'),
        },
        getBoundedMaxFreq: () => 10000,
        onFreqViewChange:  () => { onFreqViewChangeCalled++; },
        emitZoomChange:    (pps) => { lastEmitEvent = { pps }; },
        getPixelsPerSecond: () => 100,
        ...overrides,
    };
    return { deps, getCalls: () => onFreqViewChangeCalled, getLastEmit: () => lastEmitEvent };
}

// ─── 1. Construction ─────────────────────────────────────────────────

test('FrequencyZoomController: constructs without error', () => {
    const { deps } = makeDeps();
    const ctrl = new FrequencyZoomController(deps);
    assert.ok(ctrl);
    ctrl.dispose();
});

// ─── 2. Default state (not zoomed) ───────────────────────────────────

test('FrequencyZoomController: min and max are null by default', () => {
    const { deps } = makeDeps();
    const ctrl = new FrequencyZoomController(deps);
    assert.strictEqual(ctrl.min, null);
    assert.strictEqual(ctrl.max, null);
    assert.strictEqual(ctrl.isZoomed, false);
    ctrl.dispose();
});

// ─── 3. set() ────────────────────────────────────────────────────────

test('FrequencyZoomController: set() changes min/max and fires callback', () => {
    const { deps, getCalls } = makeDeps();
    const ctrl = new FrequencyZoomController(deps);
    ctrl.set(500, 8000);
    assert.strictEqual(ctrl.min, 500);
    assert.strictEqual(ctrl.max, 8000);
    assert.strictEqual(ctrl.isZoomed, true);
    assert.ok(getCalls() >= 1, 'onFreqViewChange should have been called');
    ctrl.dispose();
});

// ─── 4. zoom() ───────────────────────────────────────────────────────

test('FrequencyZoomController: zoom() narrows the visible range', () => {
    const { deps } = makeDeps();
    const ctrl = new FrequencyZoomController(deps);
    // Zoom in significantly so that we're clearly zoomed
    ctrl.zoom(3, 5000);
    assert.strictEqual(ctrl.isZoomed, true);
    assert.ok((ctrl.max ?? 10000) - (ctrl.min ?? 0) < 10000, 'range should shrink after zoom');
    ctrl.dispose();
});

// ─── 5. reset() ──────────────────────────────────────────────────────

test('FrequencyZoomController: reset() returns to unzoomed state', () => {
    const { deps } = makeDeps();
    const ctrl = new FrequencyZoomController(deps);
    ctrl.set(1000, 5000);
    assert.strictEqual(ctrl.isZoomed, true);
    ctrl.reset();
    assert.strictEqual(ctrl.min, null);
    assert.strictEqual(ctrl.max, null);
    assert.strictEqual(ctrl.isZoomed, false);
    ctrl.dispose();
});

// ─── 6. freqZoomResetBtn visibility ──────────────────────────────────

test('FrequencyZoomController: freqZoomResetBtn is hidden when not zoomed', () => {
    const { deps } = makeDeps();
    const ctrl = new FrequencyZoomController(deps);
    // After construction, button should be hidden (not zoomed)
    assert.strictEqual(deps.d.freqZoomResetBtn.hidden, true);
    ctrl.set(1000, 5000);
    assert.strictEqual(deps.d.freqZoomResetBtn.hidden, false);
    ctrl.reset();
    assert.strictEqual(deps.d.freqZoomResetBtn.hidden, true);
    ctrl.dispose();
});

// ─── 7. dispose() ────────────────────────────────────────────────────

test('FrequencyZoomController: dispose() does not throw', () => {
    const { deps } = makeDeps();
    const ctrl = new FrequencyZoomController(deps);
    assert.doesNotThrow(() => ctrl.dispose());
});

// ─── 8. onFreqViewChange not called before first mutation ────────────

test('FrequencyZoomController: onFreqViewChange is not called during construction', () => {
    const { deps, getCalls } = makeDeps();
    const ctrl = new FrequencyZoomController(deps);
    assert.strictEqual(getCalls(), 0);
    ctrl.dispose();
});
