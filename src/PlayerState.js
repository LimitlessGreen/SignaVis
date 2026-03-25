// ═══════════════════════════════════════════════════════════════════════
// PlayerState.js — Central state machine, interaction & event binding
// ═══════════════════════════════════════════════════════════════════════

import {
    DEFAULT_ZOOM_PPS,
    DEFAULT_WAVEFORM_HEIGHT, DEFAULT_SPECTROGRAM_DISPLAY_HEIGHT,
    MIN_WAVEFORM_HEIGHT, MIN_SPECTROGRAM_DISPLAY_HEIGHT,
    SEEK_FINE_SEC, SEEK_COARSE_SEC, MIN_WINDOW_NORM,
    PROGRESSIVE_CHUNK_SECONDS, PROGRESSIVE_MIN_DURATION_SEC,
    PERCH_FRAME_RATE,
    SPECTROGRAM_HEIGHT,
    DSP_PROFILES,
} from './constants.js';

import { formatTime, formatSecondsShort, isTypingContext } from './utils.js';
import { GestureRecognizer } from './gestures.js';
import { TRANSPORT_STATE_LABELS, canTransitionTransportState } from './transportState.js';
import { InteractionState } from './interactionState.js';
import { CoordinateSystem } from './coordinateSystem.js';

import {
    computeAmplitudePeak,
    updateSpectrogramStats as computeSpectrogramStats,
    autoContrastStats,
    detectMaxFrequency,
    buildSpectrogramGrayscale,
    colorizeSpectrogram,
    GpuColorizer,
    renderSpectrogram,
    createSpectrogramProcessor,
} from './spectrogram.js';

import {
    renderMainWaveform,
    renderOverviewWaveform,
    renderFrequencyLabels,
} from './waveform.js';

/**
 * @typedef {Object} PlayerOptions
 * @property {string}  [viewMode]
 * @property {boolean} [showOverview]
 * @property {boolean} [transportOverlay]
 * @property {string}  [compactToolbar]
 * @property {boolean} [showWaveformTimeline]
 * @property {boolean} [enableTouchGestures]
 * @property {boolean} [enablePerfOverlay]
 * @property {number}  [followGuardLeftRatio]
 * @property {number}  [followGuardRightRatio]
 * @property {number}  [followTargetRatio]
 * @property {number}  [followCatchupDurationMs]
 * @property {number}  [followCatchupSeekDurationMs]
 * @property {number}  [smoothLerp]
 * @property {number}  [smoothSeekLerp]
 * @property {number}  [smoothMinStepRatio]
 * @property {number}  [smoothSeekMinStepRatio]
 * @property {number}  [smoothSeekFocusMs]
 * @property {boolean} [enableProgressiveSpectrogram]
 */

// ─── Helper ─────────────────────────────────────────────────────────

async function decodeArrayBuffer(arrayBuffer) {
    const Ctor = window.AudioContext || /** @type {any} */ (window).webkitAudioContext;
    if (!Ctor) throw new Error('AudioContext wird von diesem Browser nicht unterstützt.');
    const ctx = new Ctor();
    try {
        return await ctx.decodeAudioData(arrayBuffer);
    } finally {
        ctx.close?.().catch(() => {});
    }
}

/**
 * @param {*} value
 * @param {number} min
 * @param {number} max
 * @param {number} fallback
 * @returns {number}
 */
function clampNumber(value, min, max, fallback) {
    const n = Number(value);
    if (!Number.isFinite(n)) return fallback;
    return Math.max(min, Math.min(max, n));
}

// ═════════════════════════════════════════════════════════════════════

export class PlayerState {
    /**
     * @param {HTMLElement} container
     * @param {any} WaveSurfer
     * @param {((event: string, detail: any) => void) | null} [emitHostEvent]
     * @param {PlayerOptions} [options]
     */
    constructor(container, WaveSurfer, emitHostEvent = null, options = {}) {
        if (!container) throw new Error('PlayerState: container element required');
        if (!WaveSurfer) throw new Error('PlayerState: WaveSurfer reference required');

        this.container = container;
        this.d = this._queryDom(container);
        this.WaveSurfer = WaveSurfer;
        this._emitHostEvent = typeof emitHostEvent === 'function' ? emitHostEvent : null;
        this.options = options || {};
        this._viewMode = this.options.viewMode === 'waveform' || this.options.viewMode === 'spectrogram'
            ? this.options.viewMode
            : 'both';
        this._showWaveform = this._viewMode !== 'spectrogram';
        this._showSpectrogram = this._viewMode !== 'waveform';
        this._showOverview = this.options.showOverview !== false;
        this._transportOverlay = this.options.transportOverlay === true;
        this._compactToolbarMode = this.options.compactToolbar && ['auto', 'on', 'off'].includes(this.options.compactToolbar)
            ? this.options.compactToolbar
            : 'auto';
        this._compactToolbarOpen = false;
        this._settingsPanelOpen = false;
        this._compactToolbarLayoutRaf = 0;
        this._showWaveformTimeline = this.options.showWaveformTimeline !== false
            && !(this.options.transportOverlay && this._viewMode === 'waveform');
        this._playbackViewportConfig = this._sanitizePlaybackViewportConfig(this.options || {});

        this.processor = createSpectrogramProcessor();
        this.colorizer = new GpuColorizer();

        // ── Audio / analysis state ──
        this.audioBuffer = null;
        this.wavesurfer = null;
        this.spectrogramData = null;
        this.spectrogramFrames = 0;
        this.spectrogramMels = 0;
        this.spectrogramBaseCanvas = null;
        this.spectrogramGrayInfo = null;  // { gray: Uint8Array, width, height }
        this._gpuReady = false;
        this.spectrogramAbsLogMin = 0;   // absolute range (full data)
        this.spectrogramAbsLogMax = 1;
        this.sampleRateHz = 32000;
        this._externalSpectrogram = false; // true when externally-injected data/image
        this.amplitudePeakAbs = 1;
        this.currentColorScheme = this.d.colorSchemeSelect.value || 'grayscale';
        this.volume = 0.8;
        this.muted = false;
        this.preMuteVolume = 0.8;

        // ── Zoom / viewport ──
        this.pixelsPerSecond = DEFAULT_ZOOM_PPS;
        this._zoomRedrawRafId = 0;
        this.scrollSyncLock = false;
        this.windowStartNorm = 0;
        this.windowEndNorm = 1;

        // ── Playback toggles ──
        this.followMode = 'follow'; // 'free' | 'follow' | 'smooth'
        this.followPlayback = true;
        this.loopPlayback = false;
        this.playbackMode = 'normal'; // 'normal' | 'segment'
        this.transportState = '';
        this._activeSegmentLabelId = null;
        this._activeSegmentFilter = null;
        this._activeSegmentStart = null;
        this._activeSegmentEnd = null;
        this._suppressNextPauseHandler = false;
        this._segmentPlayToken = 0;
        this._customSegmentPlayback = null;
        this._smoothSeekFocusUntil = 0;
        this._lastTimeupdateEmitAt = 0;
        this._lastSelectionEmitAt = 0;
        this._lastSelectionStart = NaN;
        this._lastSelectionEnd = NaN;
        this._lastViewRangeTextStart = NaN;
        this._lastViewRangeTextEnd = NaN;
        this._lastTimeReadoutText = '';
        this._uiFrameId = 0;
        this._uiPending = null;
        this._followCatchupRafId = 0;
        this._followCatchupAnim = null;
        this._perf = {
            enabled: false,
            /** @type {HTMLDivElement | null} */
            panel: null,
            intervalId: 0,
            frames: 0,
            fps: 0,
            lastFrameTs: 0,
            longFrames: 0,
            maxFrameMs: 0,
            uiFlushes: 0,
            timeupdateEvents: 0,
            selectionEvents: 0,
            seekEvents: 0,
            transitionEvents: 0,
            blockedTransitions: 0,
            lastTransition: '',
        };

        // ── Interaction FSM (replaces ~15 loose boolean/string flags) ──
        this.interaction = new InteractionState();
        this._overviewViewportRafId = 0;
        this._overviewNeedsFinalRedraw = false;

        // ── Coordinate system (single source of truth) ──
        this.coords = new CoordinateSystem();

        // ── Crosshair ──
        this._crosshairEnabled = false;
        this._crosshairRafId = 0;

        // ── View layout (persistent, not interaction-mode) ──
        this.waveformDisplayHeight = DEFAULT_WAVEFORM_HEIGHT;
        this.spectrogramDisplayHeight = DEFAULT_SPECTROGRAM_DISPLAY_HEIGHT;
        this._viewResizeFrameId = 0;
        this._viewResizeNeedsWaveformRedraw = false;
        this._viewResizeNeedsSpectrogramRedraw = false;

        // ── Initial DOM setup ──
        this._applyLocalViewHeights();
        this._updateAmplitudeLabels();
        this._setInitialPlayheadPositions();
        this._updateToggleButtons();
        this._updateAriaPlaybackPosition(0);
        this._setCompactToolbarOpen(false);
        this._setTransportState('idle', 'init');
        this._initPerfOverlay();

        // ── Event listeners ──
        this._cleanups = [];
        this._bindEvents();
        if (this.options.enableTouchGestures !== false) {
            this._bindTouchGestures();
        }
        this._refreshCompactToolbarLayout();
        this._updatePcenSectionVisibility();
        requestAnimationFrame(() => this._refreshCompactToolbarLayout());
    }

    _emit(event, detail = {}) {
        if (!this._emitHostEvent) return;
        this._emitHostEvent(event, detail);
    }

    _sanitizePlaybackViewportConfig(partial = {}) {
        const cfg = this._playbackViewportConfig || {};
        return {
            followGuardLeftRatio: clampNumber(partial.followGuardLeftRatio, 0.05, 0.95, cfg.followGuardLeftRatio ?? 0.35),
            followGuardRightRatio: clampNumber(partial.followGuardRightRatio, 0.05, 0.95, cfg.followGuardRightRatio ?? 0.65),
            followTargetRatio: clampNumber(partial.followTargetRatio, 0.1, 0.9, cfg.followTargetRatio ?? 0.5),
            followCatchupDurationMs: clampNumber(partial.followCatchupDurationMs, 80, 2500, cfg.followCatchupDurationMs ?? 240),
            followCatchupSeekDurationMs: clampNumber(partial.followCatchupSeekDurationMs, 100, 3000, cfg.followCatchupSeekDurationMs ?? 360),
            smoothLerp: clampNumber(partial.smoothLerp, 0.02, 0.95, cfg.smoothLerp ?? 0.18),
            smoothSeekLerp: clampNumber(partial.smoothSeekLerp, 0.01, 0.9, cfg.smoothSeekLerp ?? 0.08),
            smoothMinStepRatio: clampNumber(partial.smoothMinStepRatio, 0.001, 0.25, cfg.smoothMinStepRatio ?? 0.03),
            smoothSeekMinStepRatio: clampNumber(partial.smoothSeekMinStepRatio, 0.001, 0.2, cfg.smoothSeekMinStepRatio ?? 0.008),
            smoothSeekFocusMs: clampNumber(partial.smoothSeekFocusMs, 150, 5000, cfg.smoothSeekFocusMs ?? 1400),
        };
    }

    updatePlaybackViewportConfig(partial = {}) {
        this._playbackViewportConfig = this._sanitizePlaybackViewportConfig(partial);
        if (this._playbackViewportConfig.followGuardLeftRatio >= this._playbackViewportConfig.followGuardRightRatio) {
            this._playbackViewportConfig.followGuardLeftRatio = 0.35;
            this._playbackViewportConfig.followGuardRightRatio = 0.65;
        }
        this._emit('followconfigchange', { ...this._playbackViewportConfig });
        return { ...this._playbackViewportConfig };
    }

    getPlaybackViewportConfig() {
        return { ...this._playbackViewportConfig };
    }

    _initPerfOverlay() {
        const byOption = this.options?.enablePerfOverlay === true;
        let byQuery = false;
        try {
            const params = new URLSearchParams(window.location.search || '');
            byQuery = params.get('perf') === '1';
        } catch {
            byQuery = false;
        }
        if (!byOption && !byQuery) return;
        this._perf.enabled = true;

        const panel = document.createElement('div');
        panel.className = 'abp-perf-overlay';
        // Hard-pin overlay position so special layout modes cannot shift it.
        panel.style.position = 'absolute';
        panel.style.top = '8px';
        panel.style.right = '8px';
        panel.style.left = 'auto';
        panel.style.bottom = 'auto';
        panel.style.transform = 'none';
        panel.style.zIndex = '60';
        panel.innerHTML = `
            <div class="abp-perf-title">PERF</div>
            <div class="abp-perf-body">Initializing...</div>
        `;
        this.container.appendChild(panel);
        this._perf.panel = panel;

        this._perf.intervalId = window.setInterval(() => {
            this._renderPerfOverlay();
        }, 500);
    }

    _perfOnFrame(ts) {
        if (!this._perf.enabled) return;
        this._perf.frames += 1;
        if (this._perf.lastFrameTs > 0) {
            const frameMs = ts - this._perf.lastFrameTs;
            if (frameMs > 0) {
                const fps = 1000 / frameMs;
                this._perf.fps = this._perf.fps <= 0 ? fps : (this._perf.fps * 0.85 + fps * 0.15);
            }
            this._perf.maxFrameMs = Math.max(this._perf.maxFrameMs, frameMs);
            if (frameMs > 32) this._perf.longFrames += 1;
        }
        this._perf.lastFrameTs = ts;
    }

    _renderPerfOverlay() {
        if (!this._perf.enabled || !this._perf.panel) return;
        const body = this._perf.panel.querySelector('.abp-perf-body');
        if (!body) return;
        body.innerHTML = [
            `state: ${this.transportState || 'n/a'}`,
            `fps: ${this._perf.fps.toFixed(1)} | long>${32}ms: ${this._perf.longFrames}`,
            `max frame: ${this._perf.maxFrameMs.toFixed(1)}ms | ui flushes: ${this._perf.uiFlushes}`,
            `timeupdate: ${this._perf.timeupdateEvents} | selection: ${this._perf.selectionEvents} | seek: ${this._perf.seekEvents}`,
            `transitions: ${this._perf.transitionEvents} | blocked: ${this._perf.blockedTransitions}`,
            `last: ${this._perf.lastTransition || '-'}`,
        ].join('<br>');

        // Show rates over each reporting window.
        this._perf.uiFlushes = 0;
        this._perf.timeupdateEvents = 0;
        this._perf.selectionEvents = 0;
        this._perf.seekEvents = 0;
        this._perf.maxFrameMs = 0;
    }

    _setTransportState(nextState, reason = '') {
        if (!nextState || this.transportState === nextState) return;
        const fromState = this.transportState || '';
        if (!canTransitionTransportState(fromState, nextState)) {
            this._perf.blockedTransitions += 1;
            this._emit('transporttransitionblocked', { from: fromState, to: nextState, reason });
        }
        this.transportState = nextState;
        this._perf.transitionEvents += 1;
        this._perf.lastTransition = `${fromState || '∅'} → ${nextState}${reason ? ` (${reason})` : ''}`;
        this._setPlayState(TRANSPORT_STATE_LABELS[nextState] || nextState);
        this._emit('transportstatechange', { state: nextState, reason });
    }

    _scheduleUiUpdate({
        time = this._getCurrentTime(),
        fromPlayback = false,
        centerView = false,
        emitSeek = false,
        immediate = false,
    } = {}) {
        this._uiPending = this._uiPending || {
            time: 0,
            fromPlayback: false,
            centerView: false,
            emitSeek: false,
        };
        this._uiPending.time = time;
        this._uiPending.fromPlayback = fromPlayback;
        this._uiPending.centerView = this._uiPending.centerView || centerView;
        this._uiPending.emitSeek = this._uiPending.emitSeek || emitSeek;

        if (immediate) {
            if (this._uiFrameId) {
                cancelAnimationFrame(this._uiFrameId);
                this._uiFrameId = 0;
            }
            this._flushUiUpdate(performance.now());
            return;
        }
        if (this._uiFrameId) return;
        this._uiFrameId = requestAnimationFrame((ts) => this._flushUiUpdate(ts));
    }

    _flushUiUpdate(_ts) {
        this._uiFrameId = 0;
        const pending = this._uiPending;
        this._uiPending = null;
        if (!pending || !this.audioBuffer) return;
        this._perfOnFrame(_ts);
        this._perf.uiFlushes += 1;

        const duration = Math.max(0, this.audioBuffer.duration || 0);
        const t = Math.max(0, Math.min(pending.time || 0, duration || pending.time || 0));
        this._updateTimeReadout(t);
        this._updatePlayhead(t, pending.fromPlayback);
        if (pending.centerView) this._centerViewportAtTime(t);
        if (pending.emitSeek) {
            this._perf.seekEvents += 1;
            this._emit('seek', {
                currentTime: t,
                duration: this.audioBuffer?.duration || 0,
            });
        }
    }

    // ═════════════════════════════════════════════════════════════════
    //  DOM Query (scoped to container)
    // ═════════════════════════════════════════════════════════════════

    _queryDom(root) {
        const q = (id) => root.querySelector(`[data-aw="${id}"]`);
        return {
            openFileBtn:            q('openFileBtn'),
            toolbarRoot:            q('toolbarRoot'),
            compactMoreBtn:         q('compactMoreBtn'),
            toolbarSecondary:       q('toolbarSecondary'),
            audioFile:              q('audioFile'),
            playPauseBtn:           q('playPauseBtn'),
            stopBtn:                q('stopBtn'),
            jumpStartBtn:           q('jumpStartBtn'),
            jumpEndBtn:             q('jumpEndBtn'),
            backwardBtn:            q('backwardBtn'),
            forwardBtn:             q('forwardBtn'),
            followToggleBtn:        q('followToggleBtn'),
            loopToggleBtn:          q('loopToggleBtn'),
            fitViewBtn:             q('fitViewBtn'),
            resetViewBtn:           q('resetViewBtn'),
            currentTimeDisplay:     q('currentTime'),
            totalTimeDisplay:       q('totalTime'),
            playStateDisplay:       q('playState'),
            viewRangeDisplay:       q('viewRange'),
            spectrogramCanvas:      q('spectrogramCanvas'),
            spectrogramContainer:   q('spectrogramContainer'),
            waveformContainer:      q('waveformContainer'),
            waveformWrapper:        q('waveformWrapper'),
            waveformContent:        q('waveformContent'),
            amplitudeLabels:        q('amplitudeLabels'),
            amplitudeCanvas:        q('amplitudeCanvas'),
            waveformTimelineCanvas: q('waveformTimelineCanvas'),
            waveformPlayhead:       q('waveformPlayhead'),
            audioEngineHost:        q('audioEngineHost'),
            playhead:               q('playhead'),
            canvasWrapper:          q('canvasWrapper'),
            viewSplitHandle:        q('viewSplitHandle'),
            spectrogramResizeHandle:q('spectrogramResizeHandle'),
            overviewCanvas:         q('overviewCanvas'),
            overviewContainer:      q('overviewContainer'),
            overviewWindow:         q('overviewWindow'),
            overviewHandleLeft:     q('overviewHandleLeft'),
            overviewHandleRight:    q('overviewHandleRight'),
            fileInfo:               q('fileInfo'),
            sampleRateInfo:         q('sampleRateInfo'),
            scaleSelect:            q('scaleSelect'),
            presetPerchBtn:         q('presetPerchBtn'),
            presetClassicBtn:       q('presetClassicBtn'),
            nMelsInput:             q('nMelsInput'),
            pcenGainInput:          q('pcenGainInput'),
            pcenBiasInput:          q('pcenBiasInput'),
            pcenRootInput:          q('pcenRootInput'),
            pcenSmoothingInput:     q('pcenSmoothingInput'),
            pcenSection:            q('pcenSection'),
            fftSizeSelect:          q('fftSize'),
            windowFunctionSelect:   q('windowFunction'),
            windowSizeSelect:       q('windowSize'),
            hopSizeSelect:          q('hopSize'),
            zoomSlider:             q('zoomSlider'),
            zoomValue:              q('zoomValue'),
            maxFreqSelect:          q('maxFreqSelect'),
            colorSchemeSelect:      q('colorSchemeSelect'),
            freqLabels:             q('freqLabels'),
            volumeToggleBtn:        q('volumeToggleBtn'),
            volumeIcon:             q('volumeIcon'),
            volumeWaves:            q('volumeWaves'),
            volumeSlider:           q('volumeSlider'),
            floorSlider:            q('floorSlider'),
            ceilSlider:             q('ceilSlider'),
            autoContrastBtn:        q('autoContrastBtn'),
            autoFreqBtn:            q('autoFreqBtn'),
            crosshairToggleBtn:     q('crosshairToggleBtn'),
            crosshairCanvas:        q('crosshairCanvas'),
            crosshairReadout:       q('crosshairReadout'),
            settingsToggleBtn:      q('settingsToggleBtn'),
            settingsPanel:          q('settingsPanel'),
            settingsPanelClose:     q('settingsPanelClose'),
        };
    }

    // ═════════════════════════════════════════════════════════════════
    //  Disposal
    // ═════════════════════════════════════════════════════════════════

    dispose() {
        this._stopCustomSegmentPlayback('stopped', this._getCurrentTime());
        this._cancelFollowCatchupAnimation();
        this._hideCrosshair();
        if (this._viewResizeFrameId) {
            cancelAnimationFrame(this._viewResizeFrameId);
            this._viewResizeFrameId = 0;
        }
        if (this._uiFrameId) {
            cancelAnimationFrame(this._uiFrameId);
            this._uiFrameId = 0;
        }
        if (this._zoomRedrawRafId) {
            cancelAnimationFrame(this._zoomRedrawRafId);
            this._zoomRedrawRafId = 0;
        }
        if (this._overviewViewportRafId) {
            cancelAnimationFrame(this._overviewViewportRafId);
            this._overviewViewportRafId = 0;
        }
        if (this._compactToolbarLayoutRaf) {
            cancelAnimationFrame(this._compactToolbarLayoutRaf);
            this._compactToolbarLayoutRaf = 0;
        }
        if (this._perf.intervalId) {
            clearInterval(this._perf.intervalId);
            this._perf.intervalId = 0;
        }
        if (this._perf.panel?.parentNode) {
            this._perf.panel.parentNode.removeChild(this._perf.panel);
            this._perf.panel = null;
        }
        for (let i = this._cleanups.length - 1; i >= 0; i--) this._cleanups[i]();
        this._cleanups.length = 0;
        this.processor.dispose();
        this.colorizer.dispose();
    }

    // ═════════════════════════════════════════════════════════════════
    //  File Loading
    // ═════════════════════════════════════════════════════════════════

    async _handleFileSelect(e) {
        const file = e?.target?.files?.[0];
        if (!file) return;

        this.d.fileInfo.innerHTML = `<span class="statusbar-label">${file.name}</span>`;
        this.d.fileInfo.classList.add('loading');
        this._setTransportState('loading', 'file-load');

        try {
            const fileBuffer = await file.arrayBuffer();
            const audioBuffer = await decodeArrayBuffer(fileBuffer);
            this.audioBuffer = audioBuffer;
            this.sampleRateHz = audioBuffer.sampleRate;
            this.amplitudePeakAbs = computeAmplitudePeak(audioBuffer.getChannelData(0));
            this._updateAmplitudeLabels();

            this.d.fileInfo.innerHTML = `<span class="statusbar-label">${file.name}</span> <span>${formatTime(audioBuffer.duration)}</span>`;
            this.d.sampleRateInfo.textContent = `${audioBuffer.sampleRate} Hz`;
            this.d.totalTimeDisplay.textContent = formatTime(audioBuffer.duration);
            this.d.currentTimeDisplay.textContent = formatTime(0);

            this._setPixelsPerSecond(DEFAULT_ZOOM_PPS, false);
            this._setTransportEnabled(true);
            this._updateToggleButtons();
            this._setTransportState('ready', 'file-loaded');
            this.d.fileInfo.classList.remove('loading');

            this._setupWaveSurfer(file);
            await this._generateSpectrogram();
            this._drawMainWaveform();
            this._drawOverviewWaveform();
            this._createFrequencyLabels();
            this._seekToTime(0, true);
        } catch (error) {
            console.error('Fehler beim Laden der Datei:', error);
            this._setTransportState('error', 'file-load-failed');
            this.d.fileInfo.classList.remove('loading');
            this._emit('error', { message: error?.message || String(error), source: 'file' });
            alert('Fehler beim Laden der Audio-Datei');
        }
    }

    // ═════════════════════════════════════════════════════════════════
    //  Load from URL (programmatic)
    // ═════════════════════════════════════════════════════════════════

    async loadUrl(url) {
        this.d.fileInfo.innerHTML = `<span class="statusbar-label">Loading…</span>`;
        this.d.fileInfo.classList.add('loading');
        this._setTransportState('loading', 'url-load');

        try {
            const response = await fetch(url);
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            const arrayBuffer = await response.arrayBuffer();

            const audioBuffer = await decodeArrayBuffer(arrayBuffer);
            this.audioBuffer = audioBuffer;
            this.sampleRateHz = audioBuffer.sampleRate;
            this.amplitudePeakAbs = computeAmplitudePeak(audioBuffer.getChannelData(0));
            this._updateAmplitudeLabels();

            const name = decodeURIComponent(
                new URL(url, location.href).pathname.split('/').pop() || 'audio',
            );
            this.d.fileInfo.innerHTML = `<span class="statusbar-label">${name}</span> <span>${formatTime(audioBuffer.duration)}</span>`;
            this.d.sampleRateInfo.textContent = `${audioBuffer.sampleRate} Hz`;
            this.d.totalTimeDisplay.textContent = formatTime(audioBuffer.duration);
            this.d.currentTimeDisplay.textContent = formatTime(0);

            this._setPixelsPerSecond(DEFAULT_ZOOM_PPS, false);
            this._setTransportEnabled(true);
            this._updateToggleButtons();
            this._setTransportState('ready', 'url-loaded');
            this.d.fileInfo.classList.remove('loading');

            // Pass the original URL to WaveSurfer (data: URLs work in
            // sandboxed iframes where blob: URLs fail).
            this._setupWaveSurfer(url);
            await this._generateSpectrogram();
            this._drawMainWaveform();
            this._drawOverviewWaveform();
            this._createFrequencyLabels();
            this._seekToTime(0, true);
        } catch (error) {
            console.error('Error loading audio URL:', error);
            this._setTransportState('error', 'url-load-failed');
            this.d.fileInfo.classList.remove('loading');
            this._emit('error', { message: error?.message || String(error), source: 'url' });
        }
    }

    // ═════════════════════════════════════════════════════════════════
    //  WaveSurfer Engine
    // ═════════════════════════════════════════════════════════════════

    _setupWaveSurfer(source) {
        if (this.wavesurfer) this.wavesurfer.destroy();

        const ws = this.WaveSurfer.create({
            container: this.d.audioEngineHost,
            height: 1,
            waveColor: '#38bdf8',
            progressColor: '#0ea5e9',
            cursorColor: '#ef4444',
            normalize: true,
            minPxPerSec: this.pixelsPerSecond,
            autoScroll: false,
            autoCenter: false,
        });

        // Accept both URL strings (data:, http:, blob:) and File/Blob objects
        if (typeof source === 'string') {
            ws.load(source);
        } else {
            ws.loadBlob(source);
        }

        ws.on('ready', () => {
            ws.zoom(this.pixelsPerSecond);
            ws.setVolume(this.volume);
            this._seekToTime(0, true);
            this._lastTimeupdateEmitAt = 0;
            this._lastSelectionEmitAt = 0;
            this._lastSelectionStart = NaN;
            this._lastSelectionEnd = NaN;
        });

        ws.on('timeupdate', (t) => {
            this._perf.timeupdateEvents += 1;
            this._scheduleUiUpdate({ time: t, fromPlayback: true });
            const now = performance.now();
            if (now - this._lastTimeupdateEmitAt >= 66) {
                this._lastTimeupdateEmitAt = now;
                this._emit('timeupdate', {
                    currentTime: t,
                    duration: this.audioBuffer?.duration || 0,
                });
            }
        });

        ws.on('play', () => {
            this.d.playPauseBtn.classList.add('playing');
            if (this.playbackMode === 'segment') {
                this._setTransportState('playing_segment', 'engine-play');
                return;
            }
            this._setTransportState(this.loopPlayback ? 'playing_loop' : 'playing', 'engine-play');
        });

        ws.on('pause', () => {
            if (this._suppressNextPauseHandler) {
                this._suppressNextPauseHandler = false;
                return;
            }
            this.d.playPauseBtn.classList.remove('playing');
            if (this.playbackMode === 'segment' && this._activeSegmentEnd != null) {
                this._setTransportState('paused_segment', 'engine-pause');
            } else if (this.audioBuffer) {
                const atEnd = ws.getCurrentTime() >= this.audioBuffer.duration - 0.01;
                this._setTransportState(atEnd ? 'stopped' : 'paused', 'engine-pause');
            } else {
                this._setTransportState('paused', 'engine-pause');
            }
        });

        ws.on('finish', () => {
            if (this.playbackMode === 'segment') {
                this.playbackMode = 'normal';
                this._activeSegmentLabelId = null;
                this._activeSegmentFilter = null;
                this._activeSegmentStart = null;
                this._activeSegmentEnd = null;
                this._segmentPlayToken++;
            }
            if (this.loopPlayback) {
                this._seekToTime(0, this.followPlayback);
                ws.play();
                return;
            }
            this.d.playPauseBtn.classList.remove('playing');
            this._setTransportState('stopped', 'engine-finish');
            if (this.audioBuffer) this._scheduleUiUpdate({ time: this.audioBuffer.duration, fromPlayback: false, immediate: true });
        });

        this.wavesurfer = ws;
    }

    // ═════════════════════════════════════════════════════════════════
    //  Transport Controls
    // ═════════════════════════════════════════════════════════════════

    _togglePlayPause() {
        if (this._customSegmentPlayback) {
            this._stopCustomSegmentPlayback('paused', this._customSegmentPlayback.currentTimeSec);
            return;
        }
        this.playbackMode = 'normal';
        this._activeSegmentLabelId = null;
        this._activeSegmentFilter = null;
        this._activeSegmentStart = null;
        this._activeSegmentEnd = null;
        this._segmentPlayToken++;
        if (this.wavesurfer && this.audioBuffer) this.wavesurfer.playPause();
    }

    _stopPlayback() {
        if (this._customSegmentPlayback) {
            this._stopCustomSegmentPlayback('stopped', 0);
        }
        if (!this.wavesurfer) return;
        this.playbackMode = 'normal';
        this._activeSegmentLabelId = null;
        this._activeSegmentFilter = null;
        this._activeSegmentStart = null;
        this._activeSegmentEnd = null;
        this._segmentPlayToken++;
        this.wavesurfer.pause();
        this._seekToTime(0, true);
        this._setTransportState('stopped', 'stop-control');
        this.d.playPauseBtn.classList.remove('playing');
    }

    playSegment(startSec, endSec, options = {}) {
        if (!this.audioBuffer || !this.wavesurfer) return;
        this._clearPlaybackFilter();
        const dur = this.audioBuffer.duration;
        const start = Math.max(0, Math.min(startSec, dur));
        const end = Math.max(0, Math.min(endSec, dur));
        if (end - start < 0.01) return;
        const token = ++this._segmentPlayToken;
        this.playbackMode = 'segment';
        this._activeSegmentLabelId = options?.labelId || null;
        this._activeSegmentFilter = null;
        this._activeSegmentStart = start;
        this._activeSegmentEnd = end;
        if (this.wavesurfer.isPlaying()) {
            this._suppressNextPauseHandler = true;
            this.wavesurfer.pause();
        }
        this._seekToTime(start, false);
        if (token !== this._segmentPlayToken) return;

        const runPlay = () => {
            if (token !== this._segmentPlayToken) return;
            try {
                if (this.loopPlayback) {
                    this._seekToTime(start, false, { allowCustomPlayback: true });
                    this.wavesurfer.play();
                    this._emit('segmentplaystart', { start, end, loop: true });
                    return;
                }
                // Prefer native segment playback if available in this WaveSurfer build.
                const maybePromise = this.wavesurfer.play(start, end);
                this._emit('segmentplaystart', { start, end });
                if (maybePromise && typeof maybePromise.then === 'function') {
                    maybePromise.catch(() => {
                        if (token !== this._segmentPlayToken) return;
                        this._seekToTime(start, false);
                        this.wavesurfer?.play();
                    });
                }
            } catch {
                if (token !== this._segmentPlayToken) return;
                this._seekToTime(start, false);
                this.wavesurfer?.play();
                this._emit('segmentplaystart', { start, end });
            }
        };

        try {
            // One frame delay prevents play/pause races after click+drag interactions.
            window.requestAnimationFrame(runPlay);
        } catch {
            runPlay();
        }
    }

    playBandpassedSegment(startSec, endSec, freqMinHz, freqMaxHz, options = {}) {
        if (!this.audioBuffer) return;
        const dur = this.audioBuffer.duration;
        const start = Math.max(0, Math.min(startSec, dur));
        const end = Math.max(0, Math.min(endSec, dur));
        if (end - start < 0.01) return;
        const nyquist = Math.max(100, this.audioBuffer.sampleRate * 0.5 - 10);
        const fLo = Math.max(20, Math.min(freqMinHz, freqMaxHz, nyquist - 5));
        const fHi = Math.max(fLo + 5, Math.min(Math.max(freqMinHz, freqMaxHz), nyquist));
        const center = Math.sqrt(fLo * fHi);
        const bandwidth = Math.max(10, fHi - fLo);
        const q = Math.max(0.25, Math.min(40, center / bandwidth));

        this._stopCustomSegmentPlayback('stopped', start);
        this._clearPlaybackFilter();

        if (this.wavesurfer?.isPlaying()) {
            this._suppressNextPauseHandler = true;
            this.wavesurfer.pause();
        }
        this._seekToTime(start, false, { allowCustomPlayback: true });

        const Ctor = window.AudioContext || /** @type {any} */ (window).webkitAudioContext;
        if (!Ctor) {
            this.playSegment(start, end, { labelId: options?.labelId });
            return;
        }

        const token = ++this._segmentPlayToken;
        this.playbackMode = 'segment';
        this._activeSegmentLabelId = options?.labelId || null;
        this._activeSegmentStart = start;
        this._activeSegmentEnd = end;
        this._activeSegmentFilter = {
            type: 'bandpass',
            freqMinHz: fLo,
            freqMaxHz: fHi,
        };

        const ctx = new Ctor();
        const bandpass = ctx.createBiquadFilter();
        bandpass.type = 'bandpass';
        bandpass.frequency.value = center;
        bandpass.Q.value = q;

        const gain = ctx.createGain();
        gain.gain.value = this.muted ? 0 : this.volume;

        bandpass.connect(gain);
        gain.connect(ctx.destination);

        const playback = {
            token,
            ctx,
            /** @type {AudioBufferSourceNode | null} */
            source: null,
            bandpass,
            gain,
            startSec: start,
            endSec: end,
            startAtCtx: 0,
            runStartSec: start,
            sourceGeneration: 0,
            rafId: 0,
            currentTimeSec: start,
        };
        this._customSegmentPlayback = playback;
        this._startCustomSegmentSource(playback);
        this._setTransportState('playing_segment', 'bandpass-segment-start');
        this._emit('segmentplaystart', { start, end, filter: { type: 'bandpass', freqMinHz: fLo, freqMaxHz: fHi } });

        const onFrame = () => {
            if (!this._customSegmentPlayback || this._customSegmentPlayback.token !== token) return;
            const elapsed = Math.max(0, ctx.currentTime - playback.startAtCtx);
            const t = Math.min(playback.endSec, playback.runStartSec + elapsed);
            playback.currentTimeSec = t;
            this._scheduleUiUpdate({ time: t, fromPlayback: true });
            if (t >= playback.endSec - 0.002) {
                if (this.loopPlayback) {
                    this._loopCustomSegmentPlayback(playback);
                    playback.rafId = requestAnimationFrame(onFrame);
                    return;
                }
                this._stopCustomSegmentPlayback('stopped', playback.endSec, { emitEnd: true });
                return;
            }
            playback.rafId = requestAnimationFrame(onFrame);
        };

        playback.rafId = requestAnimationFrame(onFrame);
    }

    _startCustomSegmentSource(playback, source = null, startAtSec = null) {
        if (!playback || !this._customSegmentPlayback || this._customSegmentPlayback.token !== playback.token) return;
        playback.sourceGeneration = (playback.sourceGeneration || 0) + 1;
        const generation = playback.sourceGeneration;
        const nextSource = source || playback.ctx.createBufferSource();
        nextSource.buffer = this.audioBuffer;
        nextSource.connect(playback.bandpass);
        nextSource.onended = () => {
            if (!this._customSegmentPlayback || this._customSegmentPlayback.token !== playback.token) return;
            if (playback.sourceGeneration !== generation) return;
            if (this.loopPlayback) {
                this._loopCustomSegmentPlayback(playback);
                return;
            }
            this._stopCustomSegmentPlayback('stopped', playback.endSec, { emitEnd: true });
        };
        playback.source = nextSource;
        playback.runStartSec = startAtSec == null ? playback.startSec : Math.max(playback.startSec, Math.min(startAtSec, playback.endSec - 0.001));
        playback.startAtCtx = playback.ctx.currentTime + 0.005;
        nextSource.start(playback.startAtCtx, playback.runStartSec, playback.endSec - playback.runStartSec);
    }

    _loopCustomSegmentPlayback(playback) {
        if (!playback || !this._customSegmentPlayback || this._customSegmentPlayback.token !== playback.token) return;
        playback.currentTimeSec = playback.startSec;
        this._scheduleUiUpdate({
            time: playback.startSec,
            fromPlayback: false,
            immediate: true,
        });
        this._emit('segmentloop', { start: playback.startSec, end: playback.endSec, filter: 'bandpass' });
        this._startCustomSegmentSource(playback);
    }

    updateActiveSegmentFromLabel(label) {
        if (!label || this.playbackMode !== 'segment') return;
        const labelId = label.id || null;
        if (this._activeSegmentLabelId && labelId && this._activeSegmentLabelId !== labelId) return;
        const dur = this.audioBuffer?.duration || 0;
        if (dur <= 0) return;

        const start = Math.max(0, Math.min(Number(label.start ?? 0), dur));
        const end = Math.max(start + 0.01, Math.min(Number(label.end ?? start + 0.01), dur));
        this._activeSegmentStart = start;
        this._activeSegmentEnd = end;

        if (this._customSegmentPlayback) {
            this._retargetCustomSegmentPlayback({
                start,
                end,
                freqMinHz: Number(label.freqMin),
                freqMaxHz: Number(label.freqMax),
            });
            return;
        }

        const now = this._getCurrentTime();
        if (now < start || now > end) {
            this._seekToTime(start, false, { allowCustomPlayback: true });
            if (this.loopPlayback && !this.wavesurfer?.isPlaying()) this.wavesurfer?.play();
        }
    }

    _retargetCustomSegmentPlayback({ start, end, freqMinHz, freqMaxHz }) {
        const playback = this._customSegmentPlayback;
        if (!playback || !this.audioBuffer) return;

        playback.startSec = start;
        playback.endSec = end;

        const hasFreq = Number.isFinite(freqMinHz) && Number.isFinite(freqMaxHz);
        if (hasFreq) {
            const nyquist = Math.max(100, this.audioBuffer.sampleRate * 0.5 - 10);
            const fLo = Math.max(20, Math.min(freqMinHz, freqMaxHz, nyquist - 5));
            const fHi = Math.max(fLo + 5, Math.min(Math.max(freqMinHz, freqMaxHz), nyquist));
            const center = Math.sqrt(fLo * fHi);
            const bandwidth = Math.max(10, fHi - fLo);
            const q = Math.max(0.25, Math.min(40, center / bandwidth));
            playback.bandpass.frequency.value = center;
            playback.bandpass.Q.value = q;
            this._activeSegmentFilter = { type: 'bandpass', freqMinHz: fLo, freqMaxHz: fHi };
        }

        const desiredStart = Math.max(start, Math.min(playback.currentTimeSec || start, end - 0.001));
        this._restartCustomSegmentSource(playback, desiredStart);
    }

    _restartCustomSegmentSource(playback, atSec) {
        if (!playback || !this._customSegmentPlayback || this._customSegmentPlayback.token !== playback.token) return;
        playback.sourceGeneration = (playback.sourceGeneration || 0) + 1;
        if (playback.source) {
            playback.source.onended = null;
            try { playback.source.stop(); } catch {}
            try { playback.source.disconnect(); } catch {}
            playback.source = null;
        }
        playback.currentTimeSec = atSec;
        this._scheduleUiUpdate({ time: atSec, fromPlayback: false, immediate: true });
        this._startCustomSegmentSource(playback, null, atSec);
    }

    /**
     * @param {string} [reason]
     * @param {number | null} [targetTimeSec]
     * @param {Object} [options]
     */
    _stopCustomSegmentPlayback(reason = 'stopped', targetTimeSec = null, options = {}) {
        const active = this._customSegmentPlayback;
        if (!active) return;

        if (active.rafId) cancelAnimationFrame(active.rafId);
        active.rafId = 0;
        if (active.source) {
            active.source.onended = null;
            try { active.source.stop(); } catch {}
            try { active.source.disconnect(); } catch {}
        }
        try { active.bandpass?.disconnect(); } catch {}
        try { active.gain.disconnect(); } catch {}
        try { active.ctx.close(); } catch {}

        this._customSegmentPlayback = null;
        this._activeSegmentLabelId = null;
        this._activeSegmentFilter = null;
        this._activeSegmentStart = null;
        this._activeSegmentEnd = null;
        this.playbackMode = 'normal';
        this._segmentPlayToken++;

        if (Number.isFinite(targetTimeSec)) {
            this._scheduleUiUpdate({ time: targetTimeSec, fromPlayback: false, immediate: true });
        }
        this.d.playPauseBtn.classList.remove('playing');
        this._setTransportState(reason === 'paused' ? 'paused_segment' : 'stopped', 'bandpass-segment-stop');
        if (options.emitEnd) {
            this._emit('segmentplayend', { end: targetTimeSec ?? 0 });
        }
    }

    _clearPlaybackFilter() {
        if (!this.wavesurfer) return;
        if (typeof this.wavesurfer.setFilter === 'function') {
            try { this.wavesurfer.setFilter(null); } catch {}
        }
    }

    _seekToTime(timeSec, centerView = false, options = {}) {
        if (!this.audioBuffer) return;
        if (options.userInitiated) {
            this._smoothSeekFocusUntil = performance.now() + this._playbackViewportConfig.smoothSeekFocusMs;
        }
        if (this._customSegmentPlayback && options.allowCustomPlayback !== true) {
            this._stopCustomSegmentPlayback('paused', this._customSegmentPlayback.currentTimeSec);
        }
        const t = Math.max(0, Math.min(timeSec, this.audioBuffer.duration));
        if (this.wavesurfer) this.wavesurfer.setTime(t);
        this._scheduleUiUpdate({
            time: t,
            fromPlayback: false,
            centerView,
            emitSeek: true,
            immediate: true,
        });
    }

    _seekByDelta(deltaSec) {
        if (!this.audioBuffer) return;
        this._seekToTime(this._getCurrentTime() + deltaSec, false);
    }

    _seekRelative(deltaSec) {
        this._seekByDelta(deltaSec);
    }

    _getCurrentTime() {
        if (this._customSegmentPlayback) return this._customSegmentPlayback.currentTimeSec;
        return this.wavesurfer ? this.wavesurfer.getCurrentTime() : 0;
    }

    _updateTimeReadout(t) {
        const nextText = formatTime(t);
        if (nextText !== this._lastTimeReadoutText) {
            this._lastTimeReadoutText = nextText;
            this.d.currentTimeDisplay.textContent = nextText;
        }
        this._updateAriaPlaybackPosition(t);
    }

    _updateAriaPlaybackPosition(currentTimeSec) {
        const slider = this.d.canvasWrapper;
        if (!slider) return;
        const duration = this.audioBuffer?.duration || 0;
        const now = Math.max(0, Math.min(currentTimeSec || 0, duration || currentTimeSec || 0));
        slider.setAttribute('aria-valuemin', '0');
        slider.setAttribute('aria-valuemax', String(duration.toFixed(3)));
        slider.setAttribute('aria-valuenow', String(now.toFixed(3)));
        slider.setAttribute('aria-valuetext', `${formatTime(now)} of ${formatTime(duration)}`);
    }

    // ═════════════════════════════════════════════════════════════════
    //  Playhead & Follow
    // ═════════════════════════════════════════════════════════════════

    _updatePlayhead(currentTime, fromPlayback) {
        if (!this.audioBuffer) return;

        const duration = Math.max(0.001, this.audioBuffer.duration);
        const canvasWidth = Math.max(1, this.d.spectrogramCanvas.width || this.d.amplitudeCanvas.width || 0);
        const position = (currentTime / duration) * canvasWidth;

        this.d.playhead.style.transform = `translateX(${position}px)`;
        this.d.waveformPlayhead.style.transform = `translateX(${position}px)`;

        // Follow-mode scroll
        if (fromPlayback && this.followPlayback && this.wavesurfer?.isPlaying()) {
            const vw = this._getViewportWidth();
            if (this.followMode === 'smooth') {
                this._applySmoothFollow(position, vw);
            } else {
                const scrollLeft = this._getPrimaryScrollLeft();
                const guardLeft = scrollLeft + vw * this._playbackViewportConfig.followGuardLeftRatio;
                const guardRight = scrollLeft + vw * this._playbackViewportConfig.followGuardRightRatio;
                if (position < guardLeft || position > guardRight) {
                    this._animateFollowCatchupTo(Math.max(0, position - vw * this._playbackViewportConfig.followTargetRatio));
                }
            }
        }

        this._syncOverviewWindowToViewport();

        if (!this._customSegmentPlayback && this._activeSegmentEnd != null && currentTime >= this._activeSegmentEnd - 0.005) {
            const start = this._activeSegmentStart ?? 0;
            const end = this._activeSegmentEnd;
            if (this.loopPlayback && this.wavesurfer?.isPlaying()) {
                this._seekToTime(start, false, { allowCustomPlayback: true });
                this._emit('segmentloop', { start, end, filter: 'none' });
                return;
            }
            this._activeSegmentStart = null;
            this._activeSegmentLabelId = null;
            this._activeSegmentFilter = null;
            this._activeSegmentEnd = null;
            this.playbackMode = 'normal';
            this._segmentPlayToken++;
            this._suppressNextPauseHandler = true;
            this.wavesurfer?.pause();
            this._seekToTime(end, false);
            this.d.playPauseBtn.classList.remove('playing');
            this._setTransportState('stopped', 'segment-end');
            this._emit('segmentplayend', { end });
        }
    }

    // ═════════════════════════════════════════════════════════════════
    //  Spectrogram Pipeline
    // ═════════════════════════════════════════════════════════════════

    async _generateSpectrogram() {
        if (!this.audioBuffer) return;
        if (this._externalSpectrogram) return; // external data — do not overwrite
        this._setTransportState('rendering', 'spectrogram-generate');

        const scale = this.d.scaleSelect?.value || 'mel';
        const spectrogramMode = scale === 'mel' ? 'perch' : 'classic';
        const windowSize = parseInt(this.d.windowSizeSelect?.value || '0', 10) || 0;
        const hopSize = parseInt(this.d.hopSizeSelect?.value || '0', 10) || 0;
        const windowFunction = this.d.windowFunctionSelect?.value || 'hann';
        const nMels = parseInt(this.d.nMelsInput?.value || '160', 10) || 160;
        const options = {
            spectrogramMode,
            sampleRate: this.audioBuffer.sampleRate,
            fftSize: parseInt(this.d.fftSizeSelect.value, 10),
            windowFunction,
            nMels,
            frameRate: PERCH_FRAME_RATE,
            pcenGain: parseFloat(this.d.pcenGainInput?.value || '0.8'),
            pcenBias: parseFloat(this.d.pcenBiasInput?.value || '0.01'),
            pcenRoot: parseFloat(this.d.pcenRootInput?.value || '4.0'),
            pcenSmoothing: parseFloat(this.d.pcenSmoothingInput?.value || '0.025'),
            ...(windowSize > 0 ? { windowSize } : {}),
            ...(hopSize > 0 ? { hopSize } : {}),
        };

        try {
            const channelData = this.audioBuffer.getChannelData(0);
            let result;

            const shouldUseProgressive = this.options.enableProgressiveSpectrogram === true
                && this.audioBuffer.duration >= PROGRESSIVE_MIN_DURATION_SEC
                && typeof this.processor.computeProgressive === 'function';

            if (shouldUseProgressive) {
                const chunkResults = [];
                for await (const progress of this.processor.computeProgressive(channelData, {
                    ...options,
                    chunkSeconds: PROGRESSIVE_CHUNK_SECONDS,
                })) {
                    chunkResults.push(progress.result);
                    this._emit('progress', {
                        chunk: progress.chunk,
                        totalChunks: progress.totalChunks,
                        percent: progress.percent,
                    });
                }
                result = this._mergeProgressiveResults(chunkResults, options.nMels);
            } else {
                result = await this.processor.compute(channelData, options);
            }

            this.spectrogramData = result.data;
            this.spectrogramFrames = result.nFrames;
            this.spectrogramMels = result.nMels;
            this.spectrogramHopSize = result.hopSize || Math.max(1, Math.floor(this.sampleRateHz / PERCH_FRAME_RATE));
            this.spectrogramWinLength = result.winLength || 4 * this.spectrogramHopSize;

            this._updateSpectrogramStats();
            this._autoContrast();
            this._autoFrequency();

            // Stage 1: build grayscale (expensive, once)
            this._buildSpectrogramGrayscale();
            // Stage 2: colorize (fast, GPU or JS)
            this._buildSpectrogramBaseImage();
            this._drawSpectrogram();
            this._syncOverviewWindowToViewport();
            this._setTransportState('ready', 'spectrogram-ready');

            this._emit('ready', {
                duration: this.audioBuffer.duration,
                sampleRate: this.audioBuffer.sampleRate,
                nFrames: this.spectrogramFrames,
                nMels: this.spectrogramMels,
            });
        } catch (error) {
            this._setTransportState('error', 'spectrogram-error');
            this._emit('error', { message: error?.message || String(error), source: 'spectrogram' });
            throw error;
        }
    }

    // ── External Spectrogram Injection ────────────────────────────

    /**
     * Mode 1: Raw data — enter pipeline at Stage 1 (grayscale → colorize → render).
     * Contrast sliders, color map selection, and frequency controls all remain functional.
     */
    _setExternalSpectrogram(data, nFrames, nMels, options = {}) {
        // Decode base64 string → Float32Array
        let floats;
        if (typeof data === 'string') {
            const binary = atob(data);
            const bytes = new Uint8Array(binary.length);
            for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
            floats = new Float32Array(bytes.buffer);
        } else if (data instanceof ArrayBuffer) {
            floats = new Float32Array(data);
        } else if (data instanceof Float32Array) {
            floats = data;
        } else {
            throw new Error('setSpectrogramData: data must be Float32Array, ArrayBuffer, or base64 string');
        }

        if (floats.length !== nFrames * nMels) {
            throw new Error(`setSpectrogramData: data.length (${floats.length}) !== nFrames*nMels (${nFrames}*${nMels}=${nFrames * nMels})`);
        }

        this._externalSpectrogram = true;
        this.spectrogramData = floats;
        this.spectrogramFrames = nFrames;
        this.spectrogramMels = nMels;

        if (options.sampleRate) this.sampleRateHz = options.sampleRate;
        if (options.mode && this.d.scaleSelect) {
            this.d.scaleSelect.value = options.mode === 'classic' ? 'linear' : 'mel';
        }

        this._updateSpectrogramStats();
        this._autoContrast();
        this._autoFrequency();
        this._buildSpectrogramGrayscale();
        this._buildSpectrogramBaseImage();
        this._drawSpectrogram();
        this._syncOverviewWindowToViewport();
        this._setTransportState('ready', 'spectrogram-external-data');

        this._emit('ready', {
            duration: this.audioBuffer?.duration || 0,
            sampleRate: this.sampleRateHz,
            nFrames: this.spectrogramFrames,
            nMels: this.spectrogramMels,
            external: true,
        });
    }

    /**
     * Mode 2: Pre-rendered image — bypasses entire DSP + colorization pipeline.
     * Contrast/color controls have no effect; the image is drawn as-is.
     */
    _setExternalSpectrogramImage(image, options = {}) {
        return /** @type {Promise<void>} */ (new Promise((resolve, reject) => {
            const apply = (img) => {
                // Draw image onto an offscreen canvas for the rendering pipeline
                const canvas = document.createElement('canvas');
                canvas.width = img.naturalWidth || img.width;
                canvas.height = img.naturalHeight || img.height;
                const ctx = canvas.getContext('2d');
                if (!ctx) { reject(new Error('Could not get 2d context')); return; }
                ctx.drawImage(img, 0, 0);

                this._externalSpectrogram = true;
                this.spectrogramBaseCanvas = canvas;
                this.spectrogramData = new Float32Array(0); // placeholder
                this.spectrogramFrames = canvas.width;
                this.spectrogramMels = canvas.height;
                this.spectrogramGrayInfo = null;

                if (options.sampleRate) this.sampleRateHz = options.sampleRate;

                this._drawSpectrogram();
                this._syncOverviewWindowToViewport();
                this._setTransportState('ready', 'spectrogram-external-image');

                this._emit('ready', {
                    duration: this.audioBuffer?.duration || 0,
                    sampleRate: this.sampleRateHz,
                    nFrames: this.spectrogramFrames,
                    nMels: this.spectrogramMels,
                    external: true,
                    externalImage: true,
                });
                resolve();
            };

            if (image instanceof HTMLCanvasElement || (image instanceof HTMLImageElement && image.complete)) {
                apply(image);
            } else if (image instanceof HTMLImageElement) {
                image.onload = () => apply(image);
                image.onerror = reject;
            } else if (typeof image === 'string') {
                const img = new Image();
                img.onload = () => apply(img);
                img.onerror = reject;
                img.src = image; // data:image/png;base64,... or URL
            } else {
                reject(new Error('setSpectrogramImage: unsupported image type'));
            }
        }));
    }

    _mergeProgressiveResults(chunkResults, nMels) {
        let totalFrames = 0;
        for (const chunk of chunkResults) totalFrames += chunk.nFrames;

        const data = new Float32Array(totalFrames * nMels);
        let frameOffset = 0;
        for (const chunk of chunkResults) {
            data.set(chunk.data, frameOffset * nMels);
            frameOffset += chunk.nFrames;
        }
        const first = chunkResults[0] || {};
        return { data, nFrames: totalFrames, nMels, hopSize: first.hopSize, winLength: first.winLength };
    }

    _updateSpectrogramStats() {
        const stats = computeSpectrogramStats(this.spectrogramData);
        this.spectrogramAbsLogMin = stats.logMin;
        this.spectrogramAbsLogMax = stats.logMax;
    }

    // ── Auto-Contrast ───────────────────────────────────────────────

    /** Compute optimal floor/ceil from percentiles.
     *  Pass redraw=true when called from a button click. */
    _autoContrast(redraw = false) {
        if (!this.spectrogramData) return;
        const stats = autoContrastStats(this.spectrogramData, 2, 98);
        const range = this.spectrogramAbsLogMax - this.spectrogramAbsLogMin;
        if (range < 1e-8) return;

        const floorPct = Math.max(0, Math.min(100,
            ((stats.logMin - this.spectrogramAbsLogMin) / range) * 100));
        const ceilPct  = Math.max(0, Math.min(100,
            ((stats.logMax - this.spectrogramAbsLogMin) / range) * 100));

        this.d.floorSlider.value = Math.round(floorPct);
        this.d.ceilSlider.value  = Math.round(ceilPct);
        if (redraw) {
            this._buildSpectrogramBaseImage();
            this._drawSpectrogram();
        }
    }

    // ── Auto-Frequency ──────────────────────────────────────────────

    /** Detect best maxFreq. Pass redraw=true when called from button click. */
    _autoFrequency(redraw = false) {
        if (!this.spectrogramData) return;
        const hzValue = detectMaxFrequency(
            this.spectrogramData,
            this.spectrogramFrames,
            this.spectrogramMels,
            this.sampleRateHz,
            (this.d.scaleSelect?.value || 'mel') === 'mel' ? 'perch' : 'classic',
        );
        const options = Array.from(this.d.maxFreqSelect.options);
        let best = options[options.length - 1];
        for (const opt of options) {
            if (parseFloat(opt.value) >= hzValue) { best = opt; break; }
        }
        this.d.maxFreqSelect.value = best.value;
        this._emit('spectrogramscalechange', { maxFreq: parseFloat(this.d.maxFreqSelect.value) });
        this._updateCoords();
        this._createFrequencyLabels();
        if (redraw) {
            this._buildSpectrogramGrayscale();  // maxFreq changed → Stage 1
            this._buildSpectrogramBaseImage();
            this._drawSpectrogram();
        }
    }

    // ── Volume ──────────────────────────────────────────────────────

    _setVolume(val) {
        this.volume = Math.max(0, Math.min(1, val));
        if (this.wavesurfer) this.wavesurfer.setVolume(this.volume);
        if (this._customSegmentPlayback?.gain) {
            this._customSegmentPlayback.gain.gain.value = this.muted ? 0 : this.volume;
        }
        this._updateVolumeIcon();
    }

    _toggleMute() {
        if (this.muted) {
            this.muted = false;
            this._setVolume(this.preMuteVolume);
            this.d.volumeSlider.value = Math.round(this.preMuteVolume * 100);
        } else {
            this.preMuteVolume = this.volume;
            this.muted = true;
            if (this.wavesurfer) this.wavesurfer.setVolume(0);
            if (this._customSegmentPlayback?.gain) this._customSegmentPlayback.gain.gain.value = 0;
            this._updateVolumeIcon();
        }
    }

    _updateVolumeIcon() {
        const waves = this.d.volumeWaves;
        const btn = this.d.volumeToggleBtn;
        if (!waves || !btn) return;
        const vol = this.muted ? 0 : this.volume;
        waves.style.display = vol < 0.01 ? 'none' : '';
        waves.setAttribute('d',
            vol < 0.4
                ? 'M15 8.5a4 4 0 010 7'
                : 'M15 8.5a4 4 0 010 7M18 5a9 9 0 010 14'
        );
        btn.classList.toggle('muted', vol < 0.01);
    }

    /** Stage 1 — expensive: PCEN → 8-bit grayscale. Run once per audio/fft/freq change. */
    _buildSpectrogramGrayscale() {
        this.spectrogramGrayInfo = buildSpectrogramGrayscale({
            spectrogramData: this.spectrogramData,
            spectrogramFrames: this.spectrogramFrames,
            spectrogramMels: this.spectrogramMels,
            sampleRateHz: this.sampleRateHz,
            maxFreq: parseFloat(this.d.maxFreqSelect.value),
            spectrogramAbsLogMin: this.spectrogramAbsLogMin,
            spectrogramAbsLogMax: this.spectrogramAbsLogMax,
            spectrogramMode: (this.d.scaleSelect?.value || 'mel') === 'mel' ? 'perch' : 'classic',
        });
        // Upload to GPU if available
        if (this.spectrogramGrayInfo && this.colorizer.ok) {
            const { gray, width, height } = this.spectrogramGrayInfo;
            this._gpuReady = this.colorizer.uploadGrayscale(gray, width, height);
        } else {
            this._gpuReady = false;
        }
    }

    /** Stage 2 — fast: grayscale → colored canvas.
     *  GPU path: ~0.1 ms.  JS fallback: ~20-80 ms. */
    _buildSpectrogramBaseImage() {
        if (!this.spectrogramGrayInfo) this._buildSpectrogramGrayscale();
        const floor01 = parseFloat(this.d.floorSlider.value) / 100;
        const ceil01  = parseFloat(this.d.ceilSlider.value)  / 100;

        if (this._gpuReady && this.spectrogramGrayInfo) {
            this.colorizer.uploadColorLut(this.currentColorScheme);
            this.colorizer.render(floor01, ceil01);
            this.spectrogramBaseCanvas = this.colorizer.canvas;
        } else {
            this.spectrogramBaseCanvas = colorizeSpectrogram(
                this.spectrogramGrayInfo, floor01, ceil01, this.currentColorScheme,
            );
        }
        return this.spectrogramBaseCanvas;
    }

    _drawSpectrogram() {
        if (!this._showSpectrogram) return;
        if (!this.audioBuffer || !this.spectrogramData || this.spectrogramFrames <= 0) return;
        if (!this.spectrogramBaseCanvas) this._buildSpectrogramBaseImage();
        if (!this.spectrogramBaseCanvas) return;

        const effectiveSpectrogramHeight = this._getEffectiveSpectrogramHeight();

        renderSpectrogram({
            duration: this.audioBuffer.duration,
            spectrogramCanvas: this.d.spectrogramCanvas,
            pixelsPerSecond: this.pixelsPerSecond,
            canvasHeight: effectiveSpectrogramHeight,
            baseCanvas: this.spectrogramBaseCanvas,
            sampleRate: this.audioBuffer.sampleRate,
            frameRate: PERCH_FRAME_RATE,
            spectrogramFrames: this.spectrogramFrames,
            hopSize: this.spectrogramHopSize,
        });

        this._updateCoords();
        this._scheduleUiUpdate({ time: this._getCurrentTime(), fromPlayback: false, immediate: true });
    }

    _requestSpectrogramRedraw() {
        if (this._zoomRedrawRafId) return;
        this._zoomRedrawRafId = requestAnimationFrame(() => {
            this._zoomRedrawRafId = 0;
            if (!this.audioBuffer) return;
            if (this.spectrogramData && this.spectrogramFrames > 0) this._drawSpectrogram();
            this._drawMainWaveform();
        });
    }

    // ═════════════════════════════════════════════════════════════════
    //  Waveform Rendering
    // ═════════════════════════════════════════════════════════════════

    _drawMainWaveform() {
        if (!this._showWaveform) return;
        const effectiveWaveformHeight = this._getEffectiveWaveformHeight();
        renderMainWaveform({
            audioBuffer: this.audioBuffer,
            amplitudeCanvas: this.d.amplitudeCanvas,
            waveformTimelineCanvas: this.d.waveformTimelineCanvas,
            waveformContent: this.d.waveformContent,
            pixelsPerSecond: this.pixelsPerSecond,
            waveformHeight: effectiveWaveformHeight,
            amplitudePeakAbs: this.amplitudePeakAbs,
            showTimeline: this._showWaveformTimeline,
        });
        this._scheduleUiUpdate({ time: this._getCurrentTime(), fromPlayback: false, immediate: true });
    }

    _drawOverviewWaveform() {
        if (!this._showOverview) return;
        renderOverviewWaveform({
            audioBuffer: this.audioBuffer,
            overviewCanvas: this.d.overviewCanvas,
            overviewContainer: this.d.overviewContainer,
            amplitudePeakAbs: this.amplitudePeakAbs,
        });
        this._scheduleUiUpdate({ time: this._getCurrentTime(), fromPlayback: false, immediate: true });
    }

    _createFrequencyLabels() {
        renderFrequencyLabels({
            labelsElement: this.d.freqLabels,
            coords: this.coords,
        });
    }

    _updateAmplitudeLabels() {
        const el = this.d.amplitudeLabels;
        if (!el) return;
        el.innerHTML = '';

        const peak = Math.max(1e-6, this.amplitudePeakAbs || 1);
        const clampedH = this._getEffectiveWaveformHeight();
        const timelineH = this._showWaveformTimeline ? Math.max(18, Math.min(32, Math.round(clampedH * 0.22))) : 0;
        const ampH = Math.max(32, clampedH - timelineH);

        const fmt = (v) => {
            const a = Math.abs(v);
            return a >= 1 ? v.toFixed(2) : a >= 0.1 ? v.toFixed(3) : v.toFixed(4);
        };

        const positions = [4, ampH / 2, Math.max(4, ampH - 4)];
        [peak, 0, -peak].forEach((value, i) => {
            const span = document.createElement('span');
            span.textContent = value === 0 ? '0.000' : `${value > 0 ? '+' : ''}${fmt(value)}`;
            span.style.top = `${positions[i]}px`;
            el.appendChild(span);
        });
    }

    // ═════════════════════════════════════════════════════════════════
    //  Viewport & Scroll
    // ═════════════════════════════════════════════════════════════════

    _getPrimaryScrollWrapper() {
        if (!this._showSpectrogram && this._showWaveform) return this.d.waveformWrapper;
        return this.d.canvasWrapper || this.d.waveformWrapper;
    }

    _getSecondaryScrollWrapper() {
        const primary = this._getPrimaryScrollWrapper();
        if (primary === this.d.canvasWrapper) return this.d.waveformWrapper;
        if (primary === this.d.waveformWrapper) return this.d.canvasWrapper;
        return null;
    }

    _getPrimaryScrollLeft() {
        return this._getPrimaryScrollWrapper()?.scrollLeft || 0;
    }

    _getViewportWidth() {
        const primary = this._getPrimaryScrollWrapper();
        const secondary = this._getSecondaryScrollWrapper();
        return Math.max(1, primary?.clientWidth || secondary?.clientWidth || 0);
    }

    _setLinkedScrollLeft(nextLeft) {
        if (this.scrollSyncLock) return;
        this.scrollSyncLock = true;

        const vw = this._getViewportWidth();
        const tw = this.audioBuffer ? Math.max(1, Math.floor(this.audioBuffer.duration * this.pixelsPerSecond)) : 0;
        const maxScroll = Math.max(0, tw - vw);
        const bounded = Math.max(0, Math.min(nextLeft, maxScroll));

        const primary = this._getPrimaryScrollWrapper();
        const secondary = this._getSecondaryScrollWrapper();
        if (primary) primary.scrollLeft = bounded;
        if (secondary) secondary.scrollLeft = primary?.scrollLeft ?? bounded;

        this.scrollSyncLock = false;
        this._scheduleUiUpdate({ time: this._getCurrentTime(), fromPlayback: false });
    }

    _setPixelsPerSecond(nextPps, redraw, anchorTime, anchorPixel) {
        const minPps = Number(this.d.zoomSlider.min);
        const maxPps = Number(this.d.zoomSlider.max);
        const sliderStep = Number(this.d.zoomSlider.step || 1);
        const vw = this._getViewportWidth();
        const duration = this.audioBuffer?.duration || 0;

        const clamped = Math.max(minPps, Math.min(maxPps, nextPps));
        const changed = Math.abs(clamped - this.pixelsPerSecond) >= 0.01;

        const fallbackTime = (this._getPrimaryScrollLeft() + vw / 2) / Math.max(this.pixelsPerSecond, 0.01);
        const aTime = anchorTime ?? fallbackTime;
        const aPixel = anchorPixel ?? (vw / 2);

        const effectivePps = changed ? clamped : this.pixelsPerSecond;
        const estWidth = duration ? Math.max(1, Math.floor(duration * effectivePps)) : 0;
        const maxScroll = Math.max(0, estWidth - vw);
        const nextScroll = aTime * effectivePps - aPixel;
        const bounded = Math.max(0, Math.min(maxScroll, nextScroll));

        if (changed) {
            this.pixelsPerSecond = effectivePps;
            this.d.zoomSlider.value = String(Math.round(effectivePps / sliderStep) * sliderStep);
            this.d.zoomValue.textContent = `${Math.round(effectivePps)} px/s`;
            this._emit('zoomchange', { pixelsPerSecond: this.pixelsPerSecond });

            if (this.wavesurfer) this.wavesurfer.zoom(effectivePps);
            if (this.audioBuffer && redraw) {
                if (this.spectrogramData && this.spectrogramFrames > 0) this._drawSpectrogram();
                this._drawMainWaveform();
            }
        }

        this._setLinkedScrollLeft(bounded);
    }

    _fitEntireTrackInView() {
        if (!this.audioBuffer) return;
        const fitPps = this._getViewportWidth() / Math.max(0.05, this.audioBuffer.duration);
        this._setPixelsPerSecond(fitPps, true, 0, 0);
    }

    _zoomByScale(scale, centerClientX, source = 'spectrogram') {
        if (!this.audioBuffer) return;
        const wrapper = source === 'waveform' ? this.d.waveformWrapper : this.d.canvasWrapper;
        const rect = wrapper.getBoundingClientRect();
        const localX = Math.max(0, Math.min(rect.width, centerClientX - rect.left));
        const anchorTime = (wrapper.scrollLeft + localX) / Math.max(this.pixelsPerSecond, 0.01);
        this._setPixelsPerSecond(this.pixelsPerSecond * scale, true, anchorTime, localX);
    }

    _centerViewportAtTime(timeSec) {
        if (!this.audioBuffer) return;
        const vw = this._getViewportWidth();
        const viewDur = vw / this.pixelsPerSecond;
        let start = timeSec - viewDur / 2;
        start = Math.max(0, Math.min(start, Math.max(0, this.audioBuffer.duration - viewDur)));
        this._setLinkedScrollLeft(start * this.pixelsPerSecond);
    }

    _clientXToTime(clientX, source = 'spectrogram') {
        const wrapper = source === 'waveform' ? this.d.waveformWrapper : this.d.canvasWrapper;
        const rect = wrapper.getBoundingClientRect();
        const x = clientX - rect.left + wrapper.scrollLeft;
        const refWidth = source === 'waveform' ? this.d.amplitudeCanvas.width : this.d.spectrogramCanvas.width;
        const dur = this.audioBuffer?.duration || 0;
        const t = (x / Math.max(1, refWidth)) * dur;
        return Math.max(0, Math.min(t, dur));
    }

    // ═════════════════════════════════════════════════════════════════
    //  Overview Navigator
    // ═════════════════════════════════════════════════════════════════

    _syncOverviewWindowToViewport() {
        if (!this._showOverview || !this.audioBuffer) return;
        if (this.interaction.isOverviewDrag) return;
        const trackWidth = Math.max(
            this.d.spectrogramCanvas.width || 0,
            this.d.amplitudeCanvas.width || 0,
            Math.floor(this.audioBuffer.duration * this.pixelsPerSecond),
        );
        if (trackWidth <= 0) return;

        const vw = this._getViewportWidth();
        const viewTime = vw / this.pixelsPerSecond;
        const startTime = this._getPrimaryScrollLeft() / this.pixelsPerSecond;
        const endTime = Math.min(this.audioBuffer.duration, startTime + viewTime);

        const nextStartNorm = startTime / this.audioBuffer.duration;
        const nextEndNorm = endTime / this.audioBuffer.duration;
        const moved = Math.abs(nextStartNorm - this.windowStartNorm) > 1e-5
            || Math.abs(nextEndNorm - this.windowEndNorm) > 1e-5;

        this.windowStartNorm = nextStartNorm;
        this.windowEndNorm = nextEndNorm;
        if (moved) this._updateOverviewWindowElement();

        const rangeChanged = Math.abs(startTime - this._lastViewRangeTextStart) > 0.05
            || Math.abs(endTime - this._lastViewRangeTextEnd) > 0.05;
        if (rangeChanged) {
            this._lastViewRangeTextStart = startTime;
            this._lastViewRangeTextEnd = endTime;
            this.d.viewRangeDisplay.textContent = `${formatSecondsShort(startTime)} – ${formatSecondsShort(endTime)}`;
        }

        const now = performance.now();
        const selectionChanged = !Number.isFinite(this._lastSelectionStart)
            || Math.abs(startTime - this._lastSelectionStart) > 0.03
            || Math.abs(endTime - this._lastSelectionEnd) > 0.03;
        if (selectionChanged && (now - this._lastSelectionEmitAt >= 80)) {
            this._lastSelectionEmitAt = now;
            this._lastSelectionStart = startTime;
            this._lastSelectionEnd = endTime;
            this._perf.selectionEvents += 1;
            this._emit('selection', { start: startTime, end: endTime });
        }
    }

    _updateOverviewWindowElement() {
        if (!this._showOverview) return;
        const cw = this.d.overviewContainer.clientWidth;
        const left = this.windowStartNorm * cw;
        const width = Math.max(8, this.windowEndNorm * cw - left);
        this.d.overviewWindow.style.left = `${left}px`;
        this.d.overviewWindow.style.width = `${width}px`;
    }

    _getOverviewSpanConstraints() {
        const duration = Math.max(0.001, this.audioBuffer?.duration || 0.001);
        const vw = Math.max(1, this._getViewportWidth());
        const minPps = Math.max(1, Number(this.d.zoomSlider?.min || 20));
        const maxPps = Math.max(minPps, Number(this.d.zoomSlider?.max || 600));
        const minSpanNorm = Math.max(MIN_WINDOW_NORM, (vw / maxPps) / duration);
        const maxSpanNorm = Math.min(1, (vw / minPps) / duration);
        return {
            minSpanNorm: Math.min(minSpanNorm, 1),
            maxSpanNorm: Math.max(minSpanNorm, maxSpanNorm),
        };
    }

    _startOverviewDrag(mode, clientX) {
        /** @type {Record<string, import('./interactionState.js').InteractionMode>} */
        const modeMap = { move: 'overview-move', left: 'overview-resize-left', right: 'overview-resize-right' };
        if (!this.interaction.enter(modeMap[mode])) return;
        this.interaction.ctx.overviewStartX = clientX;
        this.interaction.ctx.overviewStartNorm = this.windowStartNorm;
        this.interaction.ctx.overviewEndNorm = this.windowEndNorm;
    }

    _updateOverviewDrag(clientX) {
        const sub = this.interaction.overviewSubMode;
        if (!this._showOverview || !this.audioBuffer || !sub) return;
        const ctx = this.interaction.ctx;
        if (Math.abs(clientX - ctx.overviewStartX) > 2) ctx.overviewMoved = true;

        const cw = this.d.overviewContainer.clientWidth;
        const deltaNorm = (clientX - ctx.overviewStartX) / cw;
        const { minSpanNorm, maxSpanNorm } = this._getOverviewSpanConstraints();
        const fixedStart = ctx.overviewStartNorm;
        const fixedEnd = ctx.overviewEndNorm;

        if (sub === 'move') {
            let s = fixedStart + deltaNorm;
            let e = fixedEnd + deltaNorm;
            const span = e - s;
            if (s < 0) { s = 0; e = span; }
            if (e > 1) { e = 1; s = 1 - span; }
            this.windowStartNorm = s;
            this.windowEndNorm = e;
        } else if (sub === 'left') {
            const nextStart = fixedStart + deltaNorm;
            const right = fixedEnd;
            const minStart = Math.max(0, right - maxSpanNorm);
            const maxStart = Math.max(minStart, right - minSpanNorm);
            this.windowStartNorm = Math.max(minStart, Math.min(maxStart, nextStart));
            this.windowEndNorm = right;
        } else if (sub === 'right') {
            const nextEnd = fixedEnd + deltaNorm;
            const left = fixedStart;
            const minEnd = Math.min(1, left + minSpanNorm);
            const maxEnd = Math.min(1, left + maxSpanNorm);
            this.windowEndNorm = Math.max(minEnd, Math.min(maxEnd, nextEnd));
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
            if (!redraw) this._requestSpectrogramRedraw();
        });
    }

    _applyOverviewWindowToViewport(redraw = true) {
        if (!this._showOverview || !this.audioBuffer) return;
        const dur = this.audioBuffer.duration;
        const viewDur = Math.max(0.01, (this.windowEndNorm - this.windowStartNorm) * dur);
        const targetPps = this._getViewportWidth() / viewDur;
        this._setPixelsPerSecond(targetPps, redraw, this.windowStartNorm * dur, 0);
    }

    // ═════════════════════════════════════════════════════════════════
    //  Click / Pointer / Drag
    // ═════════════════════════════════════════════════════════════════

    _handleCanvasClick(e) {
        if (this.interaction.isSeekBlocked()) return;
        if (!this.audioBuffer) return;
        this._cancelFollowCatchupAnimation();
        this._seekToTime(this._clientXToTime(e.clientX, 'spectrogram'), false, { userInitiated: true });
    }

    _handleWaveformClick(e) {
        if (this.interaction.isSeekBlocked()) return;
        if (!this.audioBuffer) return;
        this._cancelFollowCatchupAnimation();
        this._seekToTime(this._clientXToTime(e.clientX, 'waveform'), false, { userInitiated: true });
    }

    _blockSeekClicks(ms = 220) {
        this.interaction.blockSeekClicks(ms);
    }

    _startPlayheadDrag(event, source) {
        if (!this.audioBuffer) return;
        event.preventDefault();
        if (!this.interaction.enter('playhead-drag')) return;
        this.interaction.ctx.playheadSource = source;
        this._seekFromClientX(event.clientX, source);
    }

    _seekFromClientX(clientX, source = 'spectrogram') {
        if (!this.audioBuffer) return;
        this._seekToTime(this._clientXToTime(clientX, source), false);
    }

    _startViewportPan(event, source) {
        if (!this.audioBuffer) return;
        this._cancelFollowCatchupAnimation();
        if (event.target === this.d.playhead || event.target === this.d.waveformPlayhead) return;
        if (event.button !== 0 && event.button !== 1) return;
        if (event.button === 1) event.preventDefault();

        if (!this.interaction.enter('viewport-pan')) return;
        this.interaction.ctx.panStartX = event.clientX;
        this.interaction.ctx.panStartScroll = source === 'waveform'
            ? this.d.waveformWrapper.scrollLeft
            : this.d.canvasWrapper.scrollLeft;
        document.body.style.cursor = 'grabbing';
    }

    _updateViewportPan(clientX) {
        const dx = clientX - this.interaction.ctx.panStartX;
        this.interaction.ctx.panSuppressClick = Math.abs(dx) > 3;
        this._setLinkedScrollLeft(this.interaction.ctx.panStartScroll - dx);
    }

    // ═════════════════════════════════════════════════════════════════
    //  Wheel Zoom / Scroll
    // ═════════════════════════════════════════════════════════════════

    _handleWheel(event, source) {
        if (!this.audioBuffer) return;
        this._cancelFollowCatchupAnimation();

        const wrapper = source === 'waveform' ? this.d.waveformWrapper : this.d.canvasWrapper;
        const rect = wrapper.getBoundingClientRect();
        const localX = event.clientX - rect.left;
        const timeAtCursor = (wrapper.scrollLeft + localX) / this.pixelsPerSecond;

        if (event.ctrlKey || event.metaKey) {
            event.preventDefault();
            const factor = event.deltaY < 0 ? 1.12 : 1 / 1.12;
            this._setPixelsPerSecond(this.pixelsPerSecond * factor, true, timeAtCursor, localX);
            return;
        }

        if (Math.abs(event.deltaY) > Math.abs(event.deltaX)) {
            event.preventDefault();
            this._setLinkedScrollLeft(Math.max(0, wrapper.scrollLeft + event.deltaY));
        }
    }

    // ═════════════════════════════════════════════════════════════════
    //  View Resize
    // ═════════════════════════════════════════════════════════════════

    _applyLocalViewHeights() {
        const overlaySingleWaveform = this._transportOverlay && this._showWaveform && !this._showSpectrogram;
        const overlaySingleSpectrogram = this._transportOverlay && this._showSpectrogram && !this._showWaveform;

        if (this._showWaveform) {
            if (overlaySingleWaveform) {
                this.d.waveformContainer.style.height = 'auto';
            } else {
            this.d.waveformContainer.style.height = `${Math.round(this.waveformDisplayHeight)}px`;
            }
        }
        if (this._showSpectrogram) {
            if (overlaySingleSpectrogram) {
                this.d.spectrogramContainer.style.height = 'auto';
            } else {
            this.d.spectrogramContainer.style.height = `${Math.round(this.spectrogramDisplayHeight)}px`;
            }
        }
    }

    _getEffectiveWaveformHeight() {
        if (this._transportOverlay && this._showWaveform && !this._showSpectrogram) {
            const h = this.d.waveformContainer?.clientHeight || 0;
            return Math.max(MIN_WAVEFORM_HEIGHT, Math.floor(h || this.waveformDisplayHeight));
        }
        return Math.max(MIN_WAVEFORM_HEIGHT, Math.floor(this.waveformDisplayHeight));
    }

    _getEffectiveSpectrogramHeight() {
        if (this._transportOverlay && this._showSpectrogram && !this._showWaveform) {
            const h = this.d.spectrogramContainer?.clientHeight || 0;
            return Math.max(MIN_SPECTROGRAM_DISPLAY_HEIGHT, Math.floor(h || this.spectrogramDisplayHeight));
        }
        return Math.max(MIN_SPECTROGRAM_DISPLAY_HEIGHT, Math.floor(this.spectrogramDisplayHeight));
    }

    /** Rebuild the shared CoordinateSystem whenever any mapping parameter changes. */
    _updateCoords() {
        this.coords = new CoordinateSystem({
            duration: this.audioBuffer?.duration || 0,
            sampleRate: this.sampleRateHz,
            pixelsPerSecond: this.pixelsPerSecond,
            canvasWidth: this.d.spectrogramCanvas?.width || 0,
            canvasHeight: this.d.spectrogramCanvas?.height || 0,
            maxFreq: parseFloat(this.d.maxFreqSelect?.value || '10000'),
            spectrogramMels: this.spectrogramMels,
            spectrogramMode: (this.d.scaleSelect?.value || 'mel') === 'mel' ? 'perch' : 'classic',
            frameRate: PERCH_FRAME_RATE,
            hopSize: this.spectrogramHopSize || 0,
        });
    }

    _startViewResize(mode, clientY) {
        /** @type {Record<string, import('./interactionState.js').InteractionMode>} */
        const modeMap = { split: 'view-resize-split', spectrogram: 'view-resize-spectrogram' };
        if (!this.interaction.enter(modeMap[mode])) return;
        this.interaction.ctx.resizeStartY = clientY;
        this.interaction.ctx.resizeStartWaveformH = this.waveformDisplayHeight;
        this.interaction.ctx.resizeStartSpectrogramH = this.spectrogramDisplayHeight;
        document.body.style.cursor = 'row-resize';
    }

    _updateViewResize(clientY) {
        const sub = this.interaction.viewResizeSubMode;
        if (!sub) return;
        if ((sub === 'split' && (!this._showWaveform || !this._showSpectrogram))
            || (sub === 'spectrogram' && !this._showSpectrogram)) return;
        const ctx = this.interaction.ctx;
        const dy = clientY - ctx.resizeStartY;
        let redrawWav = false;

        if (sub === 'split') {
            const total = ctx.resizeStartWaveformH + ctx.resizeStartSpectrogramH;
            let nextWav = ctx.resizeStartWaveformH + dy;
            nextWav = Math.max(MIN_WAVEFORM_HEIGHT, Math.min(total - MIN_SPECTROGRAM_DISPLAY_HEIGHT, nextWav));
            this.waveformDisplayHeight = nextWav;
            this.spectrogramDisplayHeight = total - nextWav;
            redrawWav = true;
        } else {
            this.spectrogramDisplayHeight = Math.max(
                MIN_SPECTROGRAM_DISPLAY_HEIGHT,
                ctx.resizeStartSpectrogramH + dy,
            );
        }

        this._applyLocalViewHeights();
        if (redrawWav) this._updateAmplitudeLabels();
        if (!this.audioBuffer) return;
        this._queueResizeRedraw({
            redrawWaveform: redrawWav,
            redrawSpectrogram: this.spectrogramData && this.spectrogramFrames > 0,
        });
    }

    _stopViewResize() {
        if (!this.interaction.isViewResize) return;
        this._flushResizeRedraw(true);
        this.interaction.release();
        document.body.style.cursor = '';
    }

    _queueResizeRedraw({ redrawWaveform = false, redrawSpectrogram = false } = {}) {
        this._viewResizeNeedsWaveformRedraw = this._viewResizeNeedsWaveformRedraw || redrawWaveform;
        this._viewResizeNeedsSpectrogramRedraw = this._viewResizeNeedsSpectrogramRedraw || redrawSpectrogram;
        if (this._viewResizeFrameId) return;
        this._viewResizeFrameId = requestAnimationFrame(() => this._flushResizeRedraw(false));
    }

    _flushResizeRedraw(force) {
        if (!this.audioBuffer) return;
        if (this._viewResizeFrameId) {
            cancelAnimationFrame(this._viewResizeFrameId);
            this._viewResizeFrameId = 0;
        }

        const redrawWaveform = force || this._viewResizeNeedsWaveformRedraw;
        const redrawSpectrogram = force || this._viewResizeNeedsSpectrogramRedraw;
        this._viewResizeNeedsWaveformRedraw = false;
        this._viewResizeNeedsSpectrogramRedraw = false;

        const savedScroll = this._getPrimaryScrollLeft();
        if (redrawWaveform) this._drawMainWaveform();
        if (redrawSpectrogram) this._drawSpectrogram();
        this._setLinkedScrollLeft(savedScroll);
        this._emit('viewresize', {
            waveformHeight: this.waveformDisplayHeight,
            spectrogramHeight: this.spectrogramDisplayHeight,
        });
    }

    // ═════════════════════════════════════════════════════════════════
    //  UI State Helpers
    // ═════════════════════════════════════════════════════════════════

    _setPlayState(text) {
        this.d.playStateDisplay.textContent = text;
    }

    _shouldCompactToolbarBeActive() {
        if (this._transportOverlay) return false;
        if (this._compactToolbarMode === 'off') return false;
        if (this._compactToolbarMode === 'on') return true;
        const root = this.d.toolbarRoot;
        if (!root) return false;
        const hadActive = this.container.classList.contains('compact-toolbar-active');
        const hadOpen = this.container.classList.contains('compact-toolbar-open');
        if (hadActive) this.container.classList.remove('compact-toolbar-active');
        if (hadOpen) this.container.classList.remove('compact-toolbar-open');
        const needsCompact = root.scrollWidth > root.clientWidth + 4;
        if (hadActive) this.container.classList.add('compact-toolbar-active');
        if (hadOpen) this.container.classList.add('compact-toolbar-open');
        return needsCompact;
    }

    _isCompactToolbarActive() {
        return this.container.classList.contains('compact-toolbar-active');
    }

    _queueCompactToolbarLayoutRefresh() {
        if (this._compactToolbarLayoutRaf) return;
        this._compactToolbarLayoutRaf = requestAnimationFrame(() => {
            this._compactToolbarLayoutRaf = 0;
            this._refreshCompactToolbarLayout();
        });
    }

    _refreshCompactToolbarLayout() {
        const active = this._shouldCompactToolbarBeActive();
        this.container.classList.toggle('compact-toolbar-active', active);
        if (!active && this._compactToolbarOpen) this._setCompactToolbarOpen(false);
        if (this.d.compactMoreBtn) {
            this.d.compactMoreBtn.disabled = !active;
            this.d.compactMoreBtn.setAttribute('aria-hidden', active ? 'false' : 'true');
        }
    }

    _setCompactToolbarOpen(nextOpen) {
        const open = this._isCompactToolbarActive() && !!nextOpen;
        this._compactToolbarOpen = open;
        this.container.classList.toggle('compact-toolbar-open', open);
        if (this.d.compactMoreBtn) this.d.compactMoreBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
    }

    _toggleSettingsPanel() {
        this._setSettingsPanelOpen(!this._settingsPanelOpen);
    }

    _setSettingsPanelOpen(open) {
        this._settingsPanelOpen = !!open;
        this.container.classList.toggle('settings-panel-open', this._settingsPanelOpen);
        if (this.d.settingsToggleBtn) {
            this.d.settingsToggleBtn.classList.toggle('active', this._settingsPanelOpen);
            this.d.settingsToggleBtn.setAttribute('aria-expanded', this._settingsPanelOpen ? 'true' : 'false');
        }
    }

    /** Apply a DSP preset (fills all controls, triggers regeneration). */
    _applyPreset(name) {
        const p = DSP_PROFILES[name];
        if (!p) return;
        // Scale
        if (this.d.scaleSelect) this.d.scaleSelect.value = p.spectrogramMode === 'classic' ? 'linear' : 'mel';
        // FFT
        if (this.d.fftSizeSelect) this.d.fftSizeSelect.value = String(p.fftSize);
        // Window function
        if (this.d.windowFunctionSelect) this.d.windowFunctionSelect.value = p.windowFunction;
        // nMels
        if (this.d.nMelsInput) this.d.nMelsInput.value = String(p.nMels);
        // PCEN
        if (this.d.pcenGainInput) this.d.pcenGainInput.value = String(p.pcenGain);
        if (this.d.pcenBiasInput) this.d.pcenBiasInput.value = String(p.pcenBias);
        if (this.d.pcenRootInput) this.d.pcenRootInput.value = String(p.pcenRoot);
        if (this.d.pcenSmoothingInput) this.d.pcenSmoothingInput.value = String(p.pcenSmoothing);
        // Color palette
        const palette = p.spectrogramMode === 'classic' ? 'xenocanto' : 'grayscale';
        if (this.d.colorSchemeSelect) { this.d.colorSchemeSelect.value = palette; this.currentColorScheme = palette; }
        // Highlight active preset button
        this.d.presetPerchBtn?.classList.toggle('active', name === 'perch');
        this.d.presetClassicBtn?.classList.toggle('active', name === 'classic');
        this._updatePcenSectionVisibility();
        if (this.audioBuffer) this._generateSpectrogram();
    }

    _clearPresetHighlight() {
        this.d.presetPerchBtn?.classList.remove('active');
        this.d.presetClassicBtn?.classList.remove('active');
    }

    _updatePcenSectionVisibility() {
        if (this.d.pcenSection) {
            const isMel = (this.d.scaleSelect?.value || 'mel') === 'mel';
            this.d.pcenSection.style.display = isMel ? '' : 'none';
        }
    }

    _setTransportEnabled(enabled) {
        [
            this.d.playPauseBtn, this.d.stopBtn,
            this.d.jumpStartBtn, this.d.jumpEndBtn,
            this.d.backwardBtn, this.d.forwardBtn,
            this.d.followToggleBtn, this.d.loopToggleBtn,
            this.d.crosshairToggleBtn,
            this.d.fitViewBtn, this.d.resetViewBtn,
            this.d.autoContrastBtn, this.d.autoFreqBtn,
        ].forEach((btn) => { btn.disabled = !enabled; });
        this._queueCompactToolbarLayoutRefresh();
    }

    _updateToggleButtons() {
        this.followPlayback = this.followMode !== 'free';
        if (this.d.followToggleBtn) {
            this.d.followToggleBtn.classList.toggle('active', this.followPlayback);
            this.d.followToggleBtn.textContent = this.followMode === 'smooth'
                ? 'Smooth'
                : (this.followPlayback ? 'Follow' : 'Free');
            this.d.followToggleBtn.title = this.followMode === 'smooth'
                ? 'Smooth follow (continuous)'
                : (this.followPlayback ? 'Follow playhead' : 'Free navigation');
        }
        if (this.d.loopToggleBtn) {
            this.d.loopToggleBtn.classList.toggle('active', this.loopPlayback);
            this.d.loopToggleBtn.textContent = this.loopPlayback ? 'Loop On' : 'Loop';
        }
        this._queueCompactToolbarLayoutRefresh();
    }

    _cycleFollowMode() {
        this.followMode = this.followMode === 'free'
            ? 'follow'
            : this.followMode === 'follow'
                ? 'smooth'
                : 'free';
        if (this.followMode !== 'follow') this._cancelFollowCatchupAnimation();
        this._updateToggleButtons();
        this._emit('followmodechange', { mode: this.followMode });
    }

    // ─── Crosshair ─────────────────────────────────────────────────

    _toggleCrosshair() {
        this._crosshairEnabled = !this._crosshairEnabled;
        if (this.d.crosshairToggleBtn) {
            this.d.crosshairToggleBtn.classList.toggle('active', this._crosshairEnabled);
        }
        if (!this._crosshairEnabled) this._hideCrosshair();
    }

    /** @param {MouseEvent} e */
    _updateCrosshair(e) {
        if (!this._crosshairEnabled || !this.audioBuffer || !this.spectrogramData) return;
        const wrapper = this.d.canvasWrapper;
        const overlay = this.d.crosshairCanvas;
        const readout = this.d.crosshairReadout;
        if (!wrapper || !overlay || !readout) return;

        const rect = wrapper.getBoundingClientRect();
        const c = this.coords;
        const { time, freq, canvasX, canvasY, localX, localY } =
            c.clientToTimeFreq(e.clientX, e.clientY, rect, wrapper.scrollLeft);

        // Out of bounds?
        if (localX < 0 || localX > rect.width || localY < 0 || localY > rect.height) {
            this._hideCrosshair();
            return;
        }

        // Amplitude at this position
        const frame = c.timeToFrame(time, this.spectrogramFrames);
        const bin = c.pixelYToBin(canvasY);
        const amplitude = this.spectrogramData[frame * this.spectrogramMels + bin] || 0;

        // Draw crosshair lines on overlay canvas
        if (this._crosshairRafId) cancelAnimationFrame(this._crosshairRafId);
        this._crosshairRafId = requestAnimationFrame(() => {
            this._crosshairRafId = 0;
            this._drawCrosshairLines(overlay, canvasX, canvasY, c.canvasWidth, c.canvasHeight);
        });

        // Format readout
        const mode = c.spectrogramMode;
        const timeStr = time.toFixed(3) + ' s';
        const freqStr = freq >= 1000 ? (freq / 1000).toFixed(2) + ' kHz' : Math.round(freq) + ' Hz';
        const isLinear = (this.d.scaleSelect?.value || 'mel') === 'linear';
        const ampStr = isLinear
            ? amplitude.toFixed(1) + ' dB'
            : amplitude.toFixed(4);
        readout.textContent = `${timeStr}  |  ${freqStr}  |  ${ampStr}`;
        readout.classList.add('visible');

        // Position readout near cursor but keep inside viewport
        const rw = readout.offsetWidth || 160;
        const rh = readout.offsetHeight || 20;
        let rx = localX + 14;
        let ry = localY - rh - 8;
        if (rx + rw > rect.width) rx = localX - rw - 10;
        if (ry < 0) ry = localY + 18;
        readout.style.left = (wrapper.scrollLeft + rx) + 'px';
        readout.style.top = ry + 'px';
    }

    /**
     * @param {HTMLCanvasElement} overlay
     * @param {number} cx - x in canvas coords
     * @param {number} cy - y in canvas coords
     * @param {number} w
     * @param {number} h
     */
    _drawCrosshairLines(overlay, cx, cy, w, h) {
        if (overlay.width !== w || overlay.height !== h) {
            overlay.width = w;
            overlay.height = h;
        }
        const ctx = overlay.getContext('2d');
        if (!ctx) return;
        ctx.clearRect(0, 0, w, h);

        ctx.strokeStyle = 'rgba(255, 255, 255, 0.55)';
        ctx.lineWidth = 1;
        ctx.setLineDash([4, 4]);

        // Vertical line
        const x = Math.round(cx) + 0.5;
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, h);
        ctx.stroke();

        // Horizontal line
        const y = Math.round(cy) + 0.5;
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(w, y);
        ctx.stroke();

        ctx.setLineDash([]);
    }

    _hideCrosshair() {
        const overlay = this.d.crosshairCanvas;
        const readout = this.d.crosshairReadout;
        if (overlay) {
            const ctx = overlay.getContext('2d');
            if (ctx) ctx.clearRect(0, 0, overlay.width, overlay.height);
        }
        if (readout) readout.classList.remove('visible');
        if (this._crosshairRafId) {
            cancelAnimationFrame(this._crosshairRafId);
            this._crosshairRafId = 0;
        }
    }

    _cancelFollowCatchupAnimation() {
        if (this._followCatchupRafId) {
            cancelAnimationFrame(this._followCatchupRafId);
            this._followCatchupRafId = 0;
        }
        this._followCatchupAnim = null;
    }

    _animateFollowCatchupTo(targetScrollLeft) {
        if (!this.audioBuffer) return;
        const vw = this._getViewportWidth();
        const tw = Math.max(1, Math.floor(this.audioBuffer.duration * this.pixelsPerSecond));
        const maxScroll = Math.max(0, tw - vw);
        const target = Math.max(0, Math.min(maxScroll, targetScrollLeft));
        const start = this._getPrimaryScrollLeft();
        const delta = target - start;
        if (Math.abs(delta) < 1) return;

        const now = performance.now();
        const inSeekFocus = now < this._smoothSeekFocusUntil;
        const duration = inSeekFocus
            ? this._playbackViewportConfig.followCatchupSeekDurationMs
            : this._playbackViewportConfig.followCatchupDurationMs;

        if (this._followCatchupAnim) {
            const pending = this._followCatchupAnim.target;
            if (Math.abs(pending - target) < 6) return;
        }

        this._cancelFollowCatchupAnimation();
        this._followCatchupAnim = { start, target, startedAt: now, duration };
        const easeOutCubic = (t) => 1 - ((1 - t) ** 3);

        const tick = (ts) => {
            const anim = this._followCatchupAnim;
            if (!anim) return;
            const t = Math.max(0, Math.min(1, (ts - anim.startedAt) / Math.max(1, anim.duration)));
            const eased = easeOutCubic(t);
            const next = anim.start + (anim.target - anim.start) * eased;
            this._setLinkedScrollLeft(next);
            if (t >= 1) {
                this._cancelFollowCatchupAnimation();
                return;
            }
            this._followCatchupRafId = requestAnimationFrame(tick);
        };
        this._followCatchupRafId = requestAnimationFrame(tick);
    }

    _applySmoothFollow(position, viewportWidth) {
        const vw = Math.max(1, viewportWidth || this._getViewportWidth());
        const totalWidth = this.audioBuffer ? Math.max(1, Math.floor(this.audioBuffer.duration * this.pixelsPerSecond)) : 0;
        const maxScroll = Math.max(0, totalWidth - vw);
        const target = Math.max(0, Math.min(maxScroll, position - vw * this._playbackViewportConfig.followTargetRatio));
        const current = this._getPrimaryScrollLeft();
        const delta = target - current;
        if (Math.abs(delta) < 0.6) return;
        const inSeekFocus = performance.now() < this._smoothSeekFocusUntil;
        const lerp = inSeekFocus ? this._playbackViewportConfig.smoothSeekLerp : this._playbackViewportConfig.smoothLerp;
        const minStep = inSeekFocus ? vw * this._playbackViewportConfig.smoothSeekMinStepRatio : vw * this._playbackViewportConfig.smoothMinStepRatio;
        const step = Math.sign(delta) * Math.min(Math.abs(delta), Math.max(minStep, Math.abs(delta) * lerp, 1));
        this._setLinkedScrollLeft(current + step);
    }

    _setInitialPlayheadPositions() {
        this.d.playhead.style.left = '0px';
        this.d.waveformPlayhead.style.left = '0px';
        this.d.playhead.style.transform = 'translateX(0px)';
        this.d.waveformPlayhead.style.transform = 'translateX(0px)';
    }

    // ═════════════════════════════════════════════════════════════════
    //  Keyboard
    // ═════════════════════════════════════════════════════════════════

    _handleKeyboardShortcuts(event) {
        if (!this.audioBuffer || isTypingContext(event.target)) return;

        switch (event.code) {
            case 'Space':
                event.preventDefault();
                this._togglePlayPause();
                break;
            case 'Home':
                event.preventDefault();
                this._seekToTime(0, true);
                break;
            case 'End':
                event.preventDefault();
                this._seekToTime(this.audioBuffer.duration, true);
                break;
            case 'KeyJ':
                event.preventDefault();
                this._seekByDelta(-SEEK_COARSE_SEC);
                break;
            case 'KeyL':
                event.preventDefault();
                this._seekByDelta(SEEK_COARSE_SEC);
                break;
            case 'ArrowLeft':
                event.preventDefault();
                this._seekByDelta(-SEEK_FINE_SEC);
                break;
            case 'ArrowRight':
                event.preventDefault();
                this._seekByDelta(SEEK_FINE_SEC);
                break;
        }
    }

    // ═════════════════════════════════════════════════════════════════
    //  Event Binding
    // ═════════════════════════════════════════════════════════════════

    _bindEvents() {
        const on = (target, type, fn, opts) => {
            target.addEventListener(type, fn, opts);
            this._cleanups.push(() => target.removeEventListener(type, fn, opts));
        };

        // ── File / transport ──
        on(this.d.openFileBtn, 'click', () => this.d.audioFile.click());
        on(this.d.compactMoreBtn, 'click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            this._setCompactToolbarOpen(!this._compactToolbarOpen);
        });
        on(this.d.settingsToggleBtn, 'click', () => this._toggleSettingsPanel());
        on(this.d.settingsPanelClose, 'click', () => this._setSettingsPanelOpen(false));
        on(this.d.audioFile, 'change', (e) => this._handleFileSelect(e));
        on(this.d.playPauseBtn, 'click', () => this._togglePlayPause());
        on(this.d.stopBtn, 'click', () => this._stopPlayback());
        on(this.d.jumpStartBtn, 'click', () => this._seekToTime(0, true));
        on(this.d.jumpEndBtn, 'click', () => this._seekToTime(this.audioBuffer?.duration ?? 0, true));
        on(this.d.backwardBtn, 'click', () => this._seekByDelta(-SEEK_COARSE_SEC));
        on(this.d.forwardBtn, 'click', () => this._seekByDelta(SEEK_COARSE_SEC));
        on(this.d.followToggleBtn, 'click', () => this._cycleFollowMode());
        on(this.d.loopToggleBtn, 'click', () => { this.loopPlayback = !this.loopPlayback; this._updateToggleButtons(); });
        on(this.d.crosshairToggleBtn, 'click', () => this._toggleCrosshair());
        on(this.d.fitViewBtn, 'click', () => this._fitEntireTrackInView());
        on(this.d.resetViewBtn, 'click', () => {
            this._setPixelsPerSecond(DEFAULT_ZOOM_PPS, true);
            this._setLinkedScrollLeft(0);
            this._syncOverviewWindowToViewport();
        });

        // ── Settings ──
        on(this.d.scaleSelect, 'change', () => {
            // Toggle PCEN section visibility
            this._updatePcenSectionVisibility();
            // Auto-select matching color palette
            if (this.d.scaleSelect.value === 'linear') {
                this.d.colorSchemeSelect.value = 'xenocanto';
                this.currentColorScheme = 'xenocanto';
            } else {
                this.d.colorSchemeSelect.value = 'grayscale';
                this.currentColorScheme = 'grayscale';
            }
            this._clearPresetHighlight();
            if (this.audioBuffer) this._generateSpectrogram();
        });
        on(this.d.presetPerchBtn, 'click', () => this._applyPreset('perch'));
        on(this.d.presetClassicBtn, 'click', () => this._applyPreset('classic'));
        on(this.d.nMelsInput, 'change', () => { this._clearPresetHighlight(); if (this.audioBuffer) this._generateSpectrogram(); });
        on(this.d.pcenGainInput, 'change', () => { this._clearPresetHighlight(); if (this.audioBuffer) this._generateSpectrogram(); });
        on(this.d.pcenBiasInput, 'change', () => { this._clearPresetHighlight(); if (this.audioBuffer) this._generateSpectrogram(); });
        on(this.d.pcenRootInput, 'change', () => { this._clearPresetHighlight(); if (this.audioBuffer) this._generateSpectrogram(); });
        on(this.d.pcenSmoothingInput, 'change', () => { this._clearPresetHighlight(); if (this.audioBuffer) this._generateSpectrogram(); });
        on(this.d.fftSizeSelect, 'change', () => { if (this.audioBuffer) this._generateSpectrogram(); });
        on(this.d.windowSizeSelect, 'change', () => { if (this.audioBuffer) this._generateSpectrogram(); });
        on(this.d.hopSizeSelect, 'change', () => { if (this.audioBuffer) this._generateSpectrogram(); });
        on(this.d.windowFunctionSelect, 'change', () => { if (this.audioBuffer) this._generateSpectrogram(); });
        on(this.d.maxFreqSelect, 'change', () => {
            if (this.audioBuffer && this.spectrogramData && this.spectrogramFrames > 0) {
                this._emit('spectrogramscalechange', { maxFreq: parseFloat(this.d.maxFreqSelect.value) });
                this._updateCoords();
                this._createFrequencyLabels();
                this._buildSpectrogramGrayscale();  // maxFreq affects spatial layout
                this._buildSpectrogramBaseImage();
                this._drawSpectrogram();
            }
        });
        on(this.d.colorSchemeSelect, 'change', () => {
            this.currentColorScheme = this.d.colorSchemeSelect.value;
            if (this.audioBuffer && this.spectrogramData && this.spectrogramFrames > 0) {
                this._buildSpectrogramBaseImage();
                this._drawSpectrogram();
            }
        });
        on(this.d.zoomSlider, 'input', (e) => {
            this._setPixelsPerSecond(parseFloat(e.target.value), false);
            this._requestSpectrogramRedraw();
        });
        on(this.d.zoomSlider, 'change', () => {
            if (this.spectrogramData && this.spectrogramFrames > 0) this._drawSpectrogram();
        });

        // ── Volume ──
        on(this.d.volumeSlider, 'input', (e) => {
            this.muted = false;
            this._setVolume(parseFloat(e.target.value) / 100);
        });
        on(this.d.volumeToggleBtn, 'click', () => this._toggleMute());

        // ── Display Floor / Ceiling (Stage 2 only — fast) ──
        const rebuildDisplay = () => {
            if (!this.spectrogramData || this.spectrogramFrames <= 0) return;
            this._buildSpectrogramBaseImage();
            this._drawSpectrogram();
        };
        on(this.d.floorSlider, 'input', rebuildDisplay);
        on(this.d.ceilSlider, 'input', rebuildDisplay);
        on(this.d.autoContrastBtn, 'click', () => this._autoContrast(true));
        on(this.d.autoFreqBtn, 'click', () => this._autoFrequency(true));

        // ── Canvas interaction ──
        on(this.d.canvasWrapper, 'click', (e) => this._handleCanvasClick(e));
        on(this.d.canvasWrapper, 'mousemove', (e) => this._updateCrosshair(e));
        on(this.d.canvasWrapper, 'mouseleave', () => this._hideCrosshair());
        on(this.d.waveformWrapper, 'click', (e) => this._handleWaveformClick(e));
        on(this.d.canvasWrapper, 'scroll', () => {
            if (this.scrollSyncLock) return;
            if (this._getPrimaryScrollWrapper() !== this.d.canvasWrapper) return;
            this._setLinkedScrollLeft(this.d.canvasWrapper.scrollLeft);
        });
        on(this.d.waveformWrapper, 'scroll', () => {
            if (this.scrollSyncLock) return;
            if (this._getPrimaryScrollWrapper() !== this.d.waveformWrapper) return;
            this._setLinkedScrollLeft(this.d.waveformWrapper.scrollLeft);
        });
        on(this.d.canvasWrapper, 'wheel', (e) => this._handleWheel(e, 'spectrogram'), { passive: false });
        on(this.d.waveformWrapper, 'wheel', (e) => this._handleWheel(e, 'waveform'), { passive: false });
        on(this.d.canvasWrapper, 'keydown', (e) => {
            if (!this.audioBuffer) return;
            if (isTypingContext(e.target)) return;
            switch (e.key) {
                case 'ArrowLeft':
                    e.preventDefault();
                    this._seekByDelta(-SEEK_FINE_SEC);
                    break;
                case 'ArrowRight':
                    e.preventDefault();
                    this._seekByDelta(SEEK_FINE_SEC);
                    break;
                case 'Home':
                    e.preventDefault();
                    this._seekToTime(0, true);
                    break;
                case 'End':
                    e.preventDefault();
                    this._seekToTime(this.audioBuffer.duration, true);
                    break;
                default:
                    break;
            }
        });
        on(this.d.canvasWrapper, 'pointerdown', (e) => this._startViewportPan(e, 'spectrogram'));
        on(this.d.waveformWrapper, 'pointerdown', (e) => this._startViewportPan(e, 'waveform'));

        // ── Playhead drag ──
        on(this.d.playhead, 'pointerdown', (e) => this._startPlayheadDrag(e, 'spectrogram'));
        on(this.d.waveformPlayhead, 'pointerdown', (e) => this._startPlayheadDrag(e, 'waveform'));

        // ── View resize ──
        on(this.d.viewSplitHandle, 'pointerdown', (e) => {
            if (!this._showWaveform || !this._showSpectrogram) return;
            e.preventDefault();
            this._startViewResize('split', e.clientY);
        });
        on(this.d.spectrogramResizeHandle, 'pointerdown', (e) => {
            if (!this._showSpectrogram) return;
            e.preventDefault();
            this._startViewResize('spectrogram', e.clientY);
        });

        // ── Document-level pointer ──
        on(document, 'pointermove', (e) => {
            if (this.interaction.isViewResize) { this._updateViewResize(e.clientY); return; }
            if (this.interaction.isDraggingViewport) this._updateViewportPan(e.clientX);
            if (this.interaction.isDraggingPlayhead) this._seekFromClientX(e.clientX, this.interaction.ctx.playheadSource);
            if (this.interaction.isOverviewDrag) this._updateOverviewDrag(e.clientX);
        });

        const releaseAll = () => {
            this._stopViewResize();
            if (this.interaction.isDraggingViewport) {
                if (this.interaction.ctx.panSuppressClick) this.interaction.blockSeekClicks(50);
                document.body.style.cursor = '';
            }
            if (this.interaction.isOverviewDrag) {
                this._queueOverviewViewportApply(true);
                if (this.interaction.ctx.overviewMoved) this.interaction.blockOverviewClicks(260);
            }
            this.interaction.release();
        };
        on(document, 'pointerup', releaseAll);
        on(document, 'pointercancel', releaseAll);

        // ── Keyboard ──
        on(document, 'keydown', (e) => this._handleKeyboardShortcuts(e));
        on(document, 'keydown', (e) => {
            if (e.key === 'Escape' && this._compactToolbarOpen) this._setCompactToolbarOpen(false);
        });
        on(document, 'pointerdown', (e) => {
            if (!this._compactToolbarOpen) return;
            if (this.d.toolbarRoot?.contains(e.target)) return;
            this._setCompactToolbarOpen(false);
        });

        // ── Overview ──
        on(this.d.overviewHandleLeft, 'pointerdown', (e) => {
            if (!this._showOverview) return;
            e.preventDefault();
            this._startOverviewDrag('left', e.clientX);
        });
        on(this.d.overviewHandleRight, 'pointerdown', (e) => {
            if (!this._showOverview) return;
            e.preventDefault();
            this._startOverviewDrag('right', e.clientX);
        });
        on(this.d.overviewWindow, 'pointerdown', (e) => {
            if (!this._showOverview) return;
            if (e.target === this.d.overviewHandleLeft || e.target === this.d.overviewHandleRight) return;
            e.preventDefault();
            this._startOverviewDrag('move', e.clientX);
        });
        on(this.d.overviewCanvas, 'click', (e) => {
            if (this.interaction.isOverviewClickBlocked()) return;
            if (!this._showOverview) return;
            if (!this.audioBuffer) return;
            const rect = this.d.overviewCanvas.getBoundingClientRect();
            const xNorm = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
            this._seekToTime(xNorm * this.audioBuffer.duration, true);
        });

        // ── Window ──
        on(window, 'resize', () => {
            this._queueCompactToolbarLayoutRefresh();
            if (!this._shouldCompactToolbarBeActive()) this._setCompactToolbarOpen(false);
            if (!this.audioBuffer) return;
            this._drawMainWaveform();
            this._drawOverviewWaveform();
            this._syncOverviewWindowToViewport();
            this._emit('viewresize', {
                waveformHeight: this.waveformDisplayHeight,
                spectrogramHeight: this.spectrogramDisplayHeight,
            });
        });
        on(window, 'beforeunload', () => this.dispose());
    }

    _bindTouchGestures() {
        const bindRecognizer = (element, source) => {
            if (!element) return;
            const rec = new GestureRecognizer(element);
            const offSwipe = rec.on('swipe', ({ dx }) => {
                if (!this.audioBuffer) return;
                this._seekRelative(dx / Math.max(1, this.pixelsPerSecond));
            });
            const offPinch = rec.on('pinch', ({ scale, centerX }) => {
                if (!this.audioBuffer) return;
                // Clamp very noisy scale deltas from touch sensors
                const clampedScale = Math.max(0.85, Math.min(1.15, scale));
                this._zoomByScale(clampedScale, centerX, source);
            });
            const offDoubleTap = rec.on('doubletap', () => {
                if (!this.audioBuffer) return;
                this._fitEntireTrackInView();
            });

            this._cleanups.push(() => {
                offSwipe();
                offPinch();
                offDoubleTap();
                rec.dispose();
            });
        };

        bindRecognizer(this.d.waveformWrapper, 'waveform');
        bindRecognizer(this.d.canvasWrapper, 'spectrogram');
    }
}
