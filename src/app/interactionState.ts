// ═══════════════════════════════════════════════════════════════════════
// interactionState.ts - Interaction State Machine

import { SEEK_CLICK_BLOCK_MS, OVERVIEW_CLICK_BLOCK_MS } from '../shared/constants.ts';
import { defineStateMachine, canTransition } from '../shared/stateMachine.ts';
//
// Consolidates the ~15 loose boolean/string flags that previously
// tracked playhead-drag, viewport-pan, overview-drag, and view-resize
// into a single exclusive FSM.  Only one interaction mode can be active
// at a time, which structurally prevents impossible combinations like
// draggingPlayhead && draggingViewport simultaneously.
//
// Pattern mirrors transportState.js: explicit states, validated
// transitions, typed context per mode.
// ═══════════════════════════════════════════════════════════════════════

export type InteractionMode =
    | 'idle'
    | 'playhead-drag'
    | 'viewport-pan'
    | 'overview-move'
    | 'overview-resize-left'
    | 'overview-resize-right'
    | 'view-resize-split'
    | 'view-resize-spectrogram';

/**
 * Per-mode context data, only valid while the corresponding mode is active.
 *
 * @typedef {Object} InteractionContext
 * @property {string | undefined} playheadSource       - 'waveform' | 'spectrogram' | 'overview' (playhead-drag)
 * @property {number}         panStartX               - clientX at pan start (viewport-pan)
 * @property {number}         panStartY               - clientY at pan start (viewport-pan)
 * @property {number}         panStartScroll           - scrollLeft at pan start (viewport-pan)
 * @property {boolean}        panSuppressClick         - true once drag exceeds 3px (viewport-pan)
 * @property {boolean}        panIsMiddle              - true if middle mouse button started the pan
 * @property {string | undefined} panSource            - 'waveform' | 'spectrogram' (viewport-pan)
 * @property {number | null}  panStartFreqViewMin      - freq viewport min at pan start (viewport-pan)
 * @property {number | null}  panStartFreqViewMax      - freq viewport max at pan start (viewport-pan)
 * @property {number}         overviewStartX           - clientX at overview drag start
 * @property {number}         overviewStartNorm        - windowStartNorm at drag start
 * @property {number}         overviewEndNorm          - windowEndNorm at drag start
 * @property {boolean}        overviewMoved            - true once drag exceeds 2px threshold
 * @property {number}         resizeStartY             - clientY at resize start (view-resize)
 * @property {number}         resizeStartWaveformH     - waveformDisplayHeight at resize start
 * @property {number}         resizeStartSpectrogramH  - spectrogramDisplayHeight at resize start
 */

const OVERVIEW_MODES = new Set<InteractionMode>(['overview-move', 'overview-resize-left', 'overview-resize-right']);
const VIEW_RESIZE_MODES = new Set<InteractionMode>(['view-resize-split', 'view-resize-spectrogram']);

const INTERACTION_MACHINE = defineStateMachine<InteractionMode>({
    states: [
        'idle', 'playhead-drag', 'viewport-pan',
        'overview-move', 'overview-resize-left', 'overview-resize-right',
        'view-resize-split', 'view-resize-spectrogram',
    ],
    labels: {
        'idle':                    'Idle',
        'playhead-drag':           'Playhead drag',
        'viewport-pan':            'Viewport pan',
        'overview-move':           'Overview move',
        'overview-resize-left':    'Overview resize left',
        'overview-resize-right':   'Overview resize right',
        'view-resize-split':       'View resize split',
        'view-resize-spectrogram': 'View resize spectrogram',
    },
    transitions: {
        'idle':                    new Set(['playhead-drag', 'viewport-pan', 'overview-move', 'overview-resize-left', 'overview-resize-right', 'view-resize-split', 'view-resize-spectrogram']),
        'playhead-drag':           new Set(['idle']),
        'viewport-pan':            new Set(['idle']),
        'overview-move':           new Set(['idle']),
        'overview-resize-left':    new Set(['idle']),
        'overview-resize-right':   new Set(['idle']),
        'view-resize-split':       new Set(['idle']),
        'view-resize-spectrogram': new Set(['idle']),
    },
});

export function canTransitionInteraction(from: InteractionMode, to: InteractionMode): boolean {
    return canTransition(INTERACTION_MACHINE, from, to);
}

/**
 * Create a fresh default context (all fields at neutral/zero values).
 *
 * @returns {InteractionContext}
 */
function defaultContext() {
    return {
        playheadSource: undefined,
        panStartX: 0,
        panStartScroll: 0,
        panSuppressClick: false,
        panStartY: 0,
        panIsMiddle: false,
        panSource: undefined,
        panStartFreqViewMin: null,
        panStartFreqViewMax: null,
        overviewStartX: 0,
        overviewStartNorm: 0,
        overviewEndNorm: 1,
        overviewMoved: false,
        resizeStartY: 0,
        resizeStartWaveformH: 0,
        resizeStartSpectrogramH: 0,
    };
}

/**
 * Interaction state container.
 * Holds the current mode and mode-specific context.
 */

export interface InteractionContext {
    playheadSource?: string | undefined;
    panStartX?: number;
    panStartY?: number;
    panStartScroll?: number;
    panSuppressClick?: boolean;
    panIsMiddle?: boolean;
    panSource?: string | undefined;
    panStartFreqViewMin?: number | null;
    panStartFreqViewMax?: number | null;
    overviewStartX?: number;
    overviewStartNorm?: number;
    overviewEndNorm?: number;
    overviewMoved?: boolean;
    resizeStartY?: number;
    resizeStartWaveformH?: number;
    resizeStartSpectrogramH?: number;
}

export class InteractionState {
    mode: InteractionMode;
    ctx: InteractionContext;
    _blockSeekClickUntil: number;
    _overviewSuppressClickUntil: number;
    constructor() {
        /** @type {InteractionMode} */
        this.mode = 'idle';
        /** @type {InteractionContext} */
        this.ctx = defaultContext();
        /** @type {number} Timestamp-based click suppression for seek */
        this._blockSeekClickUntil = 0;
        /** @type {number} Timestamp-based click suppression for overview */
        this._overviewSuppressClickUntil = 0;
    }

    /** @returns {boolean} */
    get isIdle() { return this.mode === 'idle'; }

    /** @returns {boolean} */
    get isDraggingPlayhead() { return this.mode === 'playhead-drag'; }

    /** @returns {boolean} */
    get isDraggingViewport() { return this.mode === 'viewport-pan'; }

    /** @returns {boolean} */
    get isOverviewDrag() { return OVERVIEW_MODES.has(this.mode); }

    /** @returns {boolean} */
    get isViewResize() { return VIEW_RESIZE_MODES.has(this.mode); }

    /**
     * The overview sub-mode: 'move' | 'left' | 'right' | null.
     * @returns {string | null}
     */
    get overviewSubMode() {
        switch (this.mode) {
            case 'overview-move':         return 'move';
            case 'overview-resize-left':  return 'left';
            case 'overview-resize-right': return 'right';
            default:                      return null;
        }
    }

    /**
     * The view-resize sub-mode: 'split' | 'spectrogram' | null.
     * @returns {string | null}
     */
    get viewResizeSubMode() {
        switch (this.mode) {
            case 'view-resize-split':        return 'split';
            case 'view-resize-spectrogram':  return 'spectrogram';
            default:                         return null;
        }
    }

    /**
     * Transition to a new mode.  Returns false if the transition is invalid.
     *
     * @param {InteractionMode} nextMode
     * @returns {boolean}
     */
    enter(nextMode: InteractionMode) {
        if (!canTransitionInteraction(this.mode, nextMode)) return false;
        this.mode = nextMode;
        if (nextMode === 'idle') this.ctx = defaultContext();
        return true;
    }

    /**
     * Return to idle, resetting all context.
     */
    release() {
        this.mode = 'idle';
        this.ctx = defaultContext();
    }

    /**
     * Block seek-clicks for `ms` milliseconds (e.g. after a drag).
     * @param {number} [ms=220]
     */
    blockSeekClicks(ms = SEEK_CLICK_BLOCK_MS) {
        this._blockSeekClickUntil = Math.max(this._blockSeekClickUntil, performance.now() + ms);
    }

    /**
     * Returns true if seek-clicks are currently suppressed.
     * Covers both timestamp-based blocking and viewport-pan drag threshold.
     * @returns {boolean}
     */
    isSeekBlocked() {
        if (performance.now() < this._blockSeekClickUntil) return true;
        if (this.ctx.panSuppressClick) return true;
        return false;
    }

    /**
     * Clear the pan-based seek suppression (called once after a blocked click is consumed).
     */
    consumeSeekBlock() {
        this.ctx.panSuppressClick = false;
    }

    /**
     * Block overview clicks for `ms` milliseconds.
     * @param {number} [ms=260]
     */
    blockOverviewClicks(ms = OVERVIEW_CLICK_BLOCK_MS) {
        this._overviewSuppressClickUntil = Math.max(
            this._overviewSuppressClickUntil, performance.now() + ms,
        );
    }

    /**
     * Returns true if overview clicks are currently suppressed.
     * @returns {boolean}
     */
    isOverviewClickBlocked() {
        return performance.now() < this._overviewSuppressClickUntil;
    }
}

export { OVERVIEW_MODES, VIEW_RESIZE_MODES };
