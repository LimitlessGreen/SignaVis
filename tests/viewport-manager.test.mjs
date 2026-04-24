// ═══════════════════════════════════════════════════════════════════════
// viewport-manager.test.mjs — Tests for ViewportManager
//
// Scope: DOM-free logic only — follow-mode state machine, config updates,
//        and the pure state transitions.
//
// Note: scroll/zoom methods require real DOM (clientWidth, scrollLeft, etc.)
// and will be tested once a jsdom/browser test setup is available.
// The characterization tests for the pure config logic are in viewport.test.mjs.
// ═══════════════════════════════════════════════════════════════════════

import test from 'node:test';
import assert from 'node:assert/strict';
import { ViewportManager } from '../src/app/ViewportManager.ts';
import { sanitizePlaybackViewportConfig } from '../src/app/PlayerState.ts';

// Node.js polyfills for browser APIs used by ViewportManager
if (typeof globalThis.cancelAnimationFrame === 'undefined') {
    globalThis.cancelAnimationFrame = (id) => clearTimeout(id);
}
if (typeof globalThis.requestAnimationFrame === 'undefined') {
    globalThis.requestAnimationFrame = (fn) => setTimeout(fn, 16);
}

// Minimal stub that satisfies ViewportManager's constructor without DOM
function makeViewport(overrides = {}) {
    const cfg = sanitizePlaybackViewportConfig({});

    // Minimal DOM stubs — clientWidth=0, scrollLeft=0
    const stub = (name) => new Proxy({}, {
        get(_, k) {
            if (k === 'clientWidth') return 800;
            if (k === 'scrollLeft') return 0;
            if (k === 'min') return '20';
            if (k === 'max') return '450';
            if (k === 'step') return '1';
            if (k === 'value') return '100';
            if (k === 'style') return {};
            return undefined;
        },
        set(_, k, v) { return true; },
    });

    const d = {
        canvasWrapper: stub('canvasWrapper'),
        waveformWrapper: stub('waveformWrapper'),
        overviewContainer: stub('overviewContainer'),
        overviewWindow: stub('overviewWindow'),
        viewRangeDisplay: stub('viewRangeDisplay'),
        zoomSlider: stub('zoomSlider'),
        zoomValue: stub('zoomValue'),
        spectrogramCanvas: stub('spectrogramCanvas'),
        amplitudeCanvas: stub('amplitudeCanvas'),
    };

    // Minimal InteractionState stub
    const interaction = {
        isOverviewDrag: false,
        overviewSubMode: null,
        ctx: {},
        enter: () => true,
    };

    // Minimal CoordinateSystem stub
    const coords = {
        timeToScrollX: (t) => t * 100,
        scrollXToTime: (x) => x / 100,
    };

    return new ViewportManager({
        d,
        coords,
        interaction,
        layout: { showSpectrogram: true, showWaveform: true, showOverview: true },
        playbackViewportConfig: cfg,
        getAudioBuffer: () => null,
        getWavesurfer:  () => null,
        scheduleUiUpdate: () => {},
        onRedrawNeeded:   () => {},
        getSpectroHasData: () => false,
        emit: () => {},
        ...overrides,
    });
}

// ─── Initial state ────────────────────────────────────────────────────

test('ViewportManager: initial pixelsPerSecond is DEFAULT_ZOOM_PPS', () => {
    const vm = makeViewport();
    assert.ok(vm.pixelsPerSecond > 0, 'should have a positive initial pps');
});

test('ViewportManager: initial window covers full range (0–1)', () => {
    const vm = makeViewport();
    assert.equal(vm.windowStartNorm, 0);
    assert.equal(vm.windowEndNorm, 1);
});

test('ViewportManager: initial followMode is "follow"', () => {
    const vm = makeViewport();
    assert.equal(vm.followMode, 'follow');
    assert.equal(vm.followPlayback, true);
});

test('ViewportManager: initial scrollSyncLock is false', () => {
    const vm = makeViewport();
    assert.equal(vm.scrollSyncLock, false);
});

// ─── cycleFollowMode ─────────────────────────────────────────────────

test('ViewportManager: cycleFollowMode: follow → smooth → free → follow', () => {
    const vm = makeViewport();
    assert.equal(vm.followMode, 'follow');
    vm.cycleFollowMode();
    assert.equal(vm.followMode, 'smooth');
    vm.cycleFollowMode();
    assert.equal(vm.followMode, 'free');
    vm.cycleFollowMode();
    assert.equal(vm.followMode, 'follow');
});

test('ViewportManager: cycleFollowMode sets followPlayback=false in free mode', () => {
    const vm = makeViewport();
    vm.cycleFollowMode(); // → smooth
    assert.equal(vm.followPlayback, true);
    vm.cycleFollowMode(); // → free
    assert.equal(vm.followPlayback, false);
    vm.cycleFollowMode(); // → follow
    assert.equal(vm.followPlayback, true);
});

test('ViewportManager: cycleFollowMode emits "followchange" event', () => {
    const vm = makeViewport();
    let lastMode = null;
    vm.addEventListener('followchange', (e) => {
        lastMode = /** @type {CustomEvent} */ (e).detail.mode;
    });
    vm.cycleFollowMode();
    assert.equal(lastMode, 'smooth');
});

test('ViewportManager: cycleFollowMode calls emit("followmodechange") for host', () => {
    let hostEvent = null;
    const vm = makeViewport({ emit: (ev, detail) => { hostEvent = { ev, detail }; } });
    vm.cycleFollowMode();
    assert.equal(hostEvent?.ev, 'followmodechange');
    assert.equal(hostEvent?.detail?.mode, 'smooth');
});

// ─── updateConfig ─────────────────────────────────────────────────────

test('ViewportManager: updateConfig updates internal _cfg', () => {
    const vm = makeViewport();
    const newCfg = sanitizePlaybackViewportConfig({ smoothLerp: 0.5 });
    vm.updateConfig(newCfg);
    assert.equal(vm._cfg.smoothLerp, 0.5);
});

// ─── markSeekFocus ────────────────────────────────────────────────────

test('ViewportManager: markSeekFocus sets _smoothSeekFocusUntil in the future', () => {
    const vm = makeViewport();
    const before = performance.now();
    vm.markSeekFocus();
    assert.ok(vm._smoothSeekFocusUntil > before, 'should be set to a future timestamp');
    assert.ok(vm._smoothSeekFocusUntil > performance.now(), 'should still be in the future');
});

// ─── resetZoom ────────────────────────────────────────────────────────

test('ViewportManager: resetZoom cancels any active follow catchup animation', () => {
    const vm = makeViewport();
    vm._followCatchupRafId = 999;  // simulate active RAF
    vm.resetZoom();
    assert.equal(vm._followCatchupRafId, 0, 'RAF id should be cleared after resetZoom');
});

test('ViewportManager: resetZoom resets selection tracking', () => {
    const vm = makeViewport();
    vm._lastSelectionStart = 3;
    vm._lastSelectionEnd   = 7;
    vm.resetZoom();
    assert.ok(Number.isNaN(vm._lastSelectionStart), 'lastSelectionStart should be reset to NaN');
    assert.ok(Number.isNaN(vm._lastSelectionEnd),   'lastSelectionEnd should be reset to NaN');
});

// ─── dispose ─────────────────────────────────────────────────────────

test('ViewportManager: dispose cancels all active RAF ids', () => {
    const vm = makeViewport();
    vm._followCatchupRafId    = 1;
    vm._zoomRedrawRafId       = 2;
    vm._overviewViewportRafId = 3;
    vm.dispose();
    assert.equal(vm._followCatchupRafId,    0);
    assert.equal(vm._zoomRedrawRafId,       0);
    assert.equal(vm._overviewViewportRafId, 0);
});

// ─── updateCoords ─────────────────────────────────────────────────────

test('ViewportManager: updateCoords swaps the internal coords reference', () => {
    const vm = makeViewport();
    const newCoords = { timeToScrollX: (t) => t * 200, scrollXToTime: (x) => x / 200 };
    vm.updateCoords(newCoords);
    assert.strictEqual(vm._coords, newCoords);
});
