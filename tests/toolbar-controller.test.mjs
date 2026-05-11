// ═══════════════════════════════════════════════════════════════════════
// toolbar-controller.test.mjs — Unit tests for ToolbarController
// ═══════════════════════════════════════════════════════════════════════

import test from 'node:test';
import assert from 'node:assert/strict';
import { ToolbarController } from '../src/app/player/ToolbarController.ts';

if (typeof globalThis.requestAnimationFrame === 'undefined') {
    globalThis.requestAnimationFrame = (fn) => setTimeout(fn, 0);
    globalThis.cancelAnimationFrame  = (id) => clearTimeout(id);
}

function makeClassList() {
    const classes = new Set();
    return {
        add:      (...c) => c.forEach(x => classes.add(x)),
        remove:   (...c) => c.forEach(x => classes.delete(x)),
        toggle:   (c, force) => {
            if (typeof force === 'boolean') { force ? classes.add(c) : classes.delete(c); }
            else { classes.has(c) ? classes.delete(c) : classes.add(c); }
        },
        contains: (c) => classes.has(c),
    };
}

function makeBtn(label = '') {
    return {
        classList: makeClassList(),
        disabled: false,
        textContent: label,
        title: '',
        setAttribute: () => {},
        getAttribute: () => null,
        scrollWidth: 100,
        clientWidth: 100,
    };
}

function makeContainer() {
    return { classList: makeClassList() };
}

function makeDeps(overrides = {}) {
    const container = makeContainer();
    const deps = {
        container,
        d: {
            toolbarRoot:      makeBtn(),
            compactMoreBtn:   makeBtn(),
            settingsToggleBtn: makeBtn(),
            settingsPanel:    { hidden: false },
            playPauseBtn:     makeBtn(),
            stopBtn:          makeBtn(),
            jumpStartBtn:     makeBtn(),
            jumpEndBtn:       makeBtn(),
            backwardBtn:      makeBtn(),
            forwardBtn:       makeBtn(),
            followToggleBtn:  makeBtn('Follow'),
            loopToggleBtn:    makeBtn('Loop'),
            crosshairToggleBtn: makeBtn(),
            fitViewBtn:       makeBtn(),
            resetViewBtn:     makeBtn(),
            autoContrastBtn:  makeBtn(),
            autoFreqBtn:      makeBtn(),
        },
        compactToolbarMode: 'auto',
        transportOverlay: false,
        getFollowMode:    () => 'follow',
        getLoopPlayback:  () => false,
        setFollowPlayback: () => {},
        ...overrides,
    };
    return { deps, container };
}

// ─── 1. Construction ─────────────────────────────────────────────────

test('ToolbarController: constructs without error', () => {
    const { deps } = makeDeps();
    const ctrl = new ToolbarController(deps);
    assert.ok(ctrl);
    ctrl.dispose();
});

// ─── 2. setTransportEnabled disables buttons ─────────────────────────

test('ToolbarController: setTransportEnabled(false) disables all transport buttons', () => {
    const { deps } = makeDeps();
    const ctrl = new ToolbarController(deps);
    ctrl.setTransportEnabled(false);
    assert.strictEqual(deps.d.playPauseBtn.disabled, true);
    assert.strictEqual(deps.d.stopBtn.disabled, true);
    assert.strictEqual(deps.d.fitViewBtn.disabled, true);
    ctrl.dispose();
});

test('ToolbarController: setTransportEnabled(true) enables buttons', () => {
    const { deps } = makeDeps();
    const ctrl = new ToolbarController(deps);
    ctrl.setTransportEnabled(false);
    ctrl.setTransportEnabled(true);
    assert.strictEqual(deps.d.playPauseBtn.disabled, false);
    ctrl.dispose();
});

// ─── 3. setCompactToolbarOpen ────────────────────────────────────────

test('ToolbarController: setCompactToolbarOpen(true) only opens when compact is active', () => {
    const { deps, container } = makeDeps({ compactToolbarMode: 'on' });
    // Make toolbarRoot overflow to force compact active
    deps.d.toolbarRoot.scrollWidth = 200;
    deps.d.toolbarRoot.clientWidth = 100;
    const ctrl = new ToolbarController(deps);
    ctrl.refreshLayout();
    ctrl.setCompactToolbarOpen(true);
    assert.strictEqual(container.classList.contains('compact-toolbar-open'), true);
    ctrl.dispose();
});

// ─── 4. setSettingsPanelOpen ─────────────────────────────────────────

test('ToolbarController: setSettingsPanelOpen(true) adds class and updates button', () => {
    const { deps, container } = makeDeps();
    const ctrl = new ToolbarController(deps);
    ctrl.setSettingsPanelOpen(true);
    assert.strictEqual(container.classList.contains('settings-panel-open'), true);
    ctrl.dispose();
});

test('ToolbarController: setSettingsPanelOpen(false) removes class', () => {
    const { deps, container } = makeDeps();
    const ctrl = new ToolbarController(deps);
    ctrl.setSettingsPanelOpen(true);
    ctrl.setSettingsPanelOpen(false);
    assert.strictEqual(container.classList.contains('settings-panel-open'), false);
    ctrl.dispose();
});

// ─── 5. dispose ──────────────────────────────────────────────────────

test('ToolbarController: dispose() does not throw', () => {
    const { deps } = makeDeps();
    const ctrl = new ToolbarController(deps);
    assert.doesNotThrow(() => ctrl.dispose());
});
