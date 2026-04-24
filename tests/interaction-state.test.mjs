import test from 'node:test';
import assert from 'node:assert/strict';
import {
    InteractionState,
    canTransitionInteraction,
    OVERVIEW_MODES,
    VIEW_RESIZE_MODES,
} from '../src/app/interactionState.ts';

// ── Transition validation ──

test('allows idle → any active mode', () => {
    const modes = [
        'playhead-drag', 'viewport-pan',
        'overview-move', 'overview-resize-left', 'overview-resize-right',
        'view-resize-split', 'view-resize-spectrogram',
    ];
    for (const m of modes) {
        assert.equal(canTransitionInteraction('idle', m), true, `idle → ${m}`);
    }
});

test('allows any active mode → idle', () => {
    const modes = [
        'playhead-drag', 'viewport-pan',
        'overview-move', 'overview-resize-left', 'overview-resize-right',
        'view-resize-split', 'view-resize-spectrogram',
    ];
    for (const m of modes) {
        assert.equal(canTransitionInteraction(m, 'idle'), true, `${m} → idle`);
    }
});

test('rejects direct mode-to-mode transitions', () => {
    assert.equal(canTransitionInteraction('playhead-drag', 'viewport-pan'), false);
    assert.equal(canTransitionInteraction('overview-move', 'view-resize-split'), false);
    assert.equal(canTransitionInteraction('viewport-pan', 'overview-resize-left'), false);
});

test('rejects idle → idle', () => {
    assert.equal(canTransitionInteraction('idle', 'idle'), false);
});

// ── InteractionState class ──

test('starts in idle mode', () => {
    const s = new InteractionState();
    assert.equal(s.mode, 'idle');
    assert.equal(s.isIdle, true);
});

test('enter() transitions from idle to active mode', () => {
    const s = new InteractionState();
    assert.equal(s.enter('playhead-drag'), true);
    assert.equal(s.mode, 'playhead-drag');
    assert.equal(s.isDraggingPlayhead, true);
    assert.equal(s.isIdle, false);
});

test('enter() rejects invalid transition', () => {
    const s = new InteractionState();
    s.enter('playhead-drag');
    assert.equal(s.enter('viewport-pan'), false);
    assert.equal(s.mode, 'playhead-drag');
});

test('release() returns to idle and resets context', () => {
    const s = new InteractionState();
    s.enter('viewport-pan');
    s.ctx.panStartX = 42;
    s.ctx.panSuppressClick = true;
    s.release();
    assert.equal(s.mode, 'idle');
    assert.equal(s.ctx.panStartX, 0);
    assert.equal(s.ctx.panSuppressClick, false);
});

// ── Getters ──

test('overview getters work correctly', () => {
    const s = new InteractionState();
    s.enter('overview-move');
    assert.equal(s.isOverviewDrag, true);
    assert.equal(s.overviewSubMode, 'move');
    s.release();
    s.enter('overview-resize-left');
    assert.equal(s.overviewSubMode, 'left');
    s.release();
    s.enter('overview-resize-right');
    assert.equal(s.overviewSubMode, 'right');
});

test('viewResize getters work correctly', () => {
    const s = new InteractionState();
    s.enter('view-resize-split');
    assert.equal(s.isViewResize, true);
    assert.equal(s.viewResizeSubMode, 'split');
    s.release();
    s.enter('view-resize-spectrogram');
    assert.equal(s.viewResizeSubMode, 'spectrogram');
});

test('getters return null/false when idle', () => {
    const s = new InteractionState();
    assert.equal(s.overviewSubMode, null);
    assert.equal(s.viewResizeSubMode, null);
    assert.equal(s.isOverviewDrag, false);
    assert.equal(s.isViewResize, false);
    assert.equal(s.isDraggingPlayhead, false);
    assert.equal(s.isDraggingViewport, false);
});

// ── Seek blocking ──

test('blockSeekClicks sets time-based block', () => {
    const s = new InteractionState();
    assert.equal(s.isSeekBlocked(), false);
    s.blockSeekClicks(100);
    assert.equal(s.isSeekBlocked(), true);
});

test('panSuppressClick blocks seek', () => {
    const s = new InteractionState();
    s.ctx.panSuppressClick = true;
    assert.equal(s.isSeekBlocked(), true);
    s.consumeSeekBlock();
    assert.equal(s.ctx.panSuppressClick, false);
});

// ── Overview click blocking ──

test('blockOverviewClicks sets time-based block', () => {
    const s = new InteractionState();
    assert.equal(s.isOverviewClickBlocked(), false);
    s.blockOverviewClicks(100);
    assert.equal(s.isOverviewClickBlocked(), true);
});

// ── Set exports ──

test('OVERVIEW_MODES contains the three overview modes', () => {
    assert.equal(OVERVIEW_MODES.size, 3);
    assert.equal(OVERVIEW_MODES.has('overview-move'), true);
    assert.equal(OVERVIEW_MODES.has('overview-resize-left'), true);
    assert.equal(OVERVIEW_MODES.has('overview-resize-right'), true);
});

test('VIEW_RESIZE_MODES contains the two resize modes', () => {
    assert.equal(VIEW_RESIZE_MODES.size, 2);
    assert.equal(VIEW_RESIZE_MODES.has('view-resize-split'), true);
    assert.equal(VIEW_RESIZE_MODES.has('view-resize-spectrogram'), true);
});

// ── Exclusivity guarantee ──

test('only one interaction can be active at a time', () => {
    const s = new InteractionState();
    s.enter('playhead-drag');
    // Trying to enter another mode while one is active should fail
    assert.equal(s.enter('viewport-pan'), false);
    assert.equal(s.enter('overview-move'), false);
    assert.equal(s.enter('view-resize-split'), false);
    // Still in original mode
    assert.equal(s.mode, 'playhead-drag');
});

test('blockSeekClicks survives release()', () => {
    const s = new InteractionState();
    s.enter('viewport-pan');
    s.blockSeekClicks(500);
    s.release();
    // Timestamp-based block persists after release
    assert.equal(s.isSeekBlocked(), true);
});
