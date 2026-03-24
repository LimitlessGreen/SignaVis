/**
 * Check whether a transition from `from` to `to` is allowed.
 *
 * @param {InteractionMode} from
 * @param {InteractionMode} to
 * @returns {boolean}
 */
export function canTransitionInteraction(from: InteractionMode, to: InteractionMode): boolean;
/**
 * Interaction state container.
 * Holds the current mode and mode-specific context.
 */
export class InteractionState {
    /** @type {InteractionMode} */
    mode: InteractionMode;
    /** @type {InteractionContext} */
    ctx: InteractionContext;
    /** @type {number} Timestamp-based click suppression for seek */
    _blockSeekClickUntil: number;
    /** @type {number} Timestamp-based click suppression for overview */
    _overviewSuppressClickUntil: number;
    /** @returns {boolean} */
    get isIdle(): boolean;
    /** @returns {boolean} */
    get isDraggingPlayhead(): boolean;
    /** @returns {boolean} */
    get isDraggingViewport(): boolean;
    /** @returns {boolean} */
    get isOverviewDrag(): boolean;
    /** @returns {boolean} */
    get isViewResize(): boolean;
    /**
     * The overview sub-mode: 'move' | 'left' | 'right' | null.
     * @returns {string | null}
     */
    get overviewSubMode(): string | null;
    /**
     * The view-resize sub-mode: 'split' | 'spectrogram' | null.
     * @returns {string | null}
     */
    get viewResizeSubMode(): string | null;
    /**
     * Transition to a new mode.  Returns false if the transition is invalid.
     *
     * @param {InteractionMode} nextMode
     * @returns {boolean}
     */
    enter(nextMode: InteractionMode): boolean;
    /**
     * Return to idle, resetting all context.
     */
    release(): void;
    /**
     * Block seek-clicks for `ms` milliseconds (e.g. after a drag).
     * @param {number} [ms=220]
     */
    blockSeekClicks(ms?: number): void;
    /**
     * Returns true if seek-clicks are currently suppressed.
     * Covers both timestamp-based blocking and viewport-pan drag threshold.
     * @returns {boolean}
     */
    isSeekBlocked(): boolean;
    /**
     * Clear the pan-based seek suppression (called once after a blocked click is consumed).
     */
    consumeSeekBlock(): void;
    /**
     * Block overview clicks for `ms` milliseconds.
     * @param {number} [ms=260]
     */
    blockOverviewClicks(ms?: number): void;
    /**
     * Returns true if overview clicks are currently suppressed.
     * @returns {boolean}
     */
    isOverviewClickBlocked(): boolean;
}
/**
 * All possible interaction modes.
 * Only 'idle' allows starting a new interaction.
 */
export type InteractionMode = "idle" | "playhead-drag" | "viewport-pan" | "overview-move" | "overview-resize-left" | "overview-resize-right" | "view-resize-split" | "view-resize-spectrogram";
/**
 * Per-mode context data, only valid while the corresponding mode is active.
 */
export type InteractionContext = {
    /**
     * - 'waveform' | 'spectrogram' | 'overview' (playhead-drag)
     */
    playheadSource: string | undefined;
    /**
     * - clientX at pan start (viewport-pan)
     */
    panStartX: number;
    /**
     * - scrollLeft at pan start (viewport-pan)
     */
    panStartScroll: number;
    /**
     * - true once drag exceeds 3px (viewport-pan)
     */
    panSuppressClick: boolean;
    /**
     * - clientX at overview drag start
     */
    overviewStartX: number;
    /**
     * - windowStartNorm at drag start
     */
    overviewStartNorm: number;
    /**
     * - windowEndNorm at drag start
     */
    overviewEndNorm: number;
    /**
     * - true once drag exceeds 2px threshold
     */
    overviewMoved: boolean;
    /**
     * - clientY at resize start (view-resize)
     */
    resizeStartY: number;
    /**
     * - waveformDisplayHeight at resize start
     */
    resizeStartWaveformH: number;
    /**
     * - spectrogramDisplayHeight at resize start
     */
    resizeStartSpectrogramH: number;
};
/**
 * All possible interaction modes.
 * Only 'idle' allows starting a new interaction.
 *
 * @typedef {'idle'
 *   | 'playhead-drag'
 *   | 'viewport-pan'
 *   | 'overview-move'
 *   | 'overview-resize-left'
 *   | 'overview-resize-right'
 *   | 'view-resize-split'
 *   | 'view-resize-spectrogram'
 * } InteractionMode
 */
/**
 * Per-mode context data, only valid while the corresponding mode is active.
 *
 * @typedef {Object} InteractionContext
 * @property {string | undefined} playheadSource       - 'waveform' | 'spectrogram' | 'overview' (playhead-drag)
 * @property {number}         panStartX               - clientX at pan start (viewport-pan)
 * @property {number}         panStartScroll           - scrollLeft at pan start (viewport-pan)
 * @property {boolean}        panSuppressClick         - true once drag exceeds 3px (viewport-pan)
 * @property {number}         overviewStartX           - clientX at overview drag start
 * @property {number}         overviewStartNorm        - windowStartNorm at drag start
 * @property {number}         overviewEndNorm          - windowEndNorm at drag start
 * @property {boolean}        overviewMoved            - true once drag exceeds 2px threshold
 * @property {number}         resizeStartY             - clientY at resize start (view-resize)
 * @property {number}         resizeStartWaveformH     - waveformDisplayHeight at resize start
 * @property {number}         resizeStartSpectrogramH  - spectrogramDisplayHeight at resize start
 */
/** @type {ReadonlySet<InteractionMode>} */
export const OVERVIEW_MODES: ReadonlySet<InteractionMode>;
/** @type {ReadonlySet<InteractionMode>} */
export const VIEW_RESIZE_MODES: ReadonlySet<InteractionMode>;
