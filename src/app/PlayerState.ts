// ═══════════════════════════════════════════════════════════════════════
// PlayerState.ts — Central state machine, interaction & event binding
// ═══════════════════════════════════════════════════════════════════════

import {
    DEFAULT_SAMPLE_RATE,
    DEFAULT_ZOOM_PPS,
    DEFAULT_WAVEFORM_HEIGHT, DEFAULT_SPECTROGRAM_DISPLAY_HEIGHT,
    MIN_WAVEFORM_HEIGHT, MIN_SPECTROGRAM_DISPLAY_HEIGHT,
    SEEK_FINE_SEC, SEEK_COARSE_SEC,
    PERCH_FRAME_RATE,
} from '../shared/constants.ts';

import { clamp, formatTime, isTypingContext, escapeHtml, clampNumber } from '../shared/utils.ts';
import { AudioEngine } from '../infrastructure/audio/AudioEngine.ts';
import { AudioEngineBase } from '../infrastructure/audio/AudioEngineBase.ts';
import { GestureRecognizer } from '../ui/components/gestures/gestures.ts';
import { TRANSPORT_STATE_LABELS, canTransitionTransportState } from '../domain/transportState.ts';
import { InteractionState } from './interactionState.ts';
import { CoordinateSystem } from '../domain/coordinateSystem.ts';

import { computeAmplitudePeak } from '../domain/spectrogram.ts';
import { PresetManager } from '../domain/PresetManager.ts';
import { SpectrogramController } from './SpectrogramController.ts';
import { FrequencyViewport } from './FrequencyViewport.ts';
import { LocalStorageAdapter } from '../infrastructure/storage/LocalStorageAdapter.ts';
import { ViewportManager } from './ViewportManager.ts';

import {
    renderMainWaveform,
    renderOverviewWaveform,
    renderFrequencyLabels,
} from '../ui/components/waveform/waveform.ts';

import { TransportController } from '../ui/components/transport/transport-controller.ts';
import { SettingsPanelController } from '../ui/components/settings-panel/settings-panel-controller.ts';
import { VolumeController } from '../ui/components/volume/volume-controller.ts';
import { DisplayGainController } from '../ui/components/display-gain/display-gain-controller.ts';
import { PlayheadController } from '../ui/components/playhead/playhead-controller.ts';
import { FreqViewportController } from '../ui/components/freq-viewport/freq-viewport-controller.ts';
import { CanvasInteractionController } from '../ui/components/canvas-interaction/canvas-interaction-controller.ts';
import { OverviewController } from '../ui/components/overview/overview-controller.ts';
import { DocumentEventsController } from '../ui/components/document-events/document-events-controller.ts';
import { WindowEventsController } from '../ui/components/window-events/window-events-controller.ts';

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
 * @property {import('../infrastructure/storage/IStorage.ts').IStorage} [storage]
 *   Storage adapter — defaults to LocalStorageAdapter.
 *   Pass InMemoryStorageAdapter for tests or headless environments.
 * @property {import('../infrastructure/audio/AudioEngineBase.ts').AudioEngineBase} [engine]
 *   Pre-constructed AudioEngine or MockAudioEngine for headless/test use.
 *   When provided, `WaveSurfer` may be null.
 * @property {((cmd: import('../domain/undoStack.ts').UndoCommand) => void) | null} [onDspCommand]
 *   Called after each user-initiated DSP parameter change with an undo/redo
 *   command. Pass `undoStack.record.bind(undoStack)` to add DSP changes to
 *   the same undo stack as label operations.
 */

// ── Standalone export (used by PlayerState and tests) ────────────────

export interface PlaybackViewportConfig {
    followGuardLeftRatio: number;
    followGuardRightRatio: number;
    followTargetRatio: number;
    followCatchupDurationMs: number;
    followCatchupSeekDurationMs: number;
    smoothLerp: number;
    smoothSeekLerp: number;
    smoothMinStepRatio: number;
    smoothSeekMinStepRatio: number;
    smoothSeekFocusMs: number;
}

/**
 * Sanitize and clamp a partial playback viewport config object.
 * All fields are optional; missing or invalid values fall back to `current` or built-in defaults.
 * Pure function — no side effects, no DOM required.
 *
 * @param {Partial<PlaybackViewportConfig>} partial
 * @param {Partial<PlaybackViewportConfig>} [current={}]
 * @returns {PlaybackViewportConfig}
 */
export function sanitizePlaybackViewportConfig(partial: Partial<PlaybackViewportConfig> = {}, current: Partial<PlaybackViewportConfig> = {}): PlaybackViewportConfig {
    return {
        followGuardLeftRatio:      clampNumber(partial.followGuardLeftRatio,      0.05, 0.95,  current.followGuardLeftRatio      ?? 0.35),
        followGuardRightRatio:     clampNumber(partial.followGuardRightRatio,     0.05, 0.95,  current.followGuardRightRatio     ?? 0.65),
        followTargetRatio:         clampNumber(partial.followTargetRatio,         0.1,  0.9,   current.followTargetRatio         ?? 0.5),
        followCatchupDurationMs:   clampNumber(partial.followCatchupDurationMs,   80,   2500,  current.followCatchupDurationMs   ?? 240),
        followCatchupSeekDurationMs: clampNumber(partial.followCatchupSeekDurationMs, 100, 3000, current.followCatchupSeekDurationMs ?? 360),
        smoothLerp:                clampNumber(partial.smoothLerp,                0.02, 0.95,  current.smoothLerp                ?? 0.18),
        smoothSeekLerp:            clampNumber(partial.smoothSeekLerp,            0.01, 0.9,   current.smoothSeekLerp            ?? 0.08),
        smoothMinStepRatio:        clampNumber(partial.smoothMinStepRatio,        0.001, 0.25, current.smoothMinStepRatio        ?? 0.03),
        smoothSeekMinStepRatio:    clampNumber(partial.smoothSeekMinStepRatio,    0.001, 0.2,  current.smoothSeekMinStepRatio    ?? 0.008),
        smoothSeekFocusMs:         clampNumber(partial.smoothSeekFocusMs,         150,  5000,  current.smoothSeekFocusMs         ?? 1400),
    };
}

// ═════════════════════════════════════════════════════════════════════

export class PlayerState {
    d: any;
    interaction: InteractionState;
    coords: CoordinateSystem;
    container: any;
    _storage: any;
    _presets: any;
    _spectro: any;
    WaveSurfer: any;
    _engine: any;
    _viewport: any;
    _perf: any;
    _emitHostEvent: any;
    options: any;
    _viewMode: any;
    _showWaveform: any;
    _showSpectrogram: any;
    _showOverview: any;
    _transportOverlay: any;
    _compactToolbarMode: any;
    _compactToolbarOpen: any;
    _settingsPanelOpen: any;
    _compactToolbarLayoutRaf: any;
    _showWaveformTimeline: any;
    _playbackViewportConfig: any;
    sampleRateHz: any;
    amplitudePeakAbs: number;
    _freqView: any;
    transportState: any;
    _lastTimeReadoutText: any;
    _uiFrameId: any;
    _uiPending: any;
    _crosshairEnabled: any;
    _crosshairRafId: any;
    waveformDisplayHeight: any;
    spectrogramDisplayHeight: any;
    _viewResizeFrameId: any;
    _viewResizeNeedsWaveformRedraw: any;
    _viewResizeNeedsSpectrogramRedraw: any;
    _cleanups: any;
    target: any;
    name: any;
    message: any;
    userInitiated: any;
    _cachedSpectrogramHeight: any;
    /**
     * @param {HTMLElement} container
     * @param {any} WaveSurfer
     * @param {((event: string, detail: any) => void) | null} [emitHostEvent]
     * @param {PlayerOptions} [options]
     */
    constructor(container: HTMLElement, WaveSurfer: unknown, emitHostEvent: ((name: string, detail: unknown) => void) | null = null, options: any = {}) {
        if (!container) throw new Error('PlayerState: container element required');
        if (!WaveSurfer && !options.engine) throw new Error('PlayerState: WaveSurfer reference or options.engine required');

        this.container = container;
        this.d = this._queryDom(container);
        /** @type {import('../infrastructure/storage/IStorage.ts').IStorage} */
        this._storage = options.storage ?? new LocalStorageAdapter();
        this._presets = new PresetManager(this.d, {
            onRegenerateSpectrogram: (opts: unknown) => { if (this.audioBuffer) this._spectro.generate(opts); },
            onStage1Rebuild: () => {
                if (this._spectro.hasData) {
                    this._spectro.buildGrayscale();
                    this._spectro.buildBaseImage(this._presets.currentColorScheme);
                    this._drawSpectrogram();
                }
            },
            storage: this._storage,
            // Wire DSP-parameter changes into the undo stack if one was injected.
            onDspCommand: options.onDspCommand ?? null,
        });
        this._presets.populatePresetDropdown();
        this._presets.applyFavouritePresetControls();
        this.WaveSurfer = WaveSurfer;

        // ── AudioEngine: owns WaveSurfer, decoding, segment playback, volume state ──
        // Accepts an injected engine (e.g. MockAudioEngine) for headless/test use.
        // Typed as AudioEngine so TypeScript knows all concrete properties;
        // a MockAudioEngine injected via options.engine must satisfy AudioEngineBase.
        /** @type {AudioEngine} */
        this._engine = /** @type {AudioEngine} */ (options.engine instanceof AudioEngineBase
            ? options.engine
            : new AudioEngine(WaveSurfer, { container: this.d.audioEngineHost }));

        // ── Map AudioEngine events to PlayerState handlers ──────────────
        this._engine.addEventListener('uiupdate', (e: CustomEvent<any>) => this._scheduleUiUpdate(e.detail));
        this._engine.addEventListener('transportstatechange', (e: CustomEvent<any>) => {
            const { state, reason } = e.detail;
            this._setTransportState(state, reason);
        });
        this._engine.addEventListener('ready', () => {
            this._viewport._lastSelectionEmitAt = 0;
            this._viewport._lastSelectionStart  = NaN;
            this._viewport._lastSelectionEnd    = NaN;
        });
        this._engine.addEventListener('timeupdate', (e: CustomEvent<any>) => {
            this._perf.timeupdateEvents += 1;
            this._emit('timeupdate', e.detail);
        });
        this._engine.addEventListener('segmentstart', (e: CustomEvent<any>) => this._emit('segmentplaystart', e.detail));
        this._engine.addEventListener('segmentend', (e: CustomEvent<any>) => this._emit('segmentplayend', e.detail));
        this._engine.addEventListener('segmentloop', (e: CustomEvent<any>) => this._emit('segmentloop', e.detail));
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
        this._spectro.addEventListener('transportstatechange', (e: CustomEvent<any>) => {
            const { state, reason } = e.detail;
            this._setTransportState(state, reason);
        });
        this._spectro.addEventListener('progress',    (e: CustomEvent<any>) => this._emit('progress',     e.detail));
        this._spectro.addEventListener('computetime', (e: CustomEvent<any>) => this._emit('computeTime',  e.detail));
        this._spectro.addEventListener('ready',       (e: CustomEvent<any>) => this._emit('ready',        e.detail));
        this._spectro.addEventListener('error',       (e: CustomEvent<any>) => this._emit('error',        e.detail));
        this._spectro.addEventListener('scalechange', (e: CustomEvent<any>) => {
            this._emit('spectrogramscalechange', e.detail);
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

        // ── Vertical frequency zoom viewport ──
        this._freqView = new FrequencyViewport();
        this._freqView.addEventListener('change', () => this._applyFreqViewChange());

        // ── Interaction FSM (created before ViewportManager so it can be injected) ──
        this.interaction = new InteractionState();

        // ── Coordinate system (created before ViewportManager so it can be injected) ──
        this.coords = new CoordinateSystem();

        // ── Playback toggles ──
        // loopPlayback, playbackMode, _activeSegment*, _suppressNextPauseHandler,
        // _segmentPlayToken, _customSegmentPlayback, _lastTimeupdateEmitAt — owned by this._engine
        this.transportState = '';
        this._lastTimeReadoutText = '';
        this._uiFrameId = 0;
        this._uiPending = null;
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

        // ── ViewportManager ──
        const vLayout = {
            showSpectrogram: this._showSpectrogram,
            showWaveform:    this._showWaveform,
            showOverview:    this._showOverview,
            spectrogramHeight: DEFAULT_SPECTROGRAM_DISPLAY_HEIGHT,
            waveformHeight: DEFAULT_WAVEFORM_HEIGHT,
        };
        this._viewport = new ViewportManager({
            d:             this.d,
            coords:        this.coords,
            interaction:   this.interaction,
            layout:        vLayout,
            playbackViewportConfig: this._playbackViewportConfig,
            getAudioBuffer:  () => this.audioBuffer,
            getWavesurfer:   () => this.wavesurfer,
            scheduleUiUpdate: (detail?: any) => this._scheduleUiUpdate(detail as any),
            onRedrawNeeded: () => {
                if (this._spectro.hasData) this._drawSpectrogram();
                this._drawMainWaveform();
            },
            getSpectroHasData: () => this._spectro.hasData,
            emit: (event: string, detail?: any) => this._emit(event, detail),
        });

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
        if (this._storage.getItem('aw-label-section-collapsed') === '1') {
            this._toggleOverviewLabelSection(true);
        }

        if (this.options.enableTouchGestures !== false) {
            this._bindTouchGestures();
        }
        this._refreshCompactToolbarLayout();
        this._presets.updatePcenSectionDimming();
        requestAnimationFrame(() => this._refreshCompactToolbarLayout());
    }

    _emit(event: string, detail: unknown = {}) {
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

    set muted(v)                     { this._engine.muted = v; }
    set loopPlayback(v)              { this._engine.loopPlayback = v; }

    // ── Viewport state (proxy to ViewportManager) ────────────────────
    get pixelsPerSecond()  { return this._viewport.pixelsPerSecond; }
    set pixelsPerSecond(v) { this._viewport.pixelsPerSecond = v; }
    get windowStartNorm()  { return this._viewport.windowStartNorm; }
    set windowStartNorm(v) { this._viewport.windowStartNorm = v; }
    get windowEndNorm()    { return this._viewport.windowEndNorm; }
    set windowEndNorm(v)   { this._viewport.windowEndNorm = v; }
    get followMode()       { return this._viewport.followMode; }
    set followMode(v)      { this._viewport.followMode = v; }
    get followPlayback()   { return this._viewport.followPlayback; }
    set followPlayback(v)  { this._viewport.followPlayback = v; }
    get scrollSyncLock()   { return this._viewport.scrollSyncLock; }
    set scrollSyncLock(v)  { this._viewport.scrollSyncLock = v; }

    _sanitizePlaybackViewportConfig(partial = {}) {
        return sanitizePlaybackViewportConfig(partial, this._playbackViewportConfig || {});
    }

    updatePlaybackViewportConfig(partial = {}) {
        this._playbackViewportConfig = this._sanitizePlaybackViewportConfig(partial);
        if (this._playbackViewportConfig.followGuardLeftRatio >= this._playbackViewportConfig.followGuardRightRatio) {
            this._playbackViewportConfig.followGuardLeftRatio = 0.35;
            this._playbackViewportConfig.followGuardRightRatio = 0.65;
        }
        this._viewport?.updateConfig(this._playbackViewportConfig);
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

    _perfOnFrame(ts: number) {
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

    _setTransportState(nextState: string, reason = '') {
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
        this._setPlayState((TRANSPORT_STATE_LABELS as any)[nextState] || nextState);
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
    }: { time?: number; fromPlayback?: boolean; centerView?: boolean; emitSeek?: boolean; immediate?: boolean } = {}) {
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

    _flushUiUpdate(_ts: number) {
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

    _queryDom(root: HTMLElement) {
        const q = (id: string) => root.querySelector(`[data-aw="${id}"]`) as any;
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
            showCentroidCheck:      q('showCentroidCheck'),
            showF0Check:            q('showF0Check'),
            showRidgesCheck:        q('showRidgesCheck'),
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
        this._viewport.dispose();
        this._hideCrosshair();
        if (this._viewResizeFrameId) {
            cancelAnimationFrame(this._viewResizeFrameId);
            this._viewResizeFrameId = 0;
        }
        if (this._uiFrameId) {
            cancelAnimationFrame(this._uiFrameId);
            this._uiFrameId = 0;
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

    async _handleFileSelect(e: Event) {
        const input = e.target as HTMLInputElement | null;
        const file = input?.files?.[0] ?? null;
        if (!file) return;
        await this.loadFile(file);
    }

    async loadFile(file: File) {
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

    async loadUrl(url: string) {
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

    async _onAudioLoaded({ duration, sampleRate }: { duration: number; sampleRate: number }, displayName: string, readyReason?: string) {
        this.sampleRateHz = sampleRate;
        this.amplitudePeakAbs = this._engine.audioBuffer ? computeAmplitudePeak(this._engine.audioBuffer.getChannelData(0)) : 0;
        this._updateAmplitudeLabels();
        if (this._engine.audioBuffer) {
            this._spectro.setAudio(this._engine.audioBuffer, sampleRate);
        }
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

    _onAudioLoadError(error: any, source: string) {
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

    playSegment(startSec: number, endSec: number, options: any = {}) {
        this._engine.playSegment(startSec, endSec, options);
    }

    playBandpassedSegment(startSec: number, endSec: number, freqMinHz: number, freqMaxHz: number, options: any = {}) {
        this._engine.playBandpassedSegment(startSec, endSec, freqMinHz, freqMaxHz, options);
    }

    updateActiveSegmentFromLabel(label: any) {
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

    _seekToTime(timeSec: number, centerView = false, options: any = {}) {
        if (!this.audioBuffer) return;
        if (options.userInitiated) {
            this._viewport.markSeekFocus();
        }
        // Delegate to engine — handles custom segment stop, clamp, wavesurfer.setTime, onUiUpdate
        this._engine.seekToTime(timeSec, centerView, options);
    }

    _seekByDelta(deltaSec: number) {
        if (!this.audioBuffer) return;
        this._seekToTime(this._getCurrentTime() + deltaSec, false);
    }

    _getCurrentTime() { return this._engine.getCurrentTime(); }

    _updateTimeReadout(t: number) {
        const nextText = formatTime(t);
        if (nextText !== this._lastTimeReadoutText) {
            this._lastTimeReadoutText = nextText;
            this.d.currentTimeDisplay.textContent = nextText;
        }
        this._updateAriaPlaybackPosition(t);
    }

    _updateAriaPlaybackPosition(currentTimeSec: number) {
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

    _updatePlayhead(currentTime: number, fromPlayback: boolean) {
        if (!this.audioBuffer) return;

        const position = this.coords.timeToScrollX(currentTime);

        this.d.playhead.style.transform = `translateX(${position}px)`;
        this.d.waveformPlayhead.style.transform = `translateX(${position}px)`;

        // Follow-mode scroll — delegated to ViewportManager
        if (fromPlayback && this.followPlayback && this.wavesurfer?.isPlaying()) {
            this._viewport.applyFollowScroll(position);
        }

        this._syncOverviewWindowToViewport();

        if (!this._engine._customSegmentPlayback && this._engine._activeSegmentEnd != null && currentTime >= this._engine._activeSegmentEnd - 0.005) {
            const start = this._engine._activeSegmentStart ?? 0;
            const end = this._engine._activeSegmentEnd;
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
            currentTime:    this._getCurrentTime(),
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

    // ── OLD PIPELINE METHODS DELETED — see SpectrogramController.ts ──

    // ── Volume ──────────────────────────────────────────────────────

    _setVolume(val: unknown) {
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

    _requestSpectrogramRedraw() { this._viewport._requestSpectrogramRedraw(); }

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

        const fmt = (v: number) => {
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

    // ── Viewport delegation ─────────────────────────────────────────
    // These methods are now owned by ViewportManager but kept as thin
    // wrappers so all internal callers continue to work unchanged.

    _getPrimaryScrollWrapper() { return this._viewport._getPrimaryScrollWrapper(); }
    _getSecondaryScrollWrapper() { return this._viewport._getSecondaryScrollWrapper(); }
    _getPrimaryScrollLeft() { return this._viewport.getPrimaryScrollLeft(); }
    _getViewportWidth() { return this._viewport.getViewportWidth(); }
    _setLinkedScrollLeft(nextLeft: unknown) { return this._viewport._setLinkedScrollLeft(nextLeft); }
    _setPixelsPerSecond(nextPps: number, redraw: boolean, anchorTime?: number, anchorPixel?: number) {
        return this._viewport.setPixelsPerSecond(nextPps, redraw, anchorTime, anchorPixel);
    }
    _fitEntireTrackInView() { this._viewport.fitEntireTrackInView(); }
    _zoomByScale(scale: number, centerClientX: number, source = 'spectrogram') {
        this._viewport.zoomByScale(scale, centerClientX, /** @type {'spectrogram'|'waveform'} */ (source));
    }
    _centerViewportAtTime(timeSec: number) { this._viewport.centerViewportAtTime(timeSec); }
    _clientXToTime(clientX: number, source = 'spectrogram') {
        return this._viewport.clientXToTime(clientX, /** @type {'spectrogram'|'waveform'} */ (source));
    }

    // ═════════════════════════════════════════════════════════════════
    //  Overview Navigator
    // ═════════════════════════════════════════════════════════════════

    _syncOverviewWindowToViewport() { this._viewport.syncOverviewWindowToViewport(); }
    _updateOverviewWindowElement() { this._viewport.updateOverviewWindowElement(); }
    _getOverviewSpanConstraints() { return this._viewport.getOverviewSpanConstraints(); }
    _startOverviewDrag(mode: unknown, clientX: unknown) { this._viewport.startOverviewDrag(mode, clientX); }
    _updateOverviewDrag(clientX: unknown) { this._viewport.updateOverviewDrag(clientX); }
    _queueOverviewViewportApply(redrawFinal = false) { this._viewport.queueOverviewViewportApply(redrawFinal); }

    _toggleOverviewLabelSection(force?: boolean) {
        const section = this.d.overviewLabelSection;
        const btn     = this.d.overviewLabelToggle;
        if (!section) return;
        const collapsed = force !== undefined ? force : !section.classList.contains('collapsed');
        section.classList.toggle('collapsed', collapsed);
        if (btn) btn.setAttribute('aria-expanded', String(!collapsed));
        this._storage.setItem('aw-label-section-collapsed', collapsed ? '1' : '0');
        // Collapsing/expanding changes layout height — trigger spectrogram resize handling.
        requestAnimationFrame(() => {
            this._invalidateSpectrogramHeightCache?.();
            if (this.audioBuffer) {
                if (this._spectro.hasData) this._drawSpectrogram();
                this._drawMainWaveform();
            }
        });
    }

    _applyOverviewWindowToViewport(redraw = true) { this._viewport.applyOverviewWindowToViewport(redraw); }

    // ═════════════════════════════════════════════════════════════════
    //  Click / Pointer / Drag
    // ═════════════════════════════════════════════════════════════════

    _handleCanvasClick(e: MouseEvent | PointerEvent) {
        if (this.interaction.isSeekBlocked()) return;
        if (!this.audioBuffer) return;
        this._cancelFollowCatchupAnimation();
        this._seekToTime(this._clientXToTime(e.clientX, 'spectrogram'), false, { userInitiated: true });
    }

    _handleWaveformClick(e: MouseEvent | PointerEvent) {
        if (this.interaction.isSeekBlocked()) return;
        if (!this.audioBuffer) return;
        this._cancelFollowCatchupAnimation();
        this._seekToTime(this._clientXToTime(e.clientX, 'waveform'), false, { userInitiated: true });
    }

    _blockSeekClicks(ms = 220) {
        this.interaction.blockSeekClicks(ms);
    }

    _startPlayheadDrag(event: PointerEvent, source: string) {
        if (!this.audioBuffer) return;
        event.preventDefault();
        if (!this.interaction.enter('playhead-drag')) return;
        this.interaction.ctx.playheadSource = source;
        this._seekFromClientX(event.clientX, source);
    }

    _seekFromClientX(clientX: number, source: 'spectrogram'|'waveform'|string = 'spectrogram') {
        if (!this.audioBuffer) return;
        this._seekToTime(this._clientXToTime(clientX, source), false);
    }

    _startViewportPan(event: PointerEvent, source: string) {
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

    _updateViewportPan(clientX: number, clientY: number) {
        const dx = clientX - (this.interaction.ctx.panStartX ?? 0);
        const dy = clientY - (this.interaction.ctx.panStartY ?? 0);
        this.interaction.ctx.panSuppressClick = Math.abs(dx) > 3 || Math.abs(dy) > 3;
        this._setLinkedScrollLeft((this.interaction.ctx.panStartScroll ?? 0) - dx);

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

    _handleWheel(event: WheelEvent, source: 'spectrogram'|'waveform'|string) {
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
        const viewRange = (this._freqView.max ?? boundedMax) - (this._freqView.min ?? 0);
        const thumbFrac = Math.min(1, viewRange / boundedMax);
        // top=0 is highest freq, bottom=100% is 0 Hz
        const topFrac = 1 - (this._freqView.max ?? boundedMax) / boundedMax;
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
        const fraction = ((this._freqView.max ?? boundedMax) - (this._freqView.min ?? 0)) / boundedMax;
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
        // Note: coords reference is updated in ViewportManager after rebuild (see end of this method)
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
        // Keep ViewportManager in sync with the freshly rebuilt coords instance
        this._viewport?.updateCoords(this.coords);
    }

    _startViewResize(mode: string, clientY: number) {
        /** @type {Record<string, import('./interactionState.ts').InteractionMode>} */
        const modeMap: Record<string, import('./interactionState.ts').InteractionMode> = { split: 'view-resize-split', spectrogram: 'view-resize-spectrogram' };
        if (!this.interaction.enter(modeMap[mode])) return;
        this.interaction.ctx.resizeStartY = clientY;
        this.interaction.ctx.resizeStartWaveformH = this.waveformDisplayHeight;
        this.interaction.ctx.resizeStartSpectrogramH = this.spectrogramDisplayHeight;
        document.body.style.cursor = 'row-resize';
    }

    _updateViewResize(clientY: number) {
        const sub = this.interaction.viewResizeSubMode;
        if (!sub) return;
        if ((sub === 'split' && (!this._showWaveform || !this._showSpectrogram))
            || (sub === 'spectrogram' && !this._showSpectrogram)) return;
        const ctx = this.interaction.ctx;
        const dy = clientY - (ctx.resizeStartY ?? 0);
        let redrawWav = false;

        if (sub === 'split') {
            const total = (ctx.resizeStartWaveformH ?? 0) + (ctx.resizeStartSpectrogramH ?? 0);
            let nextWav = (ctx.resizeStartWaveformH ?? 0) + dy;
            nextWav = clamp(nextWav, MIN_WAVEFORM_HEIGHT, total - MIN_SPECTROGRAM_DISPLAY_HEIGHT);
            this.waveformDisplayHeight = nextWav;
            this.spectrogramDisplayHeight = total - nextWav;
            redrawWav = true;
        } else {
            this.spectrogramDisplayHeight = Math.max(
                MIN_SPECTROGRAM_DISPLAY_HEIGHT,
                (ctx.resizeStartSpectrogramH ?? 0) + dy,
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

    _flushResizeRedraw(force: unknown) {
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

    _setPlayState(text: unknown) {
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

    _setCompactToolbarOpen(nextOpen: unknown) {
        const open = this._isCompactToolbarActive() && !!nextOpen;
        this._compactToolbarOpen = open;
        this.container.classList.toggle('compact-toolbar-open', open);
        if (this.d.compactMoreBtn) this.d.compactMoreBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
    }

    _toggleSettingsPanel() {
        this._setSettingsPanelOpen(!this._settingsPanelOpen);
    }

    _setSettingsPanelOpen(open: unknown) {
        this._settingsPanelOpen = !!open;
        this.container.classList.toggle('settings-panel-open', this._settingsPanelOpen);
        if (this.d.settingsToggleBtn) {
            this.d.settingsToggleBtn.classList.toggle('active', this._settingsPanelOpen);
            this.d.settingsToggleBtn.setAttribute('aria-expanded', this._settingsPanelOpen ? 'true' : 'false');
        }
    }

    _setTransportEnabled(enabled: unknown) {
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

    /** @param {MouseEvent|PointerEvent} e */
    _updateCrosshair(e: MouseEvent | PointerEvent) {
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
    _drawCrosshairLines(overlay: HTMLCanvasElement, cx: number, cy: number, w: number, h: number) {
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

    _cancelFollowCatchupAnimation() { this._viewport._cancelFollowCatchupAnimation(); }
    _animateFollowCatchupTo(targetScrollLeft: number) { this._viewport._animateFollowCatchupTo(targetScrollLeft); }
    _applySmoothFollow(position: number, viewportWidth: number) { this._viewport._applySmoothFollow(position, viewportWidth); }

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

    _handleKeyboardShortcuts(event: KeyboardEvent) {
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
        const on = (target: any, type: string, fn: any, opts: AddEventListenerOptions | boolean | undefined = undefined) => {
            target?.addEventListener(type, fn, opts as any);
            this._cleanups.push(() => target?.removeEventListener(type, fn, opts as any));
        };

        new TransportController(this.d, this).bind(on);
        new FreqViewportController(this.d, this).bind(on);
        new SettingsPanelController(this.d, this).bind(on);
        new VolumeController(this.d, this).bind(on);
        new DisplayGainController(this.d, this).bind(on);
        new CanvasInteractionController(this.d, this).bind(on);
        new PlayheadController(this.d, this).bind(on);
        new DocumentEventsController(this).bind(on);
        new OverviewController(this.d, this).bind(on);
        new WindowEventsController(this).bind(on);
    }

    _bindTouchGestures() {
        const bindRecognizer = (element: HTMLElement | null, source: string) => {
            if (!element) return;
            const rec = new GestureRecognizer(element as HTMLElement);
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
