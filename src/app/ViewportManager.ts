// ═══════════════════════════════════════════════════════════════════════
// ViewportManager.ts — Horizontal scroll, zoom, follow-mode and overview
//
// Owns:
//   • pixelsPerSecond (horizontal zoom level)
//   • windowStartNorm / windowEndNorm (overview window position 0–1)
//   • followMode ('free' | 'follow' | 'smooth') and followPlayback flag
//   • Follow-mode catchup animation (RAF loop)
//   • Smooth-follow lerp logic
//   • Overview drag state sync
//   • Scroll synchronisation across linked wrappers
//
// Does NOT own:
//   • Canvas rendering (delegated via onRedrawNeeded callback)
//   • Frequency viewport (owned by FrequencyViewport)
//   • Interaction state machine (owned by InteractionState)
//   • CoordinateSystem instance (owned by PlayerState, passed by reference)
//
// Events emitted (via EventTarget):
//   'zoomchange'     — { pixelsPerSecond: number }
//   'followchange'   — { mode: string }
//   'selection'      — { start: number, end: number }  (viewport visible range)
// ═══════════════════════════════════════════════════════════════════════

import { clamp, formatSecondsShort } from '../shared/utils.ts';
import { DEFAULT_ZOOM_PPS, MIN_WINDOW_NORM } from '../shared/constants.ts';

import type { CoordinateSystem } from '../domain/coordinateSystem.ts';
import type { InteractionState } from './interactionState.ts';
import type { PlaybackViewportConfig } from './PlayerState.ts';

export interface ViewportManagerOptions {
    d: Record<string, HTMLElement>;
    coords: CoordinateSystem;
    interaction: InteractionState;
    layout: { spectrogramHeight: number; waveformHeight: number; showSpectrogram?: boolean; showWaveform?: boolean; showOverview?: boolean };
    playbackViewportConfig: PlaybackViewportConfig;
    getAudioBuffer: () => AudioBuffer | null;
    getWavesurfer: () => unknown;
    scheduleUiUpdate: (opts?: { redrawSpectrogram?: boolean }) => void;
    onRedrawNeeded: () => void;
    getSpectroHasData: () => boolean;
    emit: (name: string, detail?: unknown) => void;
}

export class ViewportManager extends EventTarget {
    _d: any;
    _coords: any;
    _interaction: any;
    _layout: any;
    _cfg: any;
    _getAudioBuffer: any;
    _getWavesurfer: any;
    _scheduleUiUpdate: any;
    _onRedrawNeeded: any;
    _getSpectroHasData: any;
    _emitHost: any;
    pixelsPerSecond: any;
    windowStartNorm: any;
    windowEndNorm: any;
    followMode: any;
    followPlayback: any;
    scrollSyncLock: any;
    _smoothSeekFocusUntil: any;
    _followCatchupRafId: any;
    _followCatchupAnim: any;
    _zoomRedrawRafId: any;
    _overviewViewportRafId: any;
    _overviewNeedsFinalRedraw: any;
    _lastSelectionEmitAt: any;
    _lastSelectionStart: any;
    _lastSelectionEnd: any;
    _lastViewRangeTextStart: any;
    _lastViewRangeTextEnd: any;
    /**
     * @param {object} opts
     * @param {object}   opts.d              - DOM-refs subset (canvasWrapper, waveformWrapper,
     *                                         overviewContainer, overviewWindow, viewRangeDisplay,
     *                                         zoomSlider, zoomValue, spectrogramCanvas, amplitudeCanvas)
     * @param {import('../domain/coordinateSystem.ts').CoordinateSystem} opts.coords
     * @param {import('./interactionState.ts').InteractionState} opts.interaction
     * @param {object}   opts.layout         - { showSpectrogram, showWaveform, showOverview }
     * @param {import('./PlayerState.ts').PlaybackViewportConfig} opts.playbackViewportConfig
     * @param {() => AudioBuffer | null}     opts.getAudioBuffer
     * @param {() => any}                    opts.getWavesurfer
     * @param {(detail: object) => void}     opts.scheduleUiUpdate
     * @param {() => void}                   opts.onRedrawNeeded  - full redraw (spectrogram + waveform)
     * @param {() => boolean}                opts.getSpectroHasData
     * @param {(event: string, detail: object) => void} opts.emit
     */
    constructor({ d, coords, interaction, layout, playbackViewportConfig,
                  getAudioBuffer, getWavesurfer, scheduleUiUpdate,
                  onRedrawNeeded, getSpectroHasData, emit }: ViewportManagerOptions) {
        super();

        this._d           = d;
        this._coords      = coords;
        this._interaction = interaction;
        this._layout      = layout;
        this._cfg         = playbackViewportConfig;

        // Injected callbacks
        this._getAudioBuffer   = getAudioBuffer;
        this._getWavesurfer    = getWavesurfer;
        this._scheduleUiUpdate = scheduleUiUpdate;
        this._onRedrawNeeded   = onRedrawNeeded;
        this._getSpectroHasData = getSpectroHasData;
        this._emitHost         = emit;

        // ── State ────────────────────────────────────────────────────
        this.pixelsPerSecond = DEFAULT_ZOOM_PPS;
        this.windowStartNorm = 0;
        this.windowEndNorm   = 1;
        this.followMode      = 'follow';  // 'free' | 'follow' | 'smooth'
        this.followPlayback  = true;
        this.scrollSyncLock  = false;

        // Internal RAF / animation state
        this._smoothSeekFocusUntil  = 0;
        this._followCatchupRafId    = 0;
        this._followCatchupAnim     = null;
        this._zoomRedrawRafId       = 0;
        this._overviewViewportRafId = 0;
        this._overviewNeedsFinalRedraw = false;

        // Throttle / dedup tracking
        this._lastSelectionEmitAt  = 0;
        this._lastSelectionStart   = NaN;
        this._lastSelectionEnd     = NaN;
        this._lastViewRangeTextStart = NaN;
        this._lastViewRangeTextEnd   = NaN;
    }

    // ── Config ───────────────────────────────────────────────────────

    /**
     * Called by PlayerState whenever the playback viewport config is updated.
     * @param {import('./PlayerState.ts').PlaybackViewportConfig} cfg
     */
    updateConfig(cfg: PlaybackViewportConfig) {
        this._cfg = cfg;
    }

    /**
     * Called by PlayerState when coords are rebuilt.
     * @param {import('../domain/coordinateSystem.ts').CoordinateSystem} coords
     */
    updateCoords(coords: CoordinateSystem) {
        this._coords = coords;
    }

    /**
     * Called by PlayerState when layout visibility changes.
     * @param {object} layout
     */
    updateLayout(layout: Partial<{ spectrogramHeight: number; waveformHeight: number; showSpectrogram?: boolean; showWaveform?: boolean; showOverview?: boolean }>) {
        this._layout = { ...this._layout, ...layout };
    }

    // ── Follow-mode ──────────────────────────────────────────────────

    /**
     * Called when a seek happens during playback — activates the slow-lerp window.
     */
    markSeekFocus() {
        this._smoothSeekFocusUntil = performance.now() + this._cfg.smoothSeekFocusMs;
    }

    /**
     * Apply follow-mode scrolling for the given playhead pixel position.
     * Called from PlayerState on each `uiupdate` event during playback.
     * @param {number} position  - playhead position in pixels (timeToScrollX result)
     */
    applyFollowScroll(position: number) {
        const vw = this._getViewportWidth();
        if (this.followMode === 'smooth') {
            this._applySmoothFollow(position, vw);
        } else {
            const scrollLeft = this._getPrimaryScrollLeft();
            const guardLeft  = scrollLeft + vw * this._cfg.followGuardLeftRatio;
            const guardRight = scrollLeft + vw * this._cfg.followGuardRightRatio;
            if (position < guardLeft || position > guardRight) {
                this._animateFollowCatchupTo(
                    Math.max(0, position - vw * this._cfg.followTargetRatio),
                );
            }
        }
    }

    /**
     * Cycle through follow modes: follow → smooth → free → follow.
     * @returns {string} new follow mode
     */
    cycleFollowMode() {
        this.followMode = this.followMode === 'free'
            ? 'follow'
            : this.followMode === 'follow'
                ? 'smooth'
                : 'free';
        this.followPlayback = this.followMode !== 'free';
        if (this.followMode !== 'follow') this._cancelFollowCatchupAnimation();
        this.dispatchEvent(new CustomEvent('followchange', { detail: { mode: this.followMode } }));
        this._emitHost('followmodechange', { mode: this.followMode });
        return this.followMode;
    }

    // ── Scroll / zoom ────────────────────────────────────────────────

    getPrimaryScrollLeft() { return this._getPrimaryScrollLeft(); }
    getViewportWidth()     { return this._getViewportWidth(); }

    /**
     * Set zoom level with optional anchor point.
     * @param {number}  nextPps
     * @param {boolean} redraw
     * @param {number}  [anchorTime]   - time in seconds at anchor pixel
     * @param {number}  [anchorPixel]  - pixel X of anchor in viewport
     */
    setPixelsPerSecond(nextPps: number, redraw: boolean, anchorTime?: number, anchorPixel?: number) {
        this._setPixelsPerSecond(nextPps, redraw, anchorTime, anchorPixel);
    }

    /**
     * Fit the entire audio track into the current viewport.
     */
    fitEntireTrackInView() {
        const buf = this._getAudioBuffer();
        if (!buf) return;
        const fitPps = this._getViewportWidth() / Math.max(0.05, buf.duration);
        this._setPixelsPerSecond(fitPps, true, 0, 0);
    }

    /**
     * Zoom by a multiplicative scale around a client-space X coordinate.
     * @param {number} scale
     * @param {number} centerClientX
     * @param {'spectrogram'|'waveform'} [source]
     */
    zoomByScale(scale: number, centerClientX: number, source = 'spectrogram') {
        const buf = this._getAudioBuffer();
        if (!buf) return;
        const wrapper = source === 'waveform' ? this._d.waveformWrapper : this._d.canvasWrapper;
        const rect    = wrapper.getBoundingClientRect();
        const localX  = clamp(centerClientX - rect.left, 0, rect.width);
        const anchorTime = this._coords.scrollXToTime(wrapper.scrollLeft + localX);
        this._setPixelsPerSecond(this.pixelsPerSecond * scale, true, anchorTime, localX);
    }

    /**
     * Scroll the viewport so that timeSec is horizontally centred.
     * @param {number} timeSec
     */
    centerViewportAtTime(timeSec: number) {
        const buf = this._getAudioBuffer();
        if (!buf) return;
        const vw      = this._getViewportWidth();
        const viewDur = this._coords.scrollXToTime(vw);
        let start = timeSec - viewDur / 2;
        start = clamp(start, 0, Math.max(0, buf.duration - viewDur));
        this._setLinkedScrollLeft(this._coords.timeToScrollX(start));
    }

    /**
     * Convert a client-space X coordinate to an audio time.
     * @param {number} clientX
     * @param {'spectrogram'|'waveform'} [source]
     * @returns {number}
     */
    clientXToTime(clientX: number, source = 'spectrogram') {
        const wrapper  = source === 'waveform' ? this._d.waveformWrapper : this._d.canvasWrapper;
        const rect     = wrapper.getBoundingClientRect();
        const scrollX  = clientX - rect.left + wrapper.scrollLeft;
        const dur      = this._getAudioBuffer()?.duration || 0;
        return clamp(this._coords.scrollXToTime(scrollX), 0, dur);
    }

    /**
     * Reset zoom and scroll state when a new file is loaded.
     * @param {number} [pps]
     */
    resetZoom(pps = DEFAULT_ZOOM_PPS) {
        if (this._zoomRedrawRafId) {
            cancelAnimationFrame(this._zoomRedrawRafId);
            this._zoomRedrawRafId = 0;
        }
        if (this._overviewViewportRafId) {
            cancelAnimationFrame(this._overviewViewportRafId);
            this._overviewViewportRafId = 0;
        }
        this._cancelFollowCatchupAnimation();
        this._setPixelsPerSecond(pps, false);
        this._lastSelectionEmitAt    = 0;
        this._lastSelectionStart     = NaN;
        this._lastSelectionEnd       = NaN;
        this._lastViewRangeTextStart = NaN;
        this._lastViewRangeTextEnd   = NaN;
    }

    // ── Overview Navigator ───────────────────────────────────────────

    /**
     * Sync the overview window element to the current scroll/zoom position.
     * Call after every playhead update and scroll event.
     */
    syncOverviewWindowToViewport() {
        this._syncOverviewWindowToViewport();
    }

    updateOverviewWindowElement() {
        this._updateOverviewWindowElement();
    }

    getOverviewSpanConstraints() {
        return this._getOverviewSpanConstraints();
    }

    /**
     * Start an overview navigator drag.
     * @param {'move'|'left'|'right'} mode
     * @param {number} clientX
     */
    startOverviewDrag(mode: 'move'|'left'|'right', clientX: number) {
        this._startOverviewDrag(mode, clientX);
    }

    /**
     * Update overview drag in progress.
     * @param {number} clientX
     */
    updateOverviewDrag(clientX: number) {
        this._updateOverviewDrag(clientX);
    }

    /**
     * Queue a deferred viewport apply from the overview window position.
     * @param {boolean} [redrawFinal]
     */
    queueOverviewViewportApply(redrawFinal = false) {
        this._queueOverviewViewportApply(redrawFinal);
    }

    applyOverviewWindowToViewport(redraw = true) {
        this._applyOverviewWindowToViewport(redraw);
    }

    // ── Cleanup ──────────────────────────────────────────────────────

    dispose() {
        this._cancelFollowCatchupAnimation();
        if (this._zoomRedrawRafId) {
            cancelAnimationFrame(this._zoomRedrawRafId);
            this._zoomRedrawRafId = 0;
        }
        if (this._overviewViewportRafId) {
            cancelAnimationFrame(this._overviewViewportRafId);
            this._overviewViewportRafId = 0;
        }
    }

    // ═════════════════════════════════════════════════════════════════
    //  Private implementation
    // ═════════════════════════════════════════════════════════════════

    _getPrimaryScrollWrapper() {
        if (!this._layout.showSpectrogram && this._layout.showWaveform) return this._d.waveformWrapper;
        return this._d.canvasWrapper || this._d.waveformWrapper;
    }

    _getSecondaryScrollWrapper() {
        const primary = this._getPrimaryScrollWrapper();
        if (primary === this._d.canvasWrapper)   return this._d.waveformWrapper;
        if (primary === this._d.waveformWrapper) return this._d.canvasWrapper;
        return null;
    }

    _getPrimaryScrollLeft() {
        return this._getPrimaryScrollWrapper()?.scrollLeft || 0;
    }

    _getViewportWidth() {
        const primary   = this._getPrimaryScrollWrapper();
        const secondary = this._getSecondaryScrollWrapper();
        return Math.max(1, primary?.clientWidth || secondary?.clientWidth || 0);
    }

    _setLinkedScrollLeft(nextLeft: number) {
        if (this.scrollSyncLock) return;
        this.scrollSyncLock = true;

        const buf = this._getAudioBuffer();
        const vw  = this._getViewportWidth();
        const tw  = buf ? Math.max(1, Math.floor(this._coords.timeToScrollX(buf.duration))) : 0;
        const maxScroll = Math.max(0, tw - vw);
        const bounded   = clamp(nextLeft, 0, maxScroll);

        const primary   = this._getPrimaryScrollWrapper();
        const secondary = this._getSecondaryScrollWrapper();
        if (primary)   primary.scrollLeft   = bounded;
        if (secondary) secondary.scrollLeft = primary?.scrollLeft ?? bounded;

        this.scrollSyncLock = false;
        this._scheduleUiUpdate({ time: this._getCurrentTime(), fromPlayback: false });
    }

    _setPixelsPerSecond(nextPps: number, redraw: boolean, anchorTime?: number, anchorPixel?: number) {
        const d         = this._d;
        const minPps    = Number(d.zoomSlider.min);
        const maxPps    = Number(d.zoomSlider.max);
        const sliderStep = Number(d.zoomSlider.step || 1);
        const vw        = this._getViewportWidth();
        const buf       = this._getAudioBuffer();
        const duration  = buf?.duration || 0;

        const clamped = clamp(nextPps, minPps, maxPps);
        const changed = Math.abs(clamped - this.pixelsPerSecond) >= 0.01;

        const fallbackTime = this._coords.scrollXToTime(this._getPrimaryScrollLeft() + vw / 2);
        const aTime  = anchorTime  ?? fallbackTime;
        const aPixel = anchorPixel ?? (vw / 2);

        const effectivePps = changed ? clamped : this.pixelsPerSecond;
        const estWidth  = duration ? Math.max(1, Math.floor(duration * effectivePps)) : 0;
        const maxScroll = Math.max(0, estWidth - vw);
        const nextScroll = duration ? aTime * effectivePps - aPixel : 0;
        const bounded   = clamp(nextScroll, 0, maxScroll);

        if (changed) {
            this.pixelsPerSecond    = effectivePps;
            d.zoomSlider.value      = String(Math.round(effectivePps / sliderStep) * sliderStep);
            d.zoomValue.textContent = `${Math.round(effectivePps)} px/s`;

            const ws = this._getWavesurfer();
            if (ws) ws.zoom(effectivePps);

            if (buf && redraw) {
                // Redraw BEFORE emitting zoomchange so coords are up-to-date
                // when listeners (e.g. label layers) receive the event.
                this._onRedrawNeeded();
                this._emitHost('zoomchange', { pixelsPerSecond: this.pixelsPerSecond });
                this.dispatchEvent(new CustomEvent('zoomchange', { detail: { pixelsPerSecond: this.pixelsPerSecond } }));
            } else {
                // Deferred — queue a redraw via RAF
                this._requestSpectrogramRedraw();
            }
        }

        this._setLinkedScrollLeft(bounded);
    }

    _requestSpectrogramRedraw() {
        if (this._zoomRedrawRafId) return;
        this._zoomRedrawRafId = requestAnimationFrame(() => {
            this._zoomRedrawRafId = 0;
            if (!this._getAudioBuffer()) return;
            this._onRedrawNeeded();
            this._emitHost('zoomchange', { pixelsPerSecond: this.pixelsPerSecond });
            this.dispatchEvent(new CustomEvent('zoomchange', { detail: { pixelsPerSecond: this.pixelsPerSecond } }));
        });
    }

    _syncOverviewWindowToViewport() {
        const buf = this._getAudioBuffer();
        if (!this._layout.showOverview || !buf) return;
        if (this._interaction.isOverviewDrag) return;

        const d = this._d;
        const trackWidth = Math.max(
            d.spectrogramCanvas?.width || 0,
            d.amplitudeCanvas?.width   || 0,
            Math.floor(this._coords.timeToScrollX(buf.duration)),
        );
        if (trackWidth <= 0) return;

        const vw        = this._getViewportWidth();
        const viewTime  = this._coords.scrollXToTime(vw);
        const startTime = this._coords.scrollXToTime(this._getPrimaryScrollLeft());
        const endTime   = Math.min(buf.duration, startTime + viewTime);

        const nextStartNorm = startTime / buf.duration;
        const nextEndNorm   = endTime   / buf.duration;
        const moved = Math.abs(nextStartNorm - this.windowStartNorm) > 1e-5
            || Math.abs(nextEndNorm - this.windowEndNorm) > 1e-5;

        this.windowStartNorm = nextStartNorm;
        this.windowEndNorm   = nextEndNorm;
        if (moved) this._updateOverviewWindowElement();

        // View-range display text
        const rangeChanged = Math.abs(startTime - this._lastViewRangeTextStart) > 0.05
            || Math.abs(endTime - this._lastViewRangeTextEnd) > 0.05;
        if (rangeChanged) {
            this._lastViewRangeTextStart = startTime;
            this._lastViewRangeTextEnd   = endTime;
            if (d.viewRangeDisplay) {
                d.viewRangeDisplay.textContent = `${formatSecondsShort(startTime)} – ${formatSecondsShort(endTime)}`;
            }
        }

        // Selection event (throttled)
        const now = performance.now();
        const selectionChanged = !Number.isFinite(this._lastSelectionStart)
            || Math.abs(startTime - this._lastSelectionStart) > 0.03
            || Math.abs(endTime   - this._lastSelectionEnd)   > 0.03;
        if (selectionChanged && (now - this._lastSelectionEmitAt >= 80)) {
            this._lastSelectionEmitAt = now;
            this._lastSelectionStart  = startTime;
            this._lastSelectionEnd    = endTime;
            this._emitHost('selection', { start: startTime, end: endTime });
            this.dispatchEvent(new CustomEvent('selection', { detail: { start: startTime, end: endTime } }));
        }
    }

    _updateOverviewWindowElement() {
        if (!this._layout.showOverview) return;
        const cw = this._d.overviewContainer?.clientWidth || 0;
        if (cw <= 0) return;
        const minW = 8;
        let left  = this.windowStartNorm * cw;
        let width = Math.max(minW, this.windowEndNorm * cw - left);
        if (left + width > cw) left = Math.max(0, cw - width);
        this._d.overviewWindow.style.left  = `${left}px`;
        this._d.overviewWindow.style.width = `${width}px`;
    }

    _getOverviewSpanConstraints() {
        const buf      = this._getAudioBuffer();
        const duration = Math.max(0.001, buf?.duration || 0.001);
        const vw       = Math.max(1, this._getViewportWidth());
        const d        = this._d;
        const minPps   = Math.max(1, Number(d.zoomSlider?.min || 20));
        const maxPps   = Math.max(minPps, Number(d.zoomSlider?.max || 450));
        const minSpanNorm = Math.max(MIN_WINDOW_NORM, (vw / maxPps) / duration);
        const maxSpanNorm = Math.min(1, (vw / minPps) / duration);
        return {
            minSpanNorm: Math.min(minSpanNorm, 1),
            maxSpanNorm: Math.max(minSpanNorm, maxSpanNorm),
        };
    }

    _startOverviewDrag(mode: 'move'|'left'|'right', clientX: number) {
        /** @type {Record<string, import('./interactionState.ts').InteractionMode>} */
        const modeMap = { move: 'overview-move', left: 'overview-resize-left', right: 'overview-resize-right' };
        if (!this._interaction.enter(modeMap[mode])) return;
        this._interaction.ctx.overviewStartX    = clientX;
        this._interaction.ctx.overviewStartNorm = this.windowStartNorm;
        this._interaction.ctx.overviewEndNorm   = this.windowEndNorm;
    }

    _updateOverviewDrag(clientX: number) {
        const sub = this._interaction.overviewSubMode;
        const buf = this._getAudioBuffer();
        if (!this._layout.showOverview || !buf || !sub) return;
        const ctx = this._interaction.ctx;
        if (Math.abs(clientX - ctx.overviewStartX) > 2) ctx.overviewMoved = true;

        const cw        = this._d.overviewContainer?.clientWidth || 1;
        const deltaNorm = (clientX - ctx.overviewStartX) / cw;
        const { minSpanNorm, maxSpanNorm } = this._getOverviewSpanConstraints();
        const fixedStart = ctx.overviewStartNorm;
        const fixedEnd   = ctx.overviewEndNorm;

        if (sub === 'move') {
            let s = fixedStart + deltaNorm;
            let e = fixedEnd   + deltaNorm;
            const span = e - s;
            if (s < 0) { s = 0; e = span; }
            if (e > 1) { e = 1; s = 1 - span; }
            this.windowStartNorm = s;
            this.windowEndNorm   = e;
        } else if (sub === 'left') {
            const nextStart = fixedStart + deltaNorm;
            const right     = fixedEnd;
            const minStart  = Math.max(0, right - maxSpanNorm);
            const maxStart  = Math.max(minStart, right - minSpanNorm);
            this.windowStartNorm = clamp(nextStart, minStart, maxStart);
            this.windowEndNorm   = right;
        } else if (sub === 'right') {
            const nextEnd  = fixedEnd + deltaNorm;
            const left     = fixedStart;
            const minEnd   = Math.min(1, left + minSpanNorm);
            const maxEnd   = Math.min(1, left + maxSpanNorm);
            this.windowEndNorm   = clamp(nextEnd, minEnd, maxEnd);
            this.windowStartNorm = left;
        }

        this._updateOverviewWindowElement();
        this._queueOverviewViewportApply(false);
    }

    _queueOverviewViewportApply(redrawFinal = false) {
        this._overviewNeedsFinalRedraw = this._overviewNeedsFinalRedraw || redrawFinal;
        if (this._overviewViewportRafId) return;
        this._overviewViewportRafId = requestAnimationFrame(() => {
            this._overviewViewportRafId = 0;
            const redraw = this._overviewNeedsFinalRedraw;
            this._overviewNeedsFinalRedraw = false;
            this._applyOverviewWindowToViewport(redraw);
            if (!redraw) {
                // Same-frame draw for smooth drag response
                this._onRedrawNeeded();
                this._emitHost('zoomchange', { pixelsPerSecond: this.pixelsPerSecond });
            }
        });
    }

    _applyOverviewWindowToViewport(redraw = true) {
        const buf = this._getAudioBuffer();
        if (!this._layout.showOverview || !buf) return;
        const dur      = buf.duration;
        const viewDur  = Math.max(0.01, (this.windowEndNorm - this.windowStartNorm) * dur);
        const targetPps = this._getViewportWidth() / viewDur;
        this._setPixelsPerSecond(targetPps, redraw, this.windowStartNorm * dur, 0);
    }

    _cancelFollowCatchupAnimation() {
        if (this._followCatchupRafId) {
            cancelAnimationFrame(this._followCatchupRafId);
            this._followCatchupRafId = 0;
        }
        this._followCatchupAnim = null;
    }

    _animateFollowCatchupTo(targetScrollLeft: number) {
        const buf = this._getAudioBuffer();
        if (!buf) return;
        const vw  = this._getViewportWidth();
        const tw  = Math.max(1, Math.floor(this._coords.timeToScrollX(buf.duration)));
        const maxScroll = Math.max(0, tw - vw);
        const target    = clamp(targetScrollLeft, 0, maxScroll);
        const start     = this._getPrimaryScrollLeft();
        const delta     = target - start;
        if (Math.abs(delta) < 1) return;

        const now = performance.now();
        const inSeekFocus = now < this._smoothSeekFocusUntil;
        const duration = inSeekFocus
            ? this._cfg.followCatchupSeekDurationMs
            : this._cfg.followCatchupDurationMs;

        if (this._followCatchupAnim) {
            if (Math.abs(this._followCatchupAnim.target - target) < 6) return;
        }

        this._cancelFollowCatchupAnimation();
        this._followCatchupAnim = { start, target, startedAt: now, duration };
        const easeOutCubic = (t: number) => 1 - ((1 - t) ** 3);

        const tick = (ts: number) => {
            const anim = this._followCatchupAnim;
            if (!anim) return;
            const t     = clamp((ts - anim.startedAt) / Math.max(1, anim.duration), 0, 1);
            const eased = easeOutCubic(t);
            const next  = anim.start + (anim.target - anim.start) * eased;
            this._setLinkedScrollLeft(next);
            if (t >= 1) { this._cancelFollowCatchupAnimation(); return; }
            this._followCatchupRafId = requestAnimationFrame(tick);
        };
        this._followCatchupRafId = requestAnimationFrame(tick);
    }

    _applySmoothFollow(position: number, viewportWidth?: number) {
        const buf = this._getAudioBuffer();
        if (!buf) return;
        const vw         = Math.max(1, viewportWidth || this._getViewportWidth());
        const totalWidth = Math.max(1, Math.floor(this._coords.timeToScrollX(buf.duration)));
        const maxScroll  = Math.max(0, totalWidth - vw);
        const target     = clamp(position - vw * this._cfg.followTargetRatio, 0, maxScroll);
        const current    = this._getPrimaryScrollLeft();
        const delta      = target - current;
        if (Math.abs(delta) < 0.6) return;
        const inSeekFocus = performance.now() < this._smoothSeekFocusUntil;
        const lerp     = inSeekFocus ? this._cfg.smoothSeekLerp    : this._cfg.smoothLerp;
        const minStep  = inSeekFocus
            ? vw * this._cfg.smoothSeekMinStepRatio
            : vw * this._cfg.smoothMinStepRatio;
        const step = Math.sign(delta) * Math.min(
            Math.abs(delta),
            Math.max(minStep, Math.abs(delta) * lerp, 1),
        );
        this._setLinkedScrollLeft(current + step);
    }

    // ── Internal helpers ─────────────────────────────────────────────

    _getCurrentTime() {
        return this._getWavesurfer()?.getCurrentTime?.() ?? 0;
    }
}
