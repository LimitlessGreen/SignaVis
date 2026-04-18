// ═══════════════════════════════════════════════════════════════════════
// PlayerState.js — Central state machine, interaction & event binding
// ═══════════════════════════════════════════════════════════════════════

import {
    DEFAULT_SAMPLE_RATE,
    DEFAULT_ZOOM_PPS,
    DEFAULT_WAVEFORM_HEIGHT, DEFAULT_SPECTROGRAM_DISPLAY_HEIGHT,
    MIN_WAVEFORM_HEIGHT, MIN_SPECTROGRAM_DISPLAY_HEIGHT,
    SEEK_FINE_SEC, SEEK_COARSE_SEC, MIN_WINDOW_NORM,
    PERCH_FRAME_RATE,
} from './constants.js';

import { clamp, formatTime, formatSecondsShort, isTypingContext, escapeHtml, clampNumber } from './utils.js';
import { AudioEngine } from './AudioEngine.js';
import { GestureRecognizer } from './gestures.js';
import { TRANSPORT_STATE_LABELS, canTransitionTransportState } from './transportState.js';
import { InteractionState } from './interactionState.js';
import { CoordinateSystem } from './coordinateSystem.js';

import { computeAmplitudePeak } from './spectrogram.js';
import { PresetManager } from './PresetManager.js';
import { SpectrogramController } from './SpectrogramController.js';
import { FrequencyViewport } from './FrequencyViewport.js';

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
        this._presets = new PresetManager(this.d, {
            onRegenerateSpectrogram: (opts) => { if (this.audioBuffer) this._spectro.generate(opts); },
            onStage1Rebuild: () => {
                if (this._spectro.hasData) {
                    this._spectro.buildGrayscale();
                    this._spectro.buildBaseImage(this._presets.currentColorScheme);
                    this._drawSpectrogram();
                }
            },
        });
        this._presets.populatePresetDropdown();
        this._presets.applyFavouritePresetControls();
        this.WaveSurfer = WaveSurfer;

        // ── AudioEngine: owns WaveSurfer, decoding, segment playback, volume state ──
        this._engine = new AudioEngine(WaveSurfer, { container: this.d.audioEngineHost });

        // ── Map AudioEngine events to PlayerState handlers ──────────────
        this._engine.addEventListener('uiupdate', (e) => this._scheduleUiUpdate(/** @type {CustomEvent} */ (e).detail));
        this._engine.addEventListener('transportstatechange', (e) => {
            const { state, reason } = /** @type {CustomEvent} */ (e).detail;
            this._setTransportState(state, reason);
        });
        this._engine.addEventListener('ready', () => {
            this._lastSelectionEmitAt = 0;
            this._lastSelectionStart = NaN;
            this._lastSelectionEnd = NaN;
        });
        this._engine.addEventListener('timeupdate', (e) => {
            this._perf.timeupdateEvents += 1;
            this._emit('timeupdate', /** @type {CustomEvent} */ (e).detail);
        });
        this._engine.addEventListener('segmentstart', (e) => this._emit('segmentplaystart', /** @type {CustomEvent} */ (e).detail));
        this._engine.addEventListener('segmentend', (e) => this._emit('segmentplayend', /** @type {CustomEvent} */ (e).detail));
        this._engine.addEventListener('segmentloop', (e) => this._emit('segmentloop', /** @type {CustomEvent} */ (e).detail));
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

        // ── Spectrogram pipeline (data + rendering) ──
        this._spectro = new SpectrogramController(this.d, {
            enableProgressive: this.options.enableProgressiveSpectrogram === true,
        });
        this._spectro.addEventListener('transportstatechange', (e) => {
            const { state, reason } = /** @type {CustomEvent} */ (e).detail;
            this._setTransportState(state, reason);
        });
        this._spectro.addEventListener('progress',    (e) => this._emit('progress',     /** @type {CustomEvent} */ (e).detail));
        this._spectro.addEventListener('computetime', (e) => this._emit('computeTime',  /** @type {CustomEvent} */ (e).detail));
        this._spectro.addEventListener('ready',       (e) => this._emit('ready',        /** @type {CustomEvent} */ (e).detail));
        this._spectro.addEventListener('error',       (e) => this._emit('error',        /** @type {CustomEvent} */ (e).detail));
        this._spectro.addEventListener('scalechange', (e) => {
            this._emit('spectrogramscalechange', /** @type {CustomEvent} */ (e).detail);
            this._updateCoords();
            this._createFrequencyLabels();
        });
        this._spectro.addEventListener('needsredraw', () => {
            this._updateCoords();
            this._createFrequencyLabels();
            this._drawSpectrogram();
            this._syncOverviewWindowToViewport();
        });

        // ── Audio / analysis state ──
        // audioBuffer and wavesurfer are owned by this._engine (accessed via getters)
        this.sampleRateHz = DEFAULT_SAMPLE_RATE;
        this.amplitudePeakAbs = 1;
        // volume, muted, preMuteVolume — owned by this._engine (accessed via getters)

        // ── Zoom / viewport ──
        this.pixelsPerSecond = DEFAULT_ZOOM_PPS;
        this._zoomRedrawRafId = 0;
        this.scrollSyncLock = false;
        this.windowStartNorm = 0;
        this.windowEndNorm = 1;

        // ── Vertical frequency zoom viewport ──
        this._freqView = new FrequencyViewport();
        this._freqView.addEventListener('change', () => this._applyFreqViewChange());

        // ── Playback toggles ──
        this.followMode = 'follow'; // 'free' | 'follow' | 'smooth'
        this.followPlayback = true;
        // loopPlayback, playbackMode, _activeSegment*, _suppressNextPauseHandler,
        // _segmentPlayToken, _customSegmentPlayback, _lastTimeupdateEmitAt — owned by this._engine
        this.transportState = '';
        this._smoothSeekFocusUntil = 0;
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

        // ── Restore persisted overview label section state ──
        try {
            if (localStorage.getItem('aw-label-section-collapsed') === '1') {
                this._toggleOverviewLabelSection(true);
            }
        } catch {}

        if (this.options.enableTouchGestures !== false) {
            this._bindTouchGestures();
        }
        this._refreshCompactToolbarLayout();
        this._presets.updatePcenSectionDimming();
        requestAnimationFrame(() => this._refreshCompactToolbarLayout());
    }

    _emit(event, detail = {}) {
        if (!this._emitHostEvent) return;
        this._emitHostEvent(event, detail);
    }

    // ─── AudioEngine pass-through getters/setters ────────────────────
    // AudioEngine is the source of truth for all audio state.
    // These getters keep the rest of PlayerState working without renaming.

    get audioBuffer()               { return this._engine.audioBuffer; }
    get wavesurfer()                { return this._engine.wavesurfer; }
    get volume()                    { return this._engine.volume; }
    get muted()                     { return this._engine.muted; }
    get preMuteVolume()             { return this._engine.preMuteVolume; }
    get playbackMode()              { return this._engine.playbackMode; }
    get loopPlayback()              { return this._engine.loopPlayback; }
    get _activeSegmentStart()       { return this._engine._activeSegmentStart; }
    get _activeSegmentEnd()         { return this._engine._activeSegmentEnd; }
    get _customSegmentPlayback()    { return this._engine._customSegmentPlayback; }

    set muted(v)                     { this._engine.muted = v; }
    set loopPlayback(v)              { this._engine.loopPlayback = v; }

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
            return;
        }
        this.transportState = nextState;
        this._updatePlayPauseButton();
        this._perf.transitionEvents += 1;
        this._perf.lastTransition = `${fromState || '∅'} → ${nextState}${reason ? ` (${reason})` : ''}`;
        this._setPlayState(TRANSPORT_STATE_LABELS[nextState] || nextState);
        this._emit('transportstatechange', { state: nextState, reason });
    }

    _updatePlayPauseButton() {
        const isPlaying = this.transportState === 'playing'
            || this.transportState === 'playing_loop'
            || this.transportState === 'playing_segment';
        this.d.playPauseBtn?.classList.toggle('playing', isPlaying);
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
        const t = clamp(pending.time || 0, 0, duration || pending.time || 0);
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
            canvasSizer:            q('canvasSizer'),
            viewSplitHandle:        q('viewSplitHandle'),
            spectrogramResizeHandle:q('spectrogramResizeHandle'),
            overviewCanvas:         q('overviewCanvas'),
            overviewContainer:      q('overviewContainer'),
            overviewWindow:         q('overviewWindow'),
            overviewHandleLeft:     q('overviewHandleLeft'),
            overviewHandleRight:    q('overviewHandleRight'),
            overviewLabelTracks:    q('overviewLabelTracks'),
            overviewLabelSection:   q('overviewLabelSection'),
            overviewLabelToggle:    q('overviewLabelToggle'),
            fileInfo:               q('fileInfo'),
            sampleRateInfo:         q('sampleRateInfo'),
            scaleSelect:            q('scaleSelect'),
            colourScaleSelect:      q('colourScaleSelect'),
            presetSelect:           q('presetSelect'),
            presetSaveBtn:          q('presetSaveBtn'),
            presetFavBtn:           q('presetFavBtn'),
            presetManageBtn:        q('presetManageBtn'),
            presetSaveRow:          q('presetSaveRow'),
            presetSaveInput:        q('presetSaveInput'),
            presetSaveConfirm:      q('presetSaveConfirm'),
            presetSaveCancel:       q('presetSaveCancel'),
            presetManagerPanel:     q('presetManagerPanel'),
            presetManagerList:      q('presetManagerList'),
            presetImportBtn:        q('presetImportBtn'),
            presetExportBtn:        q('presetExportBtn'),
            presetStatus:           q('presetStatus'),
            nMelsInput:             q('nMelsInput'),
            pcenGainInput:          q('pcenGainInput'),
            pcenBiasInput:          q('pcenBiasInput'),
            pcenRootInput:          q('pcenRootInput'),
            pcenSmoothingInput:     q('pcenSmoothingInput'),
            pcenEnabledCheck:       q('pcenEnabledCheck'),
            pcenSection:            q('pcenSection'),
            windowSizeSelect:       q('windowSize'),
            windowFunctionSelect:   q('windowFunction'),
            overlapSelect:          q('overlapSelect'),
            oversamplingSelect:     q('oversamplingSelect'),
            reassignedCheck:        q('reassignedCheck'),
            noiseReductionCheck:    q('noiseReductionCheck'),
            claheCheck:             q('claheCheck'),
            qualitySlider:          q('qualitySlider'),
            qualityLevelDisplay:    q('qualityLevelDisplay'),
            zoomSlider:             q('zoomSlider'),
            zoomValue:              q('zoomValue'),
            maxFreqModeSelect:      q('maxFreqModeSelect'),
            maxFreqSelect:          q('maxFreqSelect'),
            colorSchemeSelect:      q('colorSchemeSelect'),
            freqLabels:             q('freqLabels'),
            freqZoomResetBtn:       q('freqZoomResetBtn'),
            freqAxisSpacer:         q('freqAxisSpacer'),
            freqZoomSlider:         q('freqZoomSlider'),
            freqScrollbar:          q('freqScrollbar'),
            freqScrollbarThumb:     q('freqScrollbarThumb'),
            volumeToggleBtn:        q('volumeToggleBtn'),
            volumeIcon:             q('volumeIcon'),
            volumeWaves:            q('volumeWaves'),
            volumeSlider:           q('volumeSlider'),
            gainModeSelect:         q('gainModeSelect'),
            floorSlider:            q('floorSlider'),
            ceilSlider:             q('ceilSlider'),
            autoContrastBtn:        q('autoContrastBtn'),
            autoFreqBtn:            q('autoFreqBtn'),
            crosshairToggleBtn:     q('crosshairToggleBtn'),
            crosshairCanvas:        q('crosshairCanvas'),
            crosshairReadout:       q('crosshairReadout'),
            recomputingOverlay:     q('recomputingOverlay'),
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
        this._presets.dispose();
        this._spectro.destroy();
        this._engine.destroy();
    }

    // ═════════════════════════════════════════════════════════════════
    //  File Loading
    // ═════════════════════════════════════════════════════════════════

    async _handleFileSelect(e) {
        const file = e?.target?.files?.[0];
        if (!file) return;
        await this.loadFile(file);
    }

    async loadFile(file) {
        if (!file) return;

        this.d.fileInfo.innerHTML = `<span class="statusbar-label">${escapeHtml(file.name)}</span>`;
        this.d.fileInfo.classList.add('loading');
        this._setTransportState('loading', 'file-load');

        try {
            const result = await this._engine.loadFromFile(file);
            await this._onAudioLoaded(result, file.name, 'file-loaded');
        } catch (error) {
            this._onAudioLoadError(error, 'file');
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
            const result = await this._engine.loadFromUrl(url);
            const name = decodeURIComponent(
                new URL(url, location.href).pathname.split('/').pop() || 'audio',
            );
            await this._onAudioLoaded(result, name, 'url-loaded');
        } catch (error) {
            this._onAudioLoadError(error, 'url');
            throw error;
        }
    }

    async _onAudioLoaded({ duration, sampleRate }, displayName, readyReason) {
        this.sampleRateHz = sampleRate;
        this.amplitudePeakAbs = this._engine.audioBuffer ? computeAmplitudePeak(this._engine.audioBuffer.getChannelData(0)) : 0;
        this._updateAmplitudeLabels();
        this._spectro.setAudio(this._engine.audioBuffer, sampleRate);
        this._spectro.updateMaxFreqOptions(sampleRate);

        this.d.fileInfo.innerHTML = `<span class="statusbar-label">${escapeHtml(displayName)}</span> <span>${formatTime(duration)}</span>`;
        this.d.sampleRateInfo.textContent = `${sampleRate} Hz`;
        this.d.totalTimeDisplay.textContent = formatTime(duration);
        this.d.currentTimeDisplay.textContent = formatTime(0);

        this._setPixelsPerSecond(DEFAULT_ZOOM_PPS, false);
        this._setTransportEnabled(true);
        this._updateToggleButtons();
        this._setTransportState('ready', readyReason);
        this.d.fileInfo.classList.remove('loading');

        await this._spectro.generate({ autoAdjust: true });
        this._drawMainWaveform();
        this._drawOverviewWaveform();
        this._createFrequencyLabels();
        this._seekToTime(0, true);
    }

    _onAudioLoadError(error, source) {
        console.error(`Error loading audio (${source}):`, error);
        this._setTransportState('error', `${source}-load-failed`);
        this.d.fileInfo.classList.remove('loading');
        this._emit('error', { message: error?.message || String(error), source });
    }

    // ═════════════════════════════════════════════════════════════════
    //  Transport Controls
    // ═════════════════════════════════════════════════════════════════

    _togglePlayPause() { this._engine.playPause(); }

    _stopPlayback() { this._engine.stop(); }

    playSegment(startSec, endSec, options = {}) {
        this._engine.playSegment(startSec, endSec, options);
    }

    playBandpassedSegment(startSec, endSec, freqMinHz, freqMaxHz, options = {}) {
        this._engine.playBandpassedSegment(startSec, endSec, freqMinHz, freqMaxHz, options);
    }

    updateActiveSegmentFromLabel(label) {
        this._engine.updateActiveSegmentFromLabel(label);
    }

    /**
     * Stop any custom segment playback.
     * @param {string} [reason]
     * @param {number|null} [targetTimeSec]
     */
    _stopCustomSegmentPlayback(reason = 'stopped', targetTimeSec = null) {
        this._engine.stopSegmentPlayback(reason, targetTimeSec);
    }

    _clearPlaybackFilter() {
        this._engine._clearPlaybackFilter();
    }

    _seekToTime(timeSec, centerView = false, options = {}) {
        if (!this.audioBuffer) return;
        if (options.userInitiated) {
            this._smoothSeekFocusUntil = performance.now() + this._playbackViewportConfig.smoothSeekFocusMs;
        }
        // Delegate to engine — handles custom segment stop, clamp, wavesurfer.setTime, onUiUpdate
        this._engine.seekToTime(timeSec, centerView, options);
    }

    _seekByDelta(deltaSec) {
        if (!this.audioBuffer) return;
        this._seekToTime(this._getCurrentTime() + deltaSec, false);
    }

    _getCurrentTime() { return this._engine.getCurrentTime(); }

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
        const now = clamp(currentTimeSec || 0, 0, duration || currentTimeSec || 0);
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

        const position = this.coords.timeToScrollX(currentTime);

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
            this._engine.endNormalSegment(end);
            this._setTransportState('stopped', 'segment-end');
            this._emit('segmentplayend', { end });
        }
    }

    // ═════════════════════════════════════════════════════════════════
    //  Spectrogram — thin wrappers around SpectrogramController
    // ═════════════════════════════════════════════════════════════════

    /** Build draw-params object from current viewport/layout state. */
    _getSpectrogramDrawParams() {
        return {
            show:           this._showSpectrogram,
            pixelsPerSecond: this.pixelsPerSecond,
            freqViewMin:    this._freqView.min,
            freqViewMax:    this._freqView.max,
            coords:         this.coords,
            effectiveHeight: this._getEffectiveSpectrogramHeight(),
            colorScheme:    this._presets.currentColorScheme,
            scrollLeft:     this.d.canvasWrapper?.scrollLeft ?? 0,
            viewportWidth:  this.d.canvasWrapper?.clientWidth ?? 0,
        };
    }

    /** Render the spectrogram with current viewport state. */
    _drawSpectrogram() {
        if (!this._showSpectrogram) return;
        if (!this._spectro.hasData) return;
        this._spectro.draw(this._getSpectrogramDrawParams());
        this._updateCoords();
        this._scheduleUiUpdate({ time: this._getCurrentTime(), fromPlayback: false, immediate: true });
    }

    // The remaining pipeline methods (_generateSpectrogram, _setExternalSpectrogram,
    // _setExternalSpectrogramImage, _autoContrast, _autoFrequency, _buildSpectrogramGrayscale,
    // etc.) now live in SpectrogramController. PlayerState delegates via this._spectro.

    // ── OLD PIPELINE METHODS DELETED — see SpectrogramController.js ──

    // ── Volume ──────────────────────────────────────────────────────

    _setVolume(val) {
        this._engine.setVolume(val);
        this._updateVolumeIcon();
    }

    _toggleMute() {
        this._engine.toggleMute();
        if (!this.muted) {
            this.d.volumeSlider.value = Math.round(this.volume * 100);
        }
        this._updateVolumeIcon();
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

    _requestSpectrogramRedraw() {
        if (this._zoomRedrawRafId) return;
        this._zoomRedrawRafId = requestAnimationFrame(() => {
            this._zoomRedrawRafId = 0;
            if (!this.audioBuffer) return;
            if (this._spectro.hasData) this._drawSpectrogram();
            this._drawMainWaveform();
            // Coords are now in sync with actual canvas dims — notify label layers.
            this._emit('zoomchange', { pixelsPerSecond: this.pixelsPerSecond });
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
        const timelineH = this._showWaveformTimeline ? clamp(Math.round(clampedH * 0.22), 18, 32) : 0;
        const ampH = Math.max(32, clampedH - timelineH);

        const fmt = (v) => {
            const a = Math.abs(v);
            return a >= 1 ? v.toFixed(1) : a >= 0.01 ? v.toFixed(2) : v.toFixed(3);
        };

        // Generate 5 evenly-spaced labels: +peak, +half, 0, -half, -peak
        const values = [peak, peak / 2, 0, -peak / 2, -peak];

        values.forEach((value, i) => {
            const frac = i / (values.length - 1);
            const span = document.createElement('span');
            span.textContent = value === 0 ? '0' : `${value > 0 ? '+' : '\u2212'}${fmt(Math.abs(value))}`;
            span.style.top = `${frac * ampH}px`;
            span.style.transform = `translateY(${-frac * 100}%)`;
            span.style.setProperty('--tick-pos', `${frac * 100}%`);
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
        const tw = this.audioBuffer ? Math.max(1, Math.floor(this.coords.timeToScrollX(this.audioBuffer.duration))) : 0;
        const maxScroll = Math.max(0, tw - vw);
        const bounded = clamp(nextLeft, 0, maxScroll);

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

        const clamped = clamp(nextPps, minPps, maxPps);
        const changed = Math.abs(clamped - this.pixelsPerSecond) >= 0.01;

        const fallbackTime = this.coords.scrollXToTime(this._getPrimaryScrollLeft() + vw / 2);
        const aTime = anchorTime ?? fallbackTime;
        const aPixel = anchorPixel ?? (vw / 2);

        const effectivePps = changed ? clamped : this.pixelsPerSecond;
        const estWidth = duration ? Math.max(1, Math.floor(duration * effectivePps)) : 0;
        const maxScroll = Math.max(0, estWidth - vw);
        const nextScroll = duration ? aTime * effectivePps - aPixel : 0;
        const bounded = clamp(nextScroll, 0, maxScroll);

        if (changed) {
            this.pixelsPerSecond = effectivePps;
            this.d.zoomSlider.value = String(Math.round(effectivePps / sliderStep) * sliderStep);
            this.d.zoomValue.textContent = `${Math.round(effectivePps)} px/s`;

            if (this.wavesurfer) {
                this.wavesurfer.zoom(effectivePps);
            }
            if (this.audioBuffer && redraw) {
                // Redraw BEFORE emitting zoomchange so that canvas dimensions
                // and coords are up-to-date when listeners (e.g. label layers) run.
                if (this._spectro.hasData) this._drawSpectrogram();
                this._drawMainWaveform();
                this._emit('zoomchange', { pixelsPerSecond: this.pixelsPerSecond });
            } else {
                this._updateCoords();
                // zoomchange deferred — canvas dims are stale until the
                // batched _requestSpectrogramRedraw completes the actual redraw.
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
        const localX = clamp(centerClientX - rect.left, 0, rect.width);
        const anchorTime = this.coords.scrollXToTime(wrapper.scrollLeft + localX);
        this._setPixelsPerSecond(this.pixelsPerSecond * scale, true, anchorTime, localX);
    }

    _centerViewportAtTime(timeSec) {
        if (!this.audioBuffer) return;
        const vw = this._getViewportWidth();
        const viewDur = this.coords.scrollXToTime(vw);
        let start = timeSec - viewDur / 2;
        start = clamp(start, 0, Math.max(0, this.audioBuffer.duration - viewDur));
        this._setLinkedScrollLeft(this.coords.timeToScrollX(start));
    }

    _clientXToTime(clientX, source = 'spectrogram') {
        const wrapper = source === 'waveform' ? this.d.waveformWrapper : this.d.canvasWrapper;
        const rect = wrapper.getBoundingClientRect();
        const scrollX = clientX - rect.left + wrapper.scrollLeft;
        const dur = this.audioBuffer?.duration || 0;
        const t = this.coords.scrollXToTime(scrollX);
        return clamp(t, 0, dur);
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
            Math.floor(this.coords.timeToScrollX(this.audioBuffer.duration)),
        );
        if (trackWidth <= 0) return;

        const vw = this._getViewportWidth();
        const viewTime = this.coords.scrollXToTime(vw);
        const startTime = this.coords.scrollXToTime(this._getPrimaryScrollLeft());
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
        if (cw <= 0) return;
        const minW = 8;
        let left = this.windowStartNorm * cw;
        let width = Math.max(minW, this.windowEndNorm * cw - left);
        // Prevent min-width from pushing the window beyond the container
        if (left + width > cw) left = Math.max(0, cw - width);
        this.d.overviewWindow.style.left = `${left}px`;
        this.d.overviewWindow.style.width = `${width}px`;
    }

    _getOverviewSpanConstraints() {
        const duration = Math.max(0.001, this.audioBuffer?.duration || 0.001);
        const vw = Math.max(1, this._getViewportWidth());
        const minPps = Math.max(1, Number(this.d.zoomSlider?.min || 20));
        const maxPps = Math.max(minPps, Number(this.d.zoomSlider?.max || 450));
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
            this.windowStartNorm = clamp(nextStart, minStart, maxStart);
            this.windowEndNorm = right;
        } else if (sub === 'right') {
            const nextEnd = fixedEnd + deltaNorm;
            const left = fixedStart;
            const minEnd = Math.min(1, left + minSpanNorm);
            const maxEnd = Math.min(1, left + maxSpanNorm);
            this.windowEndNorm = clamp(nextEnd, minEnd, maxEnd);
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
                // Draw inline (same frame) so the spectrogram update is
                // synchronous with the scroll — matching the native scrollbar path.
                if (this._spectro.hasData) this._drawSpectrogram();
                this._drawMainWaveform();
                this._emit('zoomchange', { pixelsPerSecond: this.pixelsPerSecond });
            }
        });
    }

    _toggleOverviewLabelSection(force) {
        const section = this.d.overviewLabelSection;
        const btn     = this.d.overviewLabelToggle;
        if (!section) return;
        const collapsed = force !== undefined ? force : !section.classList.contains('collapsed');
        section.classList.toggle('collapsed', collapsed);
        if (btn) btn.setAttribute('aria-expanded', String(!collapsed));
        try { localStorage.setItem('aw-label-section-collapsed', collapsed ? '1' : '0'); } catch {}
        // Collapsing/expanding changes layout height — trigger spectrogram resize handling.
        requestAnimationFrame(() => {
            this._invalidateSpectrogramHeightCache?.();
            if (this.audioBuffer) {
                if (this._spectro.hasData) this._drawSpectrogram();
                this._drawMainWaveform();
            }
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
        this.interaction.ctx.panStartY = event.clientY;
        this.interaction.ctx.panStartScroll = source === 'waveform'
            ? this.d.waveformWrapper.scrollLeft
            : this.d.canvasWrapper.scrollLeft;
        this.interaction.ctx.panStartFreqViewMin = this._freqView.min;
        this.interaction.ctx.panStartFreqViewMax = this._freqView.max;
        this.interaction.ctx.panIsMiddle = event.button === 1;
        this.interaction.ctx.panSource = source;
        document.body.style.cursor = 'grabbing';
    }

    _updateViewportPan(clientX, clientY) {
        const dx = clientX - this.interaction.ctx.panStartX;
        const dy = clientY - (this.interaction.ctx.panStartY || 0);
        this.interaction.ctx.panSuppressClick = Math.abs(dx) > 3 || Math.abs(dy) > 3;
        this._setLinkedScrollLeft(this.interaction.ctx.panStartScroll - dx);

        // Middle mouse: also pan vertically
        if (this.interaction.ctx.panIsMiddle && this.interaction.ctx.panSource !== 'waveform'
            && this._showSpectrogram && this._freqView.isZoomed) {
            const wrapper = this.d.canvasWrapper;
            const height = wrapper?.getBoundingClientRect().height || 1;
            const boundedMax = this.coords.boundedMaxFreq;
            const startMin = this.interaction.ctx.panStartFreqViewMin ?? 0;
            const startMax = this.interaction.ctx.panStartFreqViewMax ?? boundedMax;
            const range = startMax - startMin;
            // dy positive = mouse moves down = pan view down (show higher freqs)
            const deltaHz = (dy / height) * range;
            let newMin = startMin + deltaHz;
            let newMax = startMax + deltaHz;
            if (newMin < 0) { newMin = 0; newMax = range; }
            if (newMax > boundedMax) { newMax = boundedMax; newMin = boundedMax - range; }
            this._freqView.set(Math.max(0, newMin), Math.min(boundedMax, newMax));
        }
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
        const timeAtCursor = this.coords.scrollXToTime(wrapper.scrollLeft + localX);

        if (event.ctrlKey || event.metaKey) {
            event.preventDefault();
            const factor = event.deltaY < 0 ? 1.12 : 1 / 1.12;
            this._setPixelsPerSecond(this.pixelsPerSecond * factor, true, timeAtCursor, localX);
            return;
        }

        // Shift + Wheel = vertical frequency zoom (spectrogram only)
        if (event.shiftKey && source !== 'waveform' && this._showSpectrogram) {
            event.preventDefault();
            const localY = event.clientY - rect.top;
            const canvasY = (localY / Math.max(1, rect.height))
                * (this.d.spectrogramCanvas?.height || rect.height);
            const freqAtCursor = this.coords.pixelYToFrequency(canvasY);
            const zoomIn = event.deltaY < 0;
            this._freqView.zoom(zoomIn ? 1.15 : 1 / 1.15, freqAtCursor, this.coords.boundedMaxFreq);
            return;
        }

        if (Math.abs(event.deltaY) > Math.abs(event.deltaX)) {
            event.preventDefault();
            this._setLinkedScrollLeft(Math.max(0, wrapper.scrollLeft + event.deltaY));
        }
    }

    _applyFreqViewChange() {
        this._updateCoords();
        this._drawSpectrogram();
        this._createFrequencyLabels();
        this._scheduleUiUpdate({ time: this._getCurrentTime(), fromPlayback: false, immediate: true });
        // Toggle Y-zoom reset button visibility
        const btn = this.d.freqZoomResetBtn;
        if (btn) btn.hidden = !this._freqView.isZoomed;
        // Update scrollbar
        this._updateFreqScrollbar();
        // Sync slider
        this._syncFreqZoomSlider();
        // Notify annotation layers so they re-render with updated coords
        this._emit('zoomchange', { pixelsPerSecond: this.pixelsPerSecond });
    }

    _updateFreqScrollbar() {
        const bar = this.d.freqScrollbar;
        const thumb = this.d.freqScrollbarThumb;
        if (!bar || !thumb) return;

        if (!this._freqView.isZoomed) {
            bar.hidden = true;
            return;
        }
        bar.hidden = false;
        const boundedMax = this.coords.boundedMaxFreq;
        const viewRange = this._freqView.max - this._freqView.min;
        const thumbFrac = Math.min(1, viewRange / boundedMax);
        // top=0 is highest freq, bottom=100% is 0 Hz
        const topFrac = 1 - this._freqView.max / boundedMax;
        thumb.style.height = `${Math.max(8, thumbFrac * 100)}%`;
        thumb.style.top = `${topFrac * 100}%`;
    }

    _syncFreqZoomSlider() {
        const slider = this.d.freqZoomSlider;
        if (!slider) return;
        if (!this._freqView.isZoomed) {
            slider.value = '0';
            return;
        }
        const boundedMax = this.coords.boundedMaxFreq;
        const fraction = (this._freqView.max - this._freqView.min) / boundedMax;
        // Inverse of exponential mapping: fraction = 1 - val/100*0.95
        const val = (1 - fraction) / 0.95 * 100;
        slider.value = String(clamp(Math.round(val), 0, 100));
    }

    // ═════════════════════════════════════════════════════════════════
    //  View Resize
    // ═════════════════════════════════════════════════════════════════

    _applyLocalViewHeights() {
        const overlaySingleWaveform = this._transportOverlay && this._showWaveform && !this._showSpectrogram;
        const overlaySingleSpectrogram = this._transportOverlay && this._showSpectrogram && !this._showWaveform;
        const waveformFlexes = this._showWaveform && !this._showSpectrogram;

        if (this._showWaveform) {
            if (overlaySingleWaveform || waveformFlexes) {
                if (this.d.waveformContainer) {
                    this.d.waveformContainer.style.height = '';
                    this.d.waveformContainer.style.minHeight = waveformFlexes
                        ? `${Math.round(this.waveformDisplayHeight)}px` : '0';
                }
            } else {
                if (this.d.waveformContainer) {
                    this.d.waveformContainer.style.minHeight = '';
                    this.d.waveformContainer.style.height = `${Math.round(this.waveformDisplayHeight)}px`;
                }
            }
        }
        if (this._showSpectrogram) {
            if (overlaySingleSpectrogram) {
                if (this.d.spectrogramContainer) {
                    this.d.spectrogramContainer.style.height = '';
                    this.d.spectrogramContainer.style.minHeight = '0';
                }
            } else {
                if (this.d.spectrogramContainer) {
                    this.d.spectrogramContainer.style.height = '';
                    this.d.spectrogramContainer.style.minHeight = `${Math.round(this.spectrogramDisplayHeight)}px`;
                }
            }
        }
    }

    _getEffectiveWaveformHeight() {
        if (this._showWaveform && !this._showSpectrogram) {
            const h = this.d.waveformContainer?.clientHeight;
            if (h > 0) return Math.max(MIN_WAVEFORM_HEIGHT, h);
        }
        return Math.max(MIN_WAVEFORM_HEIGHT, Math.floor(this.waveformDisplayHeight));
    }

    _getEffectiveSpectrogramHeight() {
        // Return cached height when available — avoids a forced layout read on
        // every scroll event. Cache is invalidated by _invalidateSpectrogramHeightCache()
        // which is called on resize and spectrogram-height changes.
        if (typeof this._cachedSpectrogramHeight === 'number' && this._cachedSpectrogramHeight > 0) return this._cachedSpectrogramHeight;
        // Use canvasWrapper.clientHeight: excludes horizontal scrollbar height so
        // the canvas doesn't overlap low frequencies when the scrollbar is visible.
        const h = this.d.canvasWrapper?.clientHeight ?? this.d.spectrogramContainer?.clientHeight;
        const result = h > 0
            ? Math.max(MIN_SPECTROGRAM_DISPLAY_HEIGHT, h)
            : Math.max(MIN_SPECTROGRAM_DISPLAY_HEIGHT, Math.floor(this.spectrogramDisplayHeight));
        this._cachedSpectrogramHeight = result;
        return result;
    }

    _invalidateSpectrogramHeightCache() {
        this._cachedSpectrogramHeight = 0;
    }

    /** Rebuild the shared CoordinateSystem whenever any mapping parameter changes. */
    _updateCoords() {
        const extCfg = this._spectro.externalImageConfig;
        // canvasWidth must be the TOTAL spectrogram width (duration × pps), not the
        // viewport-sized canvas element width. pixelXToTime / timeToPixelX rely on
        // canvasWidth representing the full scrollable range.
        const totalSpectrogramWidth = this.audioBuffer
            ? Math.max(1, Math.floor(this.audioBuffer.duration * this.pixelsPerSecond))
            : (this.d.spectrogramCanvas?.width || 0);
        this.coords = new CoordinateSystem({
            duration: this.audioBuffer?.duration || 0,
            sampleRate: this.sampleRateHz,
            pixelsPerSecond: this.pixelsPerSecond,
            canvasWidth: totalSpectrogramWidth,
            canvasHeight: this.d.spectrogramCanvas?.height || 0,
            maxFreq: parseFloat(this.d.maxFreqSelect?.value || '10000'),
            spectrogramMels: this._spectro.nMels,
            scale: this.d.scaleSelect?.value || 'mel',
            frameRate: PERCH_FRAME_RATE,
            hopSize: this._spectro.hopSize || 0,
            freqRange: extCfg?.freqRange || null,
            freqScale: extCfg?.freqScale || null,
            freqViewMin: this._freqView.min,
            freqViewMax: this._freqView.max,
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
            nextWav = clamp(nextWav, MIN_WAVEFORM_HEIGHT, total - MIN_SPECTROGRAM_DISPLAY_HEIGHT);
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
            redrawSpectrogram: this._spectro.hasData,
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
        // Container was resized — cached height is stale.
        this._invalidateSpectrogramHeightCache();

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
        if (!this._crosshairEnabled || !this.audioBuffer || !this._spectro.data) return;
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
        const frame = c.timeToFrame(time, this._spectro.nFrames);
        const bin = c.pixelYToBin(canvasY);
        const amplitude = this._spectro.data[frame * this._spectro.nMels + bin] || 0;

        // Draw crosshair lines on overlay canvas.
        // Canvas is viewport-sized (sticky rendering), so use localX not canvasX.
        if (this._crosshairRafId) cancelAnimationFrame(this._crosshairRafId);
        this._crosshairRafId = requestAnimationFrame(() => {
            this._crosshairRafId = 0;
            const vw = wrapper.clientWidth || c.canvasWidth;
            this._drawCrosshairLines(overlay, localX, canvasY, vw, c.canvasHeight);
        });

        // Format readout
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
        const tw = Math.max(1, Math.floor(this.coords.timeToScrollX(this.audioBuffer.duration)));
        const maxScroll = Math.max(0, tw - vw);
        const target = clamp(targetScrollLeft, 0, maxScroll);
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
            const t = clamp((ts - anim.startedAt) / Math.max(1, anim.duration), 0, 1);
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
        const totalWidth = this.audioBuffer ? Math.max(1, Math.floor(this.coords.timeToScrollX(this.audioBuffer.duration))) : 0;
        const maxScroll = Math.max(0, totalWidth - vw);
        const target = clamp(position - vw * this._playbackViewportConfig.followTargetRatio, 0, maxScroll);
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
        if (this.d.playhead) {
            this.d.playhead.style.left = '0px';
            this.d.playhead.style.transform = 'translateX(0px)';
        }
        if (this.d.waveformPlayhead) {
            this.d.waveformPlayhead.style.left = '0px';
            this.d.waveformPlayhead.style.transform = 'translateX(0px)';
        }
    }

    // ═════════════════════════════════════════════════════════════════
    //  Keyboard
    // ═════════════════════════════════════════════════════════════════

    _handleKeyboardShortcuts(event) {
        // Close compact toolbar on Escape regardless of audio state
        if (event.key === 'Escape' && this._compactToolbarOpen) {
            this._setCompactToolbarOpen(false);
            return;
        }
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
        on(this.d.freqZoomResetBtn, 'click', () => this._freqView.reset());
        on(this.d.fitViewBtn, 'click', () => this._fitEntireTrackInView());
        on(this.d.resetViewBtn, 'click', () => {
            this._setPixelsPerSecond(DEFAULT_ZOOM_PPS, true);
            this._setLinkedScrollLeft(0);
            this._freqView.reset();
            this._syncOverviewWindowToViewport();
        });

        this._bindFreqViewportEvents(on);

        // ── Settings — preset manager, DSP controls, quality slider ──
        // All owned by PresetManager; it calls back via onRegenerateSpectrogram / onStage1Rebuild.
        this._presets.bindEvents(on);
        on(this.d.maxFreqSelect, 'change', () => {
            if (this.audioBuffer && this._spectro.hasData) {
                this._freqView.resetSilent();
                this._emit('spectrogramscalechange', { maxFreq: parseFloat(this.d.maxFreqSelect.value) });
                this._updateCoords();
                this._createFrequencyLabels();
                this._spectro.buildGrayscale();
                this._spectro.buildBaseImage(this._presets.currentColorScheme);
                this._drawSpectrogram();
                if (this.d.freqZoomResetBtn) this.d.freqZoomResetBtn.hidden = true;
            }
        });
        on(this.d.zoomSlider, 'input', (e) => {
            this._setPixelsPerSecond(parseFloat(e.target.value), false);
            this._requestSpectrogramRedraw();
        });
        on(this.d.zoomSlider, 'change', () => {
            if (this._spectro.hasData) this._drawSpectrogram();
        });

        // ── Volume ──
        on(this.d.volumeSlider, 'input', (e) => {
            this.muted = false;
            this._setVolume(parseFloat(e.target.value) / 100);
        });
        on(this.d.volumeToggleBtn, 'click', () => this._toggleMute());

        // ── Display Floor / Ceiling (Stage 2 only — fast) ──
        const rebuildDisplay = () => {
            if (!this._spectro.hasData) return;
            this._spectro.buildBaseImage(this._presets.currentColorScheme);
            this._drawSpectrogram();
        };
        on(this.d.gainModeSelect, 'change', () => {
            this._presets.persistCurrentSettings();
            if (this.d.gainModeSelect.value === 'auto' && this._spectro.data) {
                this._spectro.autoContrast(true);
            }
        });
        on(this.d.maxFreqModeSelect, 'change', () => {
            this._presets.persistCurrentSettings();
            if (!this.audioBuffer) return;
            const mode = this.d.maxFreqModeSelect.value;
            if (mode === 'auto') this._spectro.autoFrequency(true);
            else if (mode === 'nyquist') { this._spectro.setMaxFreqToNyquist(); this._spectro.generate(); }
        });
        on(this.d.floorSlider, 'input', () => { this._presets.persistCurrentSettings(); rebuildDisplay(); });
        on(this.d.ceilSlider, 'input', () => { this._presets.persistCurrentSettings(); rebuildDisplay(); });
        on(this.d.autoContrastBtn, 'click', () => this._spectro.autoContrast(true));
        on(this.d.autoFreqBtn, 'click', () => this._spectro.autoFrequency(true));

        this._bindCanvasInteractionEvents(on);

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
            if (this.interaction.isDraggingViewport) this._updateViewportPan(e.clientX, e.clientY);
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
        on(document, 'pointerdown', (e) => {
            if (!this._compactToolbarOpen) return;
            if (this.d.toolbarRoot?.contains(e.target)) return;
            this._setCompactToolbarOpen(false);
        });

        this._bindOverviewEvents(on);

        // ── Window ──
        on(window, 'resize', () => {
            this._queueCompactToolbarLayoutRefresh();
            if (!this._shouldCompactToolbarBeActive()) this._setCompactToolbarOpen(false);
            if (!this.audioBuffer) return;
            this._invalidateSpectrogramHeightCache();
            this._drawSpectrogram();
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

    /** Frequency viewport — axis drag pan, wheel zoom, zoom slider, scrollbar drag. */
    _bindFreqViewportEvents(on) {
        // ── Freq axis: left-drag = vertical pan ──
        {
            let dragging = false;
            let startY = 0;
            let startMin = 0;
            let startMax = 0;
            const onMove = (e) => {
                if (!dragging) return;
                const spacer = this.d.freqAxisSpacer;
                const spacerH = spacer.getBoundingClientRect().height;
                const dy = e.clientY - startY;
                const boundedMax = this.coords.boundedMaxFreq;
                const range = startMax - startMin;
                const deltaHz = (dy / spacerH) * range;
                let newMin = startMin + deltaHz;
                let newMax = startMax + deltaHz;
                if (newMin < 0) { newMin = 0; newMax = range; }
                if (newMax > boundedMax) { newMax = boundedMax; newMin = boundedMax - range; }
                this._freqView.set(Math.max(0, newMin), Math.min(boundedMax, newMax));
            };
            const onUp = () => {
                if (!dragging) return;
                dragging = false;
                document.body.style.cursor = '';
                document.removeEventListener('pointermove', onMove);
                document.removeEventListener('pointerup', onUp);
            };
            on(this.d.freqAxisSpacer, 'pointerdown', (e) => {
                if (e.button !== 0 || !this._showSpectrogram) return;
                if (!this._freqView.isZoomed) return;
                e.preventDefault();
                dragging = true;
                startY = e.clientY;
                startMin = this._freqView.min ?? 0;
                startMax = this._freqView.max ?? this.coords.boundedMaxFreq;
                document.body.style.cursor = 'ns-resize';
                document.addEventListener('pointermove', onMove);
                document.addEventListener('pointerup', onUp);
            });
        }

        // ── Freq axis: wheel = vertical zoom ──
        on(this.d.freqAxisSpacer, 'wheel', (e) => {
            if (!this.audioBuffer || !this._showSpectrogram) return;
            e.preventDefault();
            const rect = this.d.freqAxisSpacer.getBoundingClientRect();
            const localY = e.clientY - rect.top;
            const canvasH = this.d.spectrogramCanvas?.height || rect.height;
            const canvasY = (localY / Math.max(1, rect.height)) * canvasH;
            const freqAtCursor = this.coords.pixelYToFrequency(canvasY);
            const zoomIn = e.deltaY < 0;
            this._freqView.zoom(zoomIn ? 1.15 : 1 / 1.15, freqAtCursor, this.coords.boundedMaxFreq);
        }, { passive: false });

        // ── Freq zoom slider ──
        on(this.d.freqZoomSlider, 'input', (e) => {
            this._freqView.setFromSlider(parseInt(e.target.value, 10), this.coords.boundedMaxFreq);
        });

        // ── Freq scrollbar drag ──
        {
            let dragging = false;
            let startY = 0;
            let startMin = 0;
            let startMax = 0;
            const onMove = (e) => {
                if (!dragging) return;
                const bar = this.d.freqScrollbar;
                const barH = bar.getBoundingClientRect().height;
                const dy = e.clientY - startY;
                const boundedMax = this.coords.boundedMaxFreq;
                const range = startMax - startMin;
                // dy positive = drag down = lower freqs
                const deltaFrac = dy / barH;
                const deltaHz = deltaFrac * boundedMax;
                let newMin = startMin - deltaHz;
                let newMax = startMax - deltaHz;
                if (newMin < 0) { newMin = 0; newMax = range; }
                if (newMax > boundedMax) { newMax = boundedMax; newMin = boundedMax - range; }
                this._freqView.set(Math.max(0, newMin), Math.min(boundedMax, newMax));
            };
            const onUp = () => {
                if (!dragging) return;
                dragging = false;
                this.d.freqScrollbar?.classList.remove('active');
                document.removeEventListener('pointermove', onMove);
                document.removeEventListener('pointerup', onUp);
            };
            on(this.d.freqScrollbarThumb, 'pointerdown', (e) => {
                if (!this._freqView.isZoomed) return;
                e.preventDefault();
                e.stopPropagation();
                dragging = true;
                startY = e.clientY;
                startMin = this._freqView.min ?? 0;
                startMax = this._freqView.max ?? this.coords.boundedMaxFreq;
                this.d.freqScrollbar?.classList.add('active');
                document.addEventListener('pointermove', onMove);
                document.addEventListener('pointerup', onUp);
            });
        }
    }

    /** Canvas and waveform scroll/click/key/pointer interactions. */
    _bindCanvasInteractionEvents(on) {
        on(this.d.canvasWrapper, 'click', (e) => this._handleCanvasClick(e));
        on(this.d.canvasWrapper, 'dblclick', (e) => {
            if (e.shiftKey) { e.preventDefault(); this._freqView.reset(); }
        });
        on(this.d.canvasWrapper, 'mousemove', (e) => this._updateCrosshair(e));
        on(this.d.canvasWrapper, 'mouseleave', () => this._hideCrosshair());
        on(this.d.waveformWrapper, 'click', (e) => this._handleWaveformClick(e));
        on(this.d.canvasWrapper, 'scroll', () => {
            if (this.scrollSyncLock) return;
            if (this._getPrimaryScrollWrapper() !== this.d.canvasWrapper) return;
            this._setLinkedScrollLeft(this.d.canvasWrapper.scrollLeft);
            // Viewport-rendering: synchronous redraw so the canvas doesn't lag
            // behind the label overlay which the browser scrolls natively.
            if (this._spectro.hasData) this._drawSpectrogram();
        });
        on(this.d.waveformWrapper, 'scroll', () => {
            if (this.scrollSyncLock) return;
            if (this._getPrimaryScrollWrapper() !== this.d.waveformWrapper) return;
            this._setLinkedScrollLeft(this.d.waveformWrapper.scrollLeft);
            // Sync the spectrogram viewport when the waveform is the primary scroller.
            if (this._spectro.hasData) this._drawSpectrogram();
        });
        on(this.d.canvasWrapper, 'wheel', (e) => this._handleWheel(e, 'spectrogram'), { passive: false });
        on(this.d.waveformWrapper, 'wheel', (e) => this._handleWheel(e, 'waveform'), { passive: false });
        on(this.d.canvasWrapper, 'keydown', (e) => {
            if (!this.audioBuffer) return;
            if (isTypingContext(e.target)) return;
            switch (e.key) {
                case 'ArrowLeft':  e.preventDefault(); this._seekByDelta(-SEEK_FINE_SEC); break;
                case 'ArrowRight': e.preventDefault(); this._seekByDelta(SEEK_FINE_SEC); break;
                case 'Home': e.preventDefault(); this._seekToTime(0, true); break;
                case 'End':  e.preventDefault(); this._seekToTime(this.audioBuffer.duration, true); break;
                default: break;
            }
        });
        on(this.d.canvasWrapper, 'pointerdown', (e) => this._startViewportPan(e, 'spectrogram'));
        on(this.d.waveformWrapper, 'pointerdown', (e) => this._startViewportPan(e, 'waveform'));
    }

    /** Overview waveform: handle drag, window drag, click-to-seek, label toggle. */
    _bindOverviewEvents(on) {
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
            const xNorm = clamp((e.clientX - rect.left) / rect.width, 0, 1);
            this._seekToTime(xNorm * this.audioBuffer.duration, true);
        });
        on(this.d.overviewLabelToggle, 'click', () => this._toggleOverviewLabelSection());
    }

    _bindTouchGestures() {
        const bindRecognizer = (element, source) => {
            if (!element) return;
            const rec = new GestureRecognizer(element);
            const offSwipe = rec.on('swipe', ({ dx }) => {
                if (!this.audioBuffer) return;
                this._seekByDelta(dx / Math.max(1, this.pixelsPerSecond));
            });
            const offPinch = rec.on('pinch', ({ scale, centerX }) => {
                if (!this.audioBuffer) return;
                // Clamp very noisy scale deltas from touch sensors
                const clampedScale = clamp(scale, 0.85, 1.15);
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
