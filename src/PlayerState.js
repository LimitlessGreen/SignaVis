// ═══════════════════════════════════════════════════════════════════════
// PlayerState.js — Central state machine, interaction & event binding
// ═══════════════════════════════════════════════════════════════════════

import {
    DEFAULT_SAMPLE_RATE,
    DEFAULT_ZOOM_PPS,
    DEFAULT_WAVEFORM_HEIGHT, DEFAULT_SPECTROGRAM_DISPLAY_HEIGHT,
    MIN_WAVEFORM_HEIGHT, MIN_SPECTROGRAM_DISPLAY_HEIGHT,
    SEEK_FINE_SEC, SEEK_COARSE_SEC, MIN_WINDOW_NORM,
    PROGRESSIVE_CHUNK_SECONDS, PROGRESSIVE_MIN_DURATION_SEC,
    PERCH_FRAME_RATE,
    DSP_PROFILES,
    QUALITY_LEVELS,
    CQT_FMIN, CQT_BINS_PER_OCTAVE,
    windowHopFromOverlap,
    fftSizeFromOversampling,
} from './constants.js';

import { clamp, formatTime, formatSecondsShort, isTypingContext, escapeHtml, clampNumber } from './utils.js';
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

import { computeReassignedSpectrogram } from './dsp.js';



const LS_USER_PRESETS = 'aw-user-presets';
const LS_FAV_PRESET   = 'aw-favourite-preset';
const LS_LAST_SETTINGS = 'aw-last-settings';

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

/**
 * Parse the native sample rate from an audio file header (WAV, FLAC, OGG Vorbis/Opus).
 * Returns 0 if the format is unrecognised.
 * @param {ArrayBuffer} buf
 * @returns {number}
 */
function parseNativeSampleRate(buf) {
    if (buf.byteLength < 44) return 0;
    const view = new DataView(buf);

    // ── WAV: "RIFF" … "WAVE", sample rate at byte 24 (LE uint32) ──
    if (view.getUint32(0) === 0x52494646 && view.getUint32(8) === 0x57415645) {
        return view.getUint32(24, true);
    }

    // ── FLAC: "fLaC", STREAMINFO sample rate = 20 bits at byte 18 ──
    if (view.getUint32(0) === 0x664C6143) {
        return (view.getUint8(18) << 12) | (view.getUint8(19) << 4) | (view.getUint8(20) >> 4);
    }

    // ── OGG: "OggS", then Vorbis or Opus inside first page ──
    if (view.getUint32(0) === 0x4F676753 && buf.byteLength >= 64) {
        const nSegments = view.getUint8(26);
        const dataOffset = 27 + nSegments;
        if (buf.byteLength >= dataOffset + 16) {
            const b0 = view.getUint8(dataOffset);
            // Vorbis identification header: type 0x01, then "vorbis"
            if (b0 === 0x01 && view.getUint32(dataOffset + 1) === 0x766F7262 /* "vorb" */) {
                return view.getUint32(dataOffset + 12, true);
            }
            // OpusHead: "OpusHead", sample rate at byte 12 of header
            if (view.getUint32(dataOffset) === 0x4F707573 /* "Opus" */ &&
                view.getUint32(dataOffset + 4) === 0x48656164 /* "Head" */) {
                return view.getUint32(dataOffset + 12, true);
            }
        }
    }

    return 0;
}

/**
 * Decode an ArrayBuffer into an AudioBuffer, preserving the file's native
 * sample rate when possible (instead of resampling to AudioContext default).
 * @param {ArrayBuffer} arrayBuffer
 * @returns {Promise<AudioBuffer>}
 */
async function decodeArrayBuffer(arrayBuffer) {
    const Ctor = window.AudioContext || /** @type {any} */ (window).webkitAudioContext;
    if (!Ctor) throw new Error('AudioContext is not supported by this browser.');

    const nativeSr = parseNativeSampleRate(arrayBuffer);
    /** @type {AudioContextOptions | undefined} */
    const opts = nativeSr > 0 ? { sampleRate: nativeSr } : undefined;
    const ctx = new Ctor(opts);
    try {
        return await ctx.decodeAudioData(arrayBuffer);
    } finally {
        ctx.close?.().catch(() => {});
    }
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
        this._populatePresetDropdown();
        this._applyFavouritePresetControls();
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
        this.sampleRateHz = DEFAULT_SAMPLE_RATE;
        this._externalSpectrogram = false; // true when externally-injected data/image
        this._externalImageConfig = null; // { freqRange, freqScale } for external images
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

        // ── Vertical frequency zoom viewport ──
        /** @type {number | null} */
        this._freqViewMin = null;
        /** @type {number | null} */
        this._freqViewMax = null;

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
        this._updatePcenSectionDimming();
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
            viewSplitHandle:        q('viewSplitHandle'),
            spectrogramResizeHandle:q('spectrogramResizeHandle'),
            overviewCanvas:         q('overviewCanvas'),
            overviewContainer:      q('overviewContainer'),
            overviewWindow:         q('overviewWindow'),
            overviewHandleLeft:     q('overviewHandleLeft'),
            overviewHandleRight:    q('overviewHandleRight'),
            overviewLabelTracks:    q('overviewLabelTracks'),
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

    _populatePresetDropdown() {
        const sel = this.d.presetSelect;
        if (!sel) return;
        sel.innerHTML = '';
        const empty = document.createElement('option');
        empty.value = '';
        empty.textContent = '— Custom —';
        sel.appendChild(empty);
        // Built-in presets
        for (const name of Object.keys(DSP_PROFILES)) {
            const opt = document.createElement('option');
            opt.value = name;
            opt.textContent = name.charAt(0).toUpperCase() + name.slice(1);
            sel.appendChild(opt);
        }
        // User presets
        const userPresets = this._loadUserPresets();
        const userNames = Object.keys(userPresets);
        if (userNames.length) {
            const sep = document.createElement('option');
            sep.disabled = true;
            sep.textContent = '──────────';
            sel.appendChild(sep);
            const fav = this._getFavouritePreset();
            for (const name of userNames) {
                const opt = document.createElement('option');
                opt.value = `user:${name}`;
                opt.textContent = (fav === `user:${name}` ? '⭐ ' : '') + name;
                sel.appendChild(opt);
            }
        }
        // Select favourite or default
        const fav = this._getFavouritePreset();
        if (fav && Array.from(sel.options).some(o => o.value === fav)) {
            sel.value = fav;
        } else {
            sel.value = 'birder';
        }
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

        this.d.fileInfo.innerHTML = `<span class="statusbar-label">${escapeHtml(file.name)}</span>`;
        this.d.fileInfo.classList.add('loading');
        this._setTransportState('loading', 'file-load');

        try {
            const fileBuffer = await file.arrayBuffer();
            const audioBuffer = await decodeArrayBuffer(fileBuffer);
            this.audioBuffer = audioBuffer;
            this.sampleRateHz = audioBuffer.sampleRate;
            this.amplitudePeakAbs = computeAmplitudePeak(audioBuffer.getChannelData(0));
            this._updateAmplitudeLabels();
            this._updateMaxFreqOptions();

            this.d.fileInfo.innerHTML = `<span class="statusbar-label">${escapeHtml(file.name)}</span> <span>${formatTime(audioBuffer.duration)}</span>`;
            this.d.sampleRateInfo.textContent = `${audioBuffer.sampleRate} Hz`;
            this.d.totalTimeDisplay.textContent = formatTime(audioBuffer.duration);
            this.d.currentTimeDisplay.textContent = formatTime(0);

            this._setPixelsPerSecond(DEFAULT_ZOOM_PPS, false);
            this._setTransportEnabled(true);
            this._updateToggleButtons();
            this._setTransportState('ready', 'file-loaded');
            this.d.fileInfo.classList.remove('loading');

            this._setupWaveSurfer(file);
            await this._generateSpectrogram({ autoAdjust: true });
            this._drawMainWaveform();
            this._drawOverviewWaveform();
            this._createFrequencyLabels();
            this._seekToTime(0, true);
        } catch (error) {
            console.error('Error loading file:', error);
            this._setTransportState('error', 'file-load-failed');
            this.d.fileInfo.classList.remove('loading');
            this._emit('error', { message: error?.message || String(error), source: 'file' });
            alert('Error loading audio file');
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
            this._updateMaxFreqOptions();

            const name = decodeURIComponent(
                new URL(url, location.href).pathname.split('/').pop() || 'audio',
            );
            this.d.fileInfo.innerHTML = `<span class="statusbar-label">${escapeHtml(name)}</span> <span>${formatTime(audioBuffer.duration)}</span>`;
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
            await this._generateSpectrogram({ autoAdjust: true });
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
        const start = clamp(startSec, 0, dur);
        const end = clamp(endSec, 0, dur);
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
        const start = clamp(startSec, 0, dur);
        const end = clamp(endSec, 0, dur);
        if (end - start < 0.01) return;
        const nyquist = Math.max(100, this.audioBuffer.sampleRate * 0.5 - 10);
        const fLo = Math.max(20, Math.min(freqMinHz, freqMaxHz, nyquist - 5));
        const fHi = clamp(Math.max(freqMinHz, freqMaxHz), fLo + 5, nyquist);
        const center = Math.sqrt(fLo * fHi);
        const bandwidth = Math.max(10, fHi - fLo);
        const q = clamp(center / bandwidth, 0.25, 40);

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
        playback.runStartSec = startAtSec == null ? playback.startSec : clamp(startAtSec, playback.startSec, playback.endSec - 0.001);
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

        const start = clamp(Number(label.start ?? 0), 0, dur);
        const end = clamp(Number(label.end ?? start + 0.01), start + 0.01, dur);
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
            const fHi = clamp(Math.max(freqMinHz, freqMaxHz), fLo + 5, nyquist);
            const center = Math.sqrt(fLo * fHi);
            const bandwidth = Math.max(10, fHi - fLo);
            const q = clamp(center / bandwidth, 0.25, 40);
            playback.bandpass.frequency.value = center;
            playback.bandpass.Q.value = q;
            this._activeSegmentFilter = { type: 'bandpass', freqMinHz: fLo, freqMaxHz: fHi };
        }

        const desiredStart = clamp(playback.currentTimeSec || start, start, end - 0.001);
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
        const t = clamp(timeSec, 0, this.audioBuffer.duration);
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

    async _generateSpectrogram({ autoAdjust = false } = {}) {
        if (!this.audioBuffer) return;
        if (this._externalSpectrogram) return; // external data — do not overwrite
        if (this.d.recomputingOverlay) this.d.recomputingOverlay.hidden = false;
        this._setTransportState('rendering', 'spectrogram-generate');

        // Yield to the browser so the "Computing…" overlay is painted
        // before the heavy synchronous DSP work blocks the main thread.
        await new Promise(r => requestAnimationFrame(() => setTimeout(r, 0)));

        const scale = this.d.scaleSelect?.value || 'mel';
        const colourScale = this.d.colourScaleSelect?.value || 'dbSquared';
        const windowSize = parseInt(this.d.windowSizeSelect?.value || '1024', 10);
        const overlapLevel = parseInt(this.d.overlapSelect?.value || '2', 10);
        const oversamplingLevel = parseInt(this.d.oversamplingSelect?.value || '0', 10);
        const hopSize = windowHopFromOverlap(windowSize, overlapLevel);
        const fftSize = fftSizeFromOversampling(windowSize, oversamplingLevel);
        const windowFunction = this.d.windowFunctionSelect?.value || 'hann';
        const nMels = parseInt(this.d.nMelsInput?.value || '160', 10) || 160;
        const useReassigned = this.d.reassignedCheck?.checked ?? false;

        // CQT: compute nMels from octave range if CQT scale is selected
        const effectiveNMels = scale === 'cqt'
            ? Math.ceil(Math.log2((this.audioBuffer.sampleRate / 2) / CQT_FMIN) * CQT_BINS_PER_OCTAVE)
            : nMels;

        const options = {
            scale,
            colourScale,
            sampleRate: this.audioBuffer.sampleRate,
            fftSize,
            windowFunction,
            nMels: effectiveNMels,
            frameRate: PERCH_FRAME_RATE,
            usePcen: this.d.pcenEnabledCheck?.checked ?? true,
            pcenGain: parseFloat(this.d.pcenGainInput?.value || '0.8'),
            pcenBias: parseFloat(this.d.pcenBiasInput?.value || '0.01'),
            pcenRoot: parseFloat(this.d.pcenRootInput?.value || '4.0'),
            pcenSmoothing: parseFloat(this.d.pcenSmoothingInput?.value || '0.025'),
            windowSize,
            hopSize,
        };

        // Remember actual scale for grayscale / coordinate system
        this._activeScale = scale;

        const t0 = performance.now();
        try {
            const channelData = this.audioBuffer.getChannelData(0);
            let result;

            if (useReassigned) {
                // Reassigned spectrogram runs synchronously on main thread
                result = computeReassignedSpectrogram({
                    channelData,
                    ...options,
                });
            } else {
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
            } // end if(useReassigned) else

            this.spectrogramData = result.data;
            this.spectrogramFrames = result.nFrames;
            this.spectrogramMels = result.nMels;
            this.spectrogramHopSize = result.hopSize || Math.max(1, Math.floor(this.sampleRateHz / PERCH_FRAME_RATE));
            this.spectrogramWinLength = result.winLength || 4 * this.spectrogramHopSize;
            this._colourScale = result.colourScale || colourScale;

            this._updateSpectrogramStats();
            if (autoAdjust) {
                const gainMode = this.d.gainModeSelect?.value || 'auto';
                if (gainMode === 'auto') this._autoContrast();
                const freqMode = this.d.maxFreqModeSelect?.value || 'auto';
                if (freqMode === 'auto') {
                    this._autoFrequency();
                } else if (freqMode === 'nyquist') {
                    this._setMaxFreqToNyquist();
                }
                // 'fixed' → keep current maxFreqSelect value
            }

            // Recompute coordinate system & frequency axis (scale/maxFreq may have changed)
            this._updateCoords();
            this._createFrequencyLabels();

            // Stage 1: build grayscale (expensive, once)
            this._buildSpectrogramGrayscale();
            // Stage 2: colorize (fast, GPU or JS)
            this._buildSpectrogramBaseImage();
            this._drawSpectrogram();
            this._syncOverviewWindowToViewport();
            if (this.d.recomputingOverlay) this.d.recomputingOverlay.hidden = true;
            this._setTransportState('ready', 'spectrogram-ready');

            const computeMs = performance.now() - t0;
            this._emit('computeTime', { durationMs: Math.round(computeMs) });
            this._emit('ready', {
                duration: this.audioBuffer.duration,
                sampleRate: this.audioBuffer.sampleRate,
                nFrames: this.spectrogramFrames,
                nMels: this.spectrogramMels,
            });
        } catch (error) {
            if (this.d.recomputingOverlay) this.d.recomputingOverlay.hidden = true;
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

        if (options.sampleRate) {
            this.sampleRateHz = options.sampleRate;
            this._updateMaxFreqOptions();
        }
        if (options.scale && this.d.scaleSelect) {
            this.d.scaleSelect.value = options.scale;
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

                // Store frequency mapping metadata for CoordinateSystem
                if (options.freqRange || options.freqScale) {
                    this._externalImageConfig = {
                        freqRange: options.freqRange || null,
                        freqScale: options.freqScale || null,
                    };
                } else {
                    this._externalImageConfig = null;
                }

                if (options.sampleRate) {
                    this.sampleRateHz = options.sampleRate;
                    this._updateMaxFreqOptions();
                }

                // Disable DSP controls that have no effect on pre-rendered images
                this._setDspControlsEnabled(false);

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
                    freqRange: options.freqRange || null,
                    freqScale: options.freqScale || null,
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

    /**
     * Enable or disable DSP/display controls that have no effect on
     * pre-rendered spectrogram images.
     * @param {boolean} enabled
     */
    _setDspControlsEnabled(enabled) {
        const settingsRows = [
            this.d.scaleSelect, this.d.windowSizeSelect,
            this.d.windowFunctionSelect, this.d.overlapSelect,
            this.d.oversamplingSelect, this.d.nMelsInput,
            this.d.floorSlider, this.d.ceilSlider,
            this.d.colorSchemeSelect, this.d.maxFreqSelect,
        ];
        for (const el of settingsRows) {
            if (!el) continue;
            el.disabled = !enabled;
            const row = el.closest('.settings-row');
            if (row) row.style.opacity = enabled ? '' : '0.35';
        }
        // Buttons
        for (const btn of [this.d.autoContrastBtn, this.d.autoFreqBtn]) {
            if (btn) btn.disabled = !enabled;
        }
        // PCEN section
        const pcen = this.d.pcenSection || this.container.querySelector('[data-aw="pcenSection"]');
        if (pcen) pcen.style.display = enabled ? '' : 'none';
        // Presets
        if (this.d.presetSelect) this.d.presetSelect.disabled = !enabled;
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

        const floorPct = clamp(((stats.logMin - this.spectrogramAbsLogMin) / range) * 100, 0, 100);
        const ceilPct  = clamp(((stats.logMax - this.spectrogramAbsLogMin) / range) * 100, 0, 100);

        this.d.floorSlider.value = Math.round(floorPct);
        this.d.ceilSlider.value  = Math.round(ceilPct);
        if (redraw) {
            this._buildSpectrogramBaseImage();
            this._drawSpectrogram();
        }
    }

    // ── Max-Frequency Options ────────────────────────────────────────

    /**
     * Rebuild the max-frequency <select> options so they cover the full
     * Nyquist range of the currently loaded audio.
     */
    _updateMaxFreqOptions() {
        const nyquist = this.sampleRateHz / 2;
        const select = this.d.maxFreqSelect;
        if (!select) return;

        // Candidate steps (Hz) — sparse at the bottom, denser near typical ranges
        const candidates = [
            1000, 2000, 4000, 6000, 8000, 10000, 12000,
            16000, 20000, 24000, 32000, 44100, 48000,
        ];
        const prev = parseFloat(select.value) || 10000;

        // Keep only those ≤ Nyquist, always include Nyquist itself
        const kept = candidates.filter(f => f <= nyquist);
        if (!kept.length || kept[kept.length - 1] < nyquist) {
            kept.push(nyquist);
        }

        select.innerHTML = '';
        for (const hz of kept) {
            const opt = document.createElement('option');
            opt.value = String(hz);
            if (hz === nyquist) {
                const label = hz >= 1000 ? `${(hz / 1000).toFixed(hz % 1000 ? 1 : 0)} kHz` : `${hz} Hz`;
                opt.textContent = `${label} (Nyquist)`;
            } else {
                opt.textContent = hz >= 1000 ? `${(hz / 1000).toFixed(hz % 1000 ? 1 : 0)} kHz` : `${hz} Hz`;
            }
            select.appendChild(opt);
        }

        // Restore previous selection if it still exists, else pick closest
        const values = kept;
        if (values.includes(prev)) {
            select.value = String(prev);
        } else {
            let best = values[values.length - 1];
            for (const v of values) {
                if (v >= prev) { best = v; break; }
            }
            select.value = String(best);
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
            this.d.scaleSelect?.value || 'mel',
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

    /** Set maxFreq dropdown to the Nyquist frequency. */
    _setMaxFreqToNyquist() {
        const nyquist = this.sampleRateHz / 2;
        const options = Array.from(this.d.maxFreqSelect.options);
        // Pick the last option (always Nyquist)
        const last = options[options.length - 1];
        if (last) this.d.maxFreqSelect.value = last.value;
        this._emit('spectrogramscalechange', { maxFreq: nyquist });
        this._updateCoords();
        this._createFrequencyLabels();
    }

    // ── Volume ──────────────────────────────────────────────────────

    _setVolume(val) {
        this.volume = clamp(val, 0, 1);
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

    /** Stage 1 — expensive: spectrogram data → float32 grayscale. Run once per audio/fft/freq change. */
    _buildSpectrogramGrayscale() {
        this.spectrogramGrayInfo = buildSpectrogramGrayscale({
            spectrogramData: this.spectrogramData,
            spectrogramFrames: this.spectrogramFrames,
            spectrogramMels: this.spectrogramMels,
            sampleRateHz: this.sampleRateHz,
            maxFreq: parseFloat(this.d.maxFreqSelect.value),
            spectrogramAbsLogMin: this.spectrogramAbsLogMin,
            spectrogramAbsLogMax: this.spectrogramAbsLogMax,
            scale: this._activeScale || this.d.scaleSelect?.value || 'mel',
            colourScale: this._colourScale || this.d.colourScaleSelect?.value || 'dbSquared',
            noiseReduction: this.d.noiseReductionCheck?.checked ?? false,
            clahe: this.d.claheCheck?.checked ?? false,
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

        // Compute frequency viewport crop for vertical zoom
        let freqViewSrcCrop = null;
        if (this._freqViewMin != null && this._freqViewMax != null) {
            const baseH = this.spectrogramBaseCanvas.height;
            const srcYTop = this.coords.frequencyToBaseYFraction(this._freqViewMax) * baseH;
            const srcYBottom = this.coords.frequencyToBaseYFraction(this._freqViewMin) * baseH;
            const srcH = Math.max(1, srcYBottom - srcYTop);
            freqViewSrcCrop = { srcY: srcYTop, srcH };
        }

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
            freqViewSrcCrop,
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

            if (this.wavesurfer) this.wavesurfer.zoom(effectivePps);
            if (this.audioBuffer && redraw) {
                // Redraw BEFORE emitting zoomchange so that canvas dimensions
                // and coords are up-to-date when listeners (e.g. label layers) run.
                if (this.spectrogramData && this.spectrogramFrames > 0) this._drawSpectrogram();
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
        this.interaction.ctx.panStartY = event.clientY;
        this.interaction.ctx.panStartScroll = source === 'waveform'
            ? this.d.waveformWrapper.scrollLeft
            : this.d.canvasWrapper.scrollLeft;
        this.interaction.ctx.panStartFreqViewMin = this._freqViewMin;
        this.interaction.ctx.panStartFreqViewMax = this._freqViewMax;
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
            && this._showSpectrogram && (this._freqViewMin != null || this._freqViewMax != null)) {
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
            this._freqViewMin = Math.max(0, newMin);
            this._freqViewMax = Math.min(boundedMax, newMax);
            this._applyFreqViewChange();
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
            this._verticalFreqZoom(zoomIn ? 1.15 : 1 / 1.15, freqAtCursor);
            return;
        }

        if (Math.abs(event.deltaY) > Math.abs(event.deltaX)) {
            event.preventDefault();
            this._setLinkedScrollLeft(Math.max(0, wrapper.scrollLeft + event.deltaY));
        }
    }

    // ═════════════════════════════════════════════════════════════════
    //  Vertical Frequency Zoom
    // ═════════════════════════════════════════════════════════════════

    _verticalFreqZoom(factor, anchorFreq) {
        const boundedMax = this.coords.boundedMaxFreq;
        const currentMin = this._freqViewMin ?? 0;
        const currentMax = this._freqViewMax ?? boundedMax;
        const anchor = clamp(anchorFreq, currentMin, currentMax);

        // Scale distances from anchor
        let newMin = anchor - (anchor - currentMin) / factor;
        let newMax = anchor + (currentMax - anchor) / factor;

        // Enforce minimum range (100 Hz or 5% of full range)
        const minRange = Math.max(100, boundedMax * 0.05);
        if (newMax - newMin < minRange) {
            const mid = (newMin + newMax) / 2;
            newMin = mid - minRange / 2;
            newMax = mid + minRange / 2;
        }

        // Clamp to valid range
        newMin = Math.max(0, newMin);
        newMax = Math.min(boundedMax, newMax);

        // If (near) full range, reset viewport
        if (newMin <= 1 && newMax >= boundedMax - 1) {
            this._freqViewMin = null;
            this._freqViewMax = null;
        } else {
            this._freqViewMin = newMin;
            this._freqViewMax = newMax;
        }

        this._applyFreqViewChange();
    }

    _resetFreqView() {
        if (this._freqViewMin == null && this._freqViewMax == null) return;
        this._freqViewMin = null;
        this._freqViewMax = null;
        this._applyFreqViewChange();
    }

    /** Shift the frequency viewport up/down by deltaHz (positive = up). */
    _verticalFreqPan(deltaHz) {
        const boundedMax = this.coords.boundedMaxFreq;
        const currentMin = this._freqViewMin ?? 0;
        const currentMax = this._freqViewMax ?? boundedMax;
        if (currentMin <= 0 && currentMax >= boundedMax) return; // not zoomed

        let newMin = currentMin + deltaHz;
        let newMax = currentMax + deltaHz;
        const range = currentMax - currentMin;

        // Clamp so viewport stays within [0, boundedMax]
        if (newMin < 0) { newMin = 0; newMax = range; }
        if (newMax > boundedMax) { newMax = boundedMax; newMin = boundedMax - range; }

        this._freqViewMin = Math.max(0, newMin);
        this._freqViewMax = Math.min(boundedMax, newMax);
        this._applyFreqViewChange();
    }

    /** Set Y-zoom to a specific level (0 = full range, 100 = max zoom). */
    _setFreqZoomFromSlider(sliderValue) {
        const boundedMax = this.coords.boundedMaxFreq;
        if (sliderValue <= 0) {
            this._resetFreqView();
            return;
        }
        // Exponential mapping: 0→full, 100→5% of full range
        const fraction = Math.max(0.05, 1 - sliderValue / 100 * 0.95);
        const range = boundedMax * fraction;

        // Keep centered on current midpoint or center of full range
        const currentMid = (this._freqViewMin != null && this._freqViewMax != null)
            ? (this._freqViewMin + this._freqViewMax) / 2
            : boundedMax / 2;
        let newMin = currentMid - range / 2;
        let newMax = currentMid + range / 2;
        if (newMin < 0) { newMin = 0; newMax = range; }
        if (newMax > boundedMax) { newMax = boundedMax; newMin = boundedMax - range; }

        this._freqViewMin = newMin;
        this._freqViewMax = newMax;
        this._applyFreqViewChange();
    }

    _applyFreqViewChange() {
        this._updateCoords();
        this._drawSpectrogram();
        this._createFrequencyLabels();
        this._scheduleUiUpdate({ time: this._getCurrentTime(), fromPlayback: false, immediate: true });
        // Toggle Y-zoom reset button visibility
        const btn = this.d.freqZoomResetBtn;
        if (btn) btn.hidden = this._freqViewMin == null;
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

        if (this._freqViewMin == null || this._freqViewMax == null) {
            bar.hidden = true;
            return;
        }
        bar.hidden = false;
        const boundedMax = this.coords.boundedMaxFreq;
        const viewRange = this._freqViewMax - this._freqViewMin;
        const thumbFrac = Math.min(1, viewRange / boundedMax);
        // top=0 is highest freq, bottom=100% is 0 Hz
        const topFrac = 1 - this._freqViewMax / boundedMax;
        thumb.style.height = `${Math.max(8, thumbFrac * 100)}%`;
        thumb.style.top = `${topFrac * 100}%`;
    }

    _syncFreqZoomSlider() {
        const slider = this.d.freqZoomSlider;
        if (!slider) return;
        if (this._freqViewMin == null || this._freqViewMax == null) {
            slider.value = '0';
            return;
        }
        const boundedMax = this.coords.boundedMaxFreq;
        const fraction = (this._freqViewMax - this._freqViewMin) / boundedMax;
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
        const h = this.d.spectrogramContainer?.clientHeight;
        if (h > 0) return Math.max(MIN_SPECTROGRAM_DISPLAY_HEIGHT, h);
        return Math.max(MIN_SPECTROGRAM_DISPLAY_HEIGHT, Math.floor(this.spectrogramDisplayHeight));
    }

    /** Rebuild the shared CoordinateSystem whenever any mapping parameter changes. */
    _updateCoords() {
        const extCfg = this._externalImageConfig;
        this.coords = new CoordinateSystem({
            duration: this.audioBuffer?.duration || 0,
            sampleRate: this.sampleRateHz,
            pixelsPerSecond: this.pixelsPerSecond,
            canvasWidth: this.d.spectrogramCanvas?.width || 0,
            canvasHeight: this.d.spectrogramCanvas?.height || 0,
            maxFreq: parseFloat(this.d.maxFreqSelect?.value || '10000'),
            spectrogramMels: this.spectrogramMels,
            scale: this.d.scaleSelect?.value || 'mel',
            frameRate: PERCH_FRAME_RATE,
            hopSize: this.spectrogramHopSize || 0,
            freqRange: extCfg?.freqRange || null,
            freqScale: extCfg?.freqScale || null,
            freqViewMin: this._freqViewMin,
            freqViewMax: this._freqViewMax,
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
        let p;
        if (name.startsWith('user:')) {
            const userPresets = this._loadUserPresets();
            p = userPresets[name.slice(5)];
        } else {
            p = DSP_PROFILES[name];
        }
        if (!p) return;
        if (this.d.scaleSelect) this.d.scaleSelect.value = p.scale || 'mel';
        // Window size + overlap + oversampling
        if (this.d.windowSizeSelect && p.windowSize != null) this.d.windowSizeSelect.value = String(p.windowSize);
        if (this.d.overlapSelect && p.overlapLevel != null) this.d.overlapSelect.value = String(p.overlapLevel);
        if (this.d.oversamplingSelect && p.oversamplingLevel != null) this.d.oversamplingSelect.value = String(p.oversamplingLevel);
        // Window function
        if (this.d.windowFunctionSelect) this.d.windowFunctionSelect.value = p.windowFunction;
        // nMels
        if (this.d.nMelsInput) this.d.nMelsInput.value = String(p.nMels);
        if (this.d.pcenEnabledCheck) this.d.pcenEnabledCheck.checked = !!p.usePcen;
        if (this.d.pcenGainInput) this.d.pcenGainInput.value = String(p.pcenGain);
        if (this.d.pcenBiasInput) this.d.pcenBiasInput.value = String(p.pcenBias);
        if (this.d.pcenRootInput) this.d.pcenRootInput.value = String(p.pcenRoot);
        if (this.d.pcenSmoothingInput) this.d.pcenSmoothingInput.value = String(p.pcenSmoothing);
        // Color palette
        if (p.colorScheme && this.d.colorSchemeSelect) {
            this.d.colorSchemeSelect.value = p.colorScheme;
            this.currentColorScheme = p.colorScheme;
        }
        // Reassignment
        if (this.d.reassignedCheck) this.d.reassignedCheck.checked = !!p.reassigned;
        // User preset extras: colourScale, noiseReduction, CLAHE
        if (p.colourScale != null && this.d.colourScaleSelect) this.d.colourScaleSelect.value = p.colourScale;
        if (p.noiseReduction != null && this.d.noiseReductionCheck) this.d.noiseReductionCheck.checked = !!p.noiseReduction;
        if (p.clahe != null && this.d.claheCheck) this.d.claheCheck.checked = !!p.clahe;
        // Gain mode
        const gainMode = p.gainMode || 'auto';
        if (this.d.gainModeSelect) this.d.gainModeSelect.value = gainMode;
        if (gainMode === 'fixed' && p.gainFloor != null && p.gainCeil != null) {
            if (this.d.floorSlider) this.d.floorSlider.value = String(p.gainFloor);
            if (this.d.ceilSlider) this.d.ceilSlider.value = String(p.gainCeil);
        }
        // Max frequency mode
        const maxFreqMode = p.maxFreqMode || 'auto';
        if (this.d.maxFreqModeSelect) this.d.maxFreqModeSelect.value = maxFreqMode;
        if (maxFreqMode === 'fixed' && p.maxFreqHz != null && this.d.maxFreqSelect) {
            this.d.maxFreqSelect.value = String(p.maxFreqHz);
        }
        // Sync dropdown
        if (this.d.presetSelect) this.d.presetSelect.value = name;
        this._updatePresetButtons();
        this._syncQualitySlider();
        this._updatePcenSectionDimming();
        if (this.audioBuffer) this._generateSpectrogram({ autoAdjust: true });
    }

    _clearPresetHighlight() {
        if (this.d.presetSelect) this.d.presetSelect.value = '';
        this._updatePresetButtons();
        this._persistCurrentSettings();
    }

    // ── User Presets (localStorage) ─────────────────────────────────

    _loadUserPresets() {
        try {
            const raw = localStorage.getItem(LS_USER_PRESETS);
            if (raw) {
                const parsed = JSON.parse(raw);
                if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
            }
        } catch { /* corrupt data — ignore */ }
        return {};
    }

    _saveUserPresetsToStorage(presets) {
        try { localStorage.setItem(LS_USER_PRESETS, JSON.stringify(presets)); } catch { /* quota */ }
    }

    /** Persist current control state so it survives page reload / new file load. */
    _persistCurrentSettings() {
        try {
            const s = this._getCurrentPresetSettings();
            localStorage.setItem(LS_LAST_SETTINGS, JSON.stringify(s));
        } catch { /* quota */ }
    }

    /** Load last-used settings from localStorage (returns null if none). */
    _loadLastSettings() {
        try {
            const raw = localStorage.getItem(LS_LAST_SETTINGS);
            if (raw) {
                const parsed = JSON.parse(raw);
                if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
            }
        } catch { /* corrupt */ }
        return null;
    }

    _getFavouritePreset() {
        try { return localStorage.getItem(LS_FAV_PRESET) || ''; } catch { return ''; }
    }

    _setFavouritePreset(key) {
        try { localStorage.setItem(LS_FAV_PRESET, key); } catch { /* quota */ }
    }

    /** Snapshot current DSP controls into a preset object. */
    _getCurrentPresetSettings() {
        const gainMode = this.d.gainModeSelect?.value || 'auto';
        const preset = {
            scale:             this.d.scaleSelect?.value || 'mel',
            colourScale:       this.d.colourScaleSelect?.value || 'dbSquared',
            windowSize:        parseInt(this.d.windowSizeSelect?.value || '1024', 10),
            overlapLevel:      parseInt(this.d.overlapSelect?.value || '2', 10),
            oversamplingLevel: parseInt(this.d.oversamplingSelect?.value || '0', 10),
            windowFunction:    this.d.windowFunctionSelect?.value || 'hann',
            nMels:             parseInt(this.d.nMelsInput?.value || '160', 10),
            usePcen:           this.d.pcenEnabledCheck?.checked ?? true,
            pcenGain:          parseFloat(this.d.pcenGainInput?.value || '0.8'),
            pcenBias:          parseFloat(this.d.pcenBiasInput?.value || '0.01'),
            pcenRoot:          parseFloat(this.d.pcenRootInput?.value || '4.0'),
            pcenSmoothing:     parseFloat(this.d.pcenSmoothingInput?.value || '0.025'),
            colorScheme:       this.d.colorSchemeSelect?.value || 'grayscale',
            reassigned:        this.d.reassignedCheck?.checked ?? false,
            noiseReduction:    this.d.noiseReductionCheck?.checked ?? false,
            clahe:             this.d.claheCheck?.checked ?? false,
            gainMode,
            maxFreqMode:       this.d.maxFreqModeSelect?.value || 'auto',
        };
        if (gainMode === 'fixed') {
            preset.gainFloor = parseInt(this.d.floorSlider?.value || '0', 10);
            preset.gainCeil  = parseInt(this.d.ceilSlider?.value || '100', 10);
        }
        if (preset.maxFreqMode === 'fixed') {
            preset.maxFreqHz = parseFloat(this.d.maxFreqSelect?.value || '10000');
        }
        return preset;
    }

    _promptSaveUserPreset() {
        if (!this.d.presetSaveRow) return;
        const isOpen = !this.d.presetSaveRow.hidden;
        this.d.presetSaveRow.hidden = isOpen;
        if (!isOpen) {
            const inp = this.d.presetSaveInput;
            if (inp) { inp.value = ''; inp.focus(); }
        }
    }

    _confirmSaveUserPreset() {
        const inp = this.d.presetSaveInput;
        if (!inp) return;
        const clean = (inp.value || '').trim();
        if (!clean) return;
        if (DSP_PROFILES[clean.toLowerCase()]) {
            this._showPresetStatus('Built-in name — choose another', true);
            return;
        }
        const presets = this._loadUserPresets();
        presets[clean] = this._getCurrentPresetSettings();
        this._saveUserPresetsToStorage(presets);
        this._populatePresetDropdown();
        if (this.d.presetSelect) this.d.presetSelect.value = `user:${clean}`;
        this._updatePresetButtons();
        this.d.presetSaveRow.hidden = true;
        this._renderPresetManagerList();
        this._showPresetStatus(`Saved "${clean}"`);
    }

    _cancelSaveUserPreset() {
        if (this.d.presetSaveRow) this.d.presetSaveRow.hidden = true;
    }

    _toggleFavouritePreset() {
        const val = this.d.presetSelect?.value || '';
        if (!val) return;
        const current = this._getFavouritePreset();
        if (current === val) {
            this._setFavouritePreset('');
        } else {
            this._setFavouritePreset(val);
        }
        this._populatePresetDropdown();
        if (this.d.presetSelect) this.d.presetSelect.value = val;
        this._updatePresetButtons();
        this._renderPresetManagerList();
    }

    _updatePresetButtons() {
        const val = this.d.presetSelect?.value || '';
        const isAny = val !== '';
        if (this.d.presetFavBtn) {
            this.d.presetFavBtn.disabled = !isAny;
            const isFav = isAny && this._getFavouritePreset() === val;
            this.d.presetFavBtn.classList.toggle('active', isFav);
            this.d.presetFavBtn.title = isFav ? 'Remove as default preset' : 'Set as default preset';
        }
    }

    /** Show a transient status message in the preset manager panel. */
    _showPresetStatus(msg, isError = false) {
        const el = this.d.presetStatus;
        if (!el) return;
        el.textContent = msg;
        el.classList.toggle('pm-status-error', isError);
        el.classList.remove('pm-status-visible');
        // Force reflow for animation
        void el.offsetWidth;
        el.classList.add('pm-status-visible');
        clearTimeout(this._pmStatusTimer);
        this._pmStatusTimer = setTimeout(() => el.classList.remove('pm-status-visible'), 2500);
    }

    // ── Preset Manager (inline panel) ─────────────────────────────────

    _openPresetManager() {
        if (!this.d.presetManagerPanel) return;
        const isOpen = !this.d.presetManagerPanel.hidden;
        this.d.presetManagerPanel.hidden = isOpen;
        this.d.presetManageBtn?.classList.toggle('active', !isOpen);
        if (!isOpen) this._renderPresetManagerList();
    }

    _closePresetManager() {
        if (this.d.presetManagerPanel) this.d.presetManagerPanel.hidden = true;
        this.d.presetManageBtn?.classList.remove('active');
    }

    _renderPresetManagerList() {
        const list = this.d.presetManagerList;
        if (!list) return;
        list.innerHTML = '';
        const fav = this._getFavouritePreset();
        const starSvg = `<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>`;
        const starFilledSvg = `<svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>`;
        const trashSvg = `<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/></svg>`;
        const pencilSvg = `<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21.174 6.812a1 1 0 00-3.986-3.987L3.842 16.174a2 2 0 00-.5.83l-1.321 4.352a.5.5 0 00.62.62l4.352-1.321a2 2 0 00.83-.497z"/></svg>`;

        // Built-in presets
        for (const name of Object.keys(DSP_PROFILES)) {
            const key = name;
            const isFav = fav === key;
            const row = document.createElement('div');
            row.className = 'pm-item';
            row.innerHTML = `
                <button class="pm-fav-btn${isFav ? ' active' : ''}" title="Set as default">${isFav ? starFilledSvg : starSvg}</button>
                <span class="pm-name" title="Click to apply">${name.charAt(0).toUpperCase() + name.slice(1)}</span>
                <span class="pm-badge">built-in</span>`;
            /** @type {HTMLElement} */ (row.querySelector('.pm-fav-btn')).onclick = () => {
                this._setFavouritePreset(isFav ? '' : key);
                this._populatePresetDropdown(); this._updatePresetButtons();
                this._renderPresetManagerList();
            };
            /** @type {HTMLElement} */ (row.querySelector('.pm-name')).onclick = () => {
                this._applyPreset(key);
                this._persistCurrentSettings();
            };
            list.appendChild(row);
        }

        // User presets
        const userPresets = this._loadUserPresets();
        for (const name of Object.keys(userPresets)) {
            const key = `user:${name}`;
            const isFav = fav === key;
            const row = document.createElement('div');
            row.className = 'pm-item';
            row.innerHTML = `
                <button class="pm-fav-btn${isFav ? ' active' : ''}" title="Set as default">${isFav ? starFilledSvg : starSvg}</button>
                <span class="pm-name" title="Click to apply"></span>
                <button class="pm-icon-btn pm-rename-btn" title="Rename">${pencilSvg}</button>
                <button class="pm-icon-btn pm-delete-btn" title="Delete">${trashSvg}</button>`;
            // Use textContent to prevent XSS from preset names
            /** @type {HTMLElement} */ (row.querySelector('.pm-name')).textContent = name;
            /** @type {HTMLElement} */ (row.querySelector('.pm-fav-btn')).onclick = () => {
                this._setFavouritePreset(isFav ? '' : key);
                this._populatePresetDropdown(); this._updatePresetButtons();
                this._renderPresetManagerList();
            };
            /** @type {HTMLElement} */ (row.querySelector('.pm-name')).onclick = () => {
                this._applyPreset(key);
                this._persistCurrentSettings();
            };
            /** @type {HTMLElement} */ (row.querySelector('.pm-rename-btn')).onclick = () => this._inlineRenamePreset(name, row);
            const delBtn = /** @type {HTMLElement} */ (row.querySelector('.pm-delete-btn'));
            delBtn.onclick = () => {
                if (delBtn.classList.contains('pm-confirm-delete')) {
                    // Second click — confirmed
                    this._deleteUserPresetDirect(name);
                } else {
                    // First click — arm confirmation
                    delBtn.classList.add('pm-confirm-delete');
                    delBtn.title = 'Click again to confirm';
                    setTimeout(() => { delBtn.classList.remove('pm-confirm-delete'); delBtn.title = 'Delete'; }, 2000);
                }
            };
            list.appendChild(row);
        }

        if (!Object.keys(DSP_PROFILES).length && !Object.keys(userPresets).length) {
            const empty = document.createElement('div');
            empty.className = 'pm-empty';
            empty.textContent = 'No presets yet.';
            list.appendChild(empty);
        }
    }

    /** Replace the name span with an inline input for renaming. */
    _inlineRenamePreset(oldName, row) {
        const nameSpan = row.querySelector('.pm-name');
        if (!nameSpan || row.querySelector('.pm-rename-input')) return;
        const input = document.createElement('input');
        input.type = 'text';
        input.className = 'pm-rename-input';
        input.value = oldName;
        input.maxLength = 40;
        nameSpan.replaceWith(input);
        input.focus();
        input.select();

        const commit = () => {
            const clean = (input.value || '').trim();
            if (!clean || clean === oldName) { this._renderPresetManagerList(); return; }
            if (DSP_PROFILES[clean.toLowerCase()]) {
                this._showPresetStatus('Built-in name — choose another', true);
                this._renderPresetManagerList(); return;
            }
            const presets = this._loadUserPresets();
            if (presets[clean]) {
                this._showPresetStatus(`"${clean}" already exists`, true);
                this._renderPresetManagerList(); return;
            }
            presets[clean] = presets[oldName];
            delete presets[oldName];
            this._saveUserPresetsToStorage(presets);
            const oldKey = `user:${oldName}`;
            const newKey = `user:${clean}`;
            if (this._getFavouritePreset() === oldKey) this._setFavouritePreset(newKey);
            this._populatePresetDropdown();
            this._updatePresetButtons();
            this._renderPresetManagerList();
        };
        input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') commit();
            if (e.key === 'Escape') this._renderPresetManagerList();
        });
        input.addEventListener('blur', commit);
    }

    _deleteUserPresetDirect(name) {
        const presets = this._loadUserPresets();
        delete presets[name];
        this._saveUserPresetsToStorage(presets);
        const key = `user:${name}`;
        if (this._getFavouritePreset() === key) this._setFavouritePreset('');
        this._populatePresetDropdown();
        this._updatePresetButtons();
        this._renderPresetManagerList();
    }

    _exportPresets() {
        const userPresets = this._loadUserPresets();
        const fav = this._getFavouritePreset();
        const data = { version: 1, favourite: fav, presets: userPresets };
        const json = JSON.stringify(data, null, 2);
        const blob = new Blob([json], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'audio-workbench-presets.json';
        a.click();
        URL.revokeObjectURL(url);
        this._showPresetStatus('Exported');
    }

    _importPresets() {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = '.json,application/json';
        input.onchange = () => {
            const file = input.files?.[0];
            if (!file) return;
            const reader = new FileReader();
            reader.onload = () => {
                try {
                    const data = JSON.parse(/** @type {string} */ (reader.result));
                    if (!data || typeof data !== 'object' || typeof data.presets !== 'object' || Array.isArray(data.presets)) {
                        this._showPresetStatus('Invalid preset file', true); return;
                    }
                    for (const [k, v] of Object.entries(data.presets)) {
                        if (!v || typeof v !== 'object' || Array.isArray(v)) {
                            this._showPresetStatus(`Invalid entry: "${k}"`, true); return;
                        }
                    }
                    const existing = this._loadUserPresets();
                    let imported = 0;
                    for (const [k, v] of Object.entries(data.presets)) {
                        if (DSP_PROFILES[k.toLowerCase()]) continue;
                        existing[k] = v;
                        imported++;
                    }
                    this._saveUserPresetsToStorage(existing);
                    if (data.favourite && typeof data.favourite === 'string' && data.favourite.startsWith('user:')) {
                        const favName = data.favourite.slice(5);
                        if (existing[favName]) this._setFavouritePreset(data.favourite);
                    }
                    this._populatePresetDropdown();
                    this._updatePresetButtons();
                    this._renderPresetManagerList();
                    this._showPresetStatus(`Imported ${imported} preset(s)`);
                } catch {
                    this._showPresetStatus('Failed to parse file', true);
                }
            };
            reader.readAsText(file);
        };
        input.click();
    }

    /** Apply favourite preset or last-used settings on init (no spectrogram yet). */
    _applyFavouritePresetControls() {
        const fav = this._getFavouritePreset();
        let p;
        if (fav) {
            if (fav.startsWith('user:')) {
                const userPresets = this._loadUserPresets();
                p = userPresets[fav.slice(5)];
            } else {
                p = DSP_PROFILES[fav];
            }
        }
        // Fall back to last-used custom settings
        if (!p) {
            p = this._loadLastSettings();
            // Show "Custom" in dropdown when restoring last-used settings
            if (p && this.d.presetSelect) this.d.presetSelect.value = '';
        }
        // Fall back to default built-in preset so controls match the dropdown
        if (!p) {
            const defaultKey = this.d.presetSelect?.value || 'birder';
            p = DSP_PROFILES[defaultKey];
        }
        if (!p) return;
        // Set all controls to preset values (same as _applyPreset but skip regeneration)
        if (this.d.scaleSelect) this.d.scaleSelect.value = p.scale || 'mel';
        if (this.d.windowSizeSelect && p.windowSize != null) this.d.windowSizeSelect.value = String(p.windowSize);
        if (this.d.overlapSelect && p.overlapLevel != null) this.d.overlapSelect.value = String(p.overlapLevel);
        if (this.d.oversamplingSelect && p.oversamplingLevel != null) this.d.oversamplingSelect.value = String(p.oversamplingLevel);
        if (this.d.windowFunctionSelect) this.d.windowFunctionSelect.value = p.windowFunction || 'hann';
        if (this.d.nMelsInput) this.d.nMelsInput.value = String(p.nMels || 160);
        if (this.d.pcenEnabledCheck) this.d.pcenEnabledCheck.checked = !!p.usePcen;
        if (this.d.pcenGainInput) this.d.pcenGainInput.value = String(p.pcenGain ?? 0.8);
        if (this.d.pcenBiasInput) this.d.pcenBiasInput.value = String(p.pcenBias ?? 0.01);
        if (this.d.pcenRootInput) this.d.pcenRootInput.value = String(p.pcenRoot ?? 4.0);
        if (this.d.pcenSmoothingInput) this.d.pcenSmoothingInput.value = String(p.pcenSmoothing ?? 0.025);
        if (p.colorScheme && this.d.colorSchemeSelect) {
            this.d.colorSchemeSelect.value = p.colorScheme;
            this.currentColorScheme = p.colorScheme;
        }
        if (this.d.reassignedCheck) this.d.reassignedCheck.checked = !!p.reassigned;
        if (p.colourScale != null && this.d.colourScaleSelect) this.d.colourScaleSelect.value = p.colourScale;
        if (p.noiseReduction != null && this.d.noiseReductionCheck) this.d.noiseReductionCheck.checked = !!p.noiseReduction;
        if (p.clahe != null && this.d.claheCheck) this.d.claheCheck.checked = !!p.clahe;
        // Gain mode
        const gainMode = p.gainMode || 'auto';
        if (this.d.gainModeSelect) this.d.gainModeSelect.value = gainMode;
        if (gainMode === 'fixed' && p.gainFloor != null && p.gainCeil != null) {
            if (this.d.floorSlider) this.d.floorSlider.value = String(p.gainFloor);
            if (this.d.ceilSlider) this.d.ceilSlider.value = String(p.gainCeil);
        }
        // Max-freq mode
        const maxFreqMode = p.maxFreqMode || 'auto';
        if (this.d.maxFreqModeSelect) this.d.maxFreqModeSelect.value = maxFreqMode;
        if (maxFreqMode === 'fixed' && p.maxFreqHz != null && this.d.maxFreqSelect) {
            this.d.maxFreqSelect.value = String(p.maxFreqHz);
        }
        this._updatePresetButtons();
    }

    // ── Quality Slider (Performance ↔ Ultra) ────────────────────────

    _applyQualityLevel(index) {
        const level = QUALITY_LEVELS[index];
        if (!level) return;
        if (this.d.windowSizeSelect)    this.d.windowSizeSelect.value    = String(level.windowSize);
        if (this.d.overlapSelect)       this.d.overlapSelect.value       = String(level.overlapLevel);
        if (this.d.oversamplingSelect)  this.d.oversamplingSelect.value  = String(level.oversamplingLevel);
        if (this.d.nMelsInput)          this.d.nMelsInput.value          = String(level.nMels);
        if (this.d.qualityLevelDisplay) this.d.qualityLevelDisplay.textContent = level.label;
        this._clearPresetHighlight();
        if (this.audioBuffer) this._generateSpectrogram();
    }

    /** Match current controls back to a quality level (or show "Custom"). */
    _syncQualitySlider() {
        if (!this.d.qualitySlider) return;
        const ws = parseInt(this.d.windowSizeSelect?.value || '0', 10);
        const ol = parseInt(this.d.overlapSelect?.value || '-1', 10);
        const os = parseInt(this.d.oversamplingSelect?.value || '-1', 10);
        const nm = parseInt(this.d.nMelsInput?.value || '0', 10);
        const idx = QUALITY_LEVELS.findIndex(l =>
            l.windowSize === ws && l.overlapLevel === ol &&
            l.oversamplingLevel === os && l.nMels === nm);
        if (idx >= 0) {
            this.d.qualitySlider.value = String(idx);
            if (this.d.qualityLevelDisplay) this.d.qualityLevelDisplay.textContent = QUALITY_LEVELS[idx].label;
        } else {
            if (this.d.qualityLevelDisplay) this.d.qualityLevelDisplay.textContent = 'Custom';
        }
    }

    _updatePcenSectionDimming() {
        if (this.d.pcenSection) {
            const enabled = this.d.pcenEnabledCheck?.checked ?? true;
            this.d.pcenSection.style.opacity = enabled ? '' : '0.45';
            // Disable/enable the individual inputs
            for (const el of [
                this.d.pcenGainInput, this.d.pcenBiasInput,
                this.d.pcenRootInput, this.d.pcenSmoothingInput,
            ]) {
                if (el) el.disabled = !enabled;
            }
        }
    }

    _updateColourScaleConstraints() {
        const cs = this.d.colourScaleSelect?.value || 'dbSquared';
        // Phase mode: PCEN is meaningless → disable
        if (this.d.pcenEnabledCheck) {
            if (cs === 'phase') {
                this.d.pcenEnabledCheck.checked = false;
                this.d.pcenEnabledCheck.disabled = true;
            } else {
                this.d.pcenEnabledCheck.disabled = false;
            }
            this._updatePcenSectionDimming();
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
        on(this.d.freqZoomResetBtn, 'click', () => this._resetFreqView());
        on(this.d.fitViewBtn, 'click', () => this._fitEntireTrackInView());
        on(this.d.resetViewBtn, 'click', () => {
            this._setPixelsPerSecond(DEFAULT_ZOOM_PPS, true);
            this._setLinkedScrollLeft(0);
            this._resetFreqView();
            this._syncOverviewWindowToViewport();
        });

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
                this._freqViewMin = Math.max(0, newMin);
                this._freqViewMax = Math.min(boundedMax, newMax);
                this._applyFreqViewChange();
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
                if (this._freqViewMin == null && this._freqViewMax == null) return;
                e.preventDefault();
                dragging = true;
                startY = e.clientY;
                startMin = this._freqViewMin ?? 0;
                startMax = this._freqViewMax ?? this.coords.boundedMaxFreq;
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
            // Map pixel Y to frequency using canvas coordinates
            const canvasH = this.d.spectrogramCanvas?.height || rect.height;
            const canvasY = (localY / Math.max(1, rect.height)) * canvasH;
            const freqAtCursor = this.coords.pixelYToFrequency(canvasY);
            const zoomIn = e.deltaY < 0;
            this._verticalFreqZoom(zoomIn ? 1.15 : 1 / 1.15, freqAtCursor);
        }, { passive: false });

        // ── Freq zoom slider ──
        on(this.d.freqZoomSlider, 'input', (e) => {
            this._setFreqZoomFromSlider(parseInt(e.target.value, 10));
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
                this._freqViewMin = Math.max(0, newMin);
                this._freqViewMax = Math.min(boundedMax, newMax);
                this._applyFreqViewChange();
            };
            const onUp = () => {
                if (!dragging) return;
                dragging = false;
                this.d.freqScrollbar?.classList.remove('active');
                document.removeEventListener('pointermove', onMove);
                document.removeEventListener('pointerup', onUp);
            };
            on(this.d.freqScrollbarThumb, 'pointerdown', (e) => {
                if (this._freqViewMin == null) return;
                e.preventDefault();
                e.stopPropagation();
                dragging = true;
                startY = e.clientY;
                startMin = this._freqViewMin ?? 0;
                startMax = this._freqViewMax ?? this.coords.boundedMaxFreq;
                this.d.freqScrollbar?.classList.add('active');
                document.addEventListener('pointermove', onMove);
                document.addEventListener('pointerup', onUp);
            });
        }

        // ── Settings ──
        on(this.d.scaleSelect, 'change', () => {
            this._clearPresetHighlight();
            if (this.audioBuffer) this._generateSpectrogram({ autoAdjust: true });
        });
        on(this.d.colourScaleSelect, 'change', () => {
            this._clearPresetHighlight();
            this._updateColourScaleConstraints();
            if (this.audioBuffer) this._generateSpectrogram({ autoAdjust: true });
        });
        on(this.d.presetSelect, 'change', () => {
            const val = this.d.presetSelect?.value;
            if (val) this._applyPreset(val);
            this._updatePresetButtons();
            this._persistCurrentSettings();
        });
        on(this.d.presetSaveBtn, 'click', () => this._promptSaveUserPreset());
        on(this.d.presetFavBtn, 'click', () => this._toggleFavouritePreset());
        on(this.d.presetManageBtn, 'click', () => this._openPresetManager());
        on(this.d.presetSaveConfirm, 'click', () => this._confirmSaveUserPreset());
        on(this.d.presetSaveCancel, 'click', () => this._cancelSaveUserPreset());
        on(this.d.presetSaveInput, 'keydown', (e) => { if (e.key === 'Enter') this._confirmSaveUserPreset(); if (e.key === 'Escape') this._cancelSaveUserPreset(); });
        on(this.d.presetImportBtn, 'click', () => this._importPresets());
        on(this.d.presetExportBtn, 'click', () => this._exportPresets());
        on(this.d.qualitySlider, 'input', () => {
            this._applyQualityLevel(parseInt(this.d.qualitySlider.value, 10));
        });
        on(this.d.nMelsInput, 'change', () => { this._clearPresetHighlight(); this._syncQualitySlider(); if (this.audioBuffer) this._generateSpectrogram(); });
        on(this.d.pcenEnabledCheck, 'change', () => { this._updatePcenSectionDimming(); this._clearPresetHighlight(); if (this.audioBuffer) this._generateSpectrogram(); });
        on(this.d.pcenGainInput, 'change', () => { this._clearPresetHighlight(); if (this.audioBuffer) this._generateSpectrogram(); });
        on(this.d.pcenBiasInput, 'change', () => { this._clearPresetHighlight(); if (this.audioBuffer) this._generateSpectrogram(); });
        on(this.d.pcenRootInput, 'change', () => { this._clearPresetHighlight(); if (this.audioBuffer) this._generateSpectrogram(); });
        on(this.d.pcenSmoothingInput, 'change', () => { this._clearPresetHighlight(); if (this.audioBuffer) this._generateSpectrogram(); });
        on(this.d.windowSizeSelect, 'change', () => { this._clearPresetHighlight(); this._syncQualitySlider(); if (this.audioBuffer) this._generateSpectrogram(); });
        on(this.d.overlapSelect, 'change', () => { this._clearPresetHighlight(); this._syncQualitySlider(); if (this.audioBuffer) this._generateSpectrogram(); });
        on(this.d.oversamplingSelect, 'change', () => { this._clearPresetHighlight(); this._syncQualitySlider(); if (this.audioBuffer) this._generateSpectrogram(); });
        on(this.d.windowFunctionSelect, 'change', () => { this._clearPresetHighlight(); if (this.audioBuffer) this._generateSpectrogram(); });
        on(this.d.reassignedCheck, 'change', () => { this._clearPresetHighlight(); if (this.audioBuffer) this._generateSpectrogram(); });
        // Noise reduction and CLAHE only need Stage 1 rebuild (no new FFT)
        on(this.d.noiseReductionCheck, 'change', () => {
            this._persistCurrentSettings();
            if (this.spectrogramData) { this._buildSpectrogramGrayscale(); this._buildSpectrogramBaseImage(); this._drawSpectrogram(); }
        });
        on(this.d.claheCheck, 'change', () => {
            this._persistCurrentSettings();
            if (this.spectrogramData) { this._buildSpectrogramGrayscale(); this._buildSpectrogramBaseImage(); this._drawSpectrogram(); }
        });
        on(this.d.maxFreqSelect, 'change', () => {
            if (this.audioBuffer && this.spectrogramData && this.spectrogramFrames > 0) {
                this._freqViewMin = null;
                this._freqViewMax = null;
                this._emit('spectrogramscalechange', { maxFreq: parseFloat(this.d.maxFreqSelect.value) });
                this._updateCoords();
                this._createFrequencyLabels();
                this._buildSpectrogramGrayscale();  // maxFreq affects spatial layout
                this._buildSpectrogramBaseImage();
                this._drawSpectrogram();
                if (this.d.freqZoomResetBtn) this.d.freqZoomResetBtn.hidden = true;
            }
        });
        on(this.d.colorSchemeSelect, 'change', () => {
            this.currentColorScheme = this.d.colorSchemeSelect.value;
            this._persistCurrentSettings();
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
        on(this.d.gainModeSelect, 'change', () => {
            this._persistCurrentSettings();
            if (this.d.gainModeSelect.value === 'auto' && this.spectrogramData) {
                this._autoContrast(true);
            }
        });
        on(this.d.maxFreqModeSelect, 'change', () => {
            this._persistCurrentSettings();
            if (!this.audioBuffer) return;
            const mode = this.d.maxFreqModeSelect.value;
            if (mode === 'auto') this._autoFrequency(true);
            else if (mode === 'nyquist') { this._setMaxFreqToNyquist(); this._generateSpectrogram(); }
        });
        on(this.d.floorSlider, 'input', () => { this._persistCurrentSettings(); rebuildDisplay(); });
        on(this.d.ceilSlider, 'input', () => { this._persistCurrentSettings(); rebuildDisplay(); });
        on(this.d.autoContrastBtn, 'click', () => this._autoContrast(true));
        on(this.d.autoFreqBtn, 'click', () => this._autoFrequency(true));

        // ── Canvas interaction ──
        on(this.d.canvasWrapper, 'click', (e) => this._handleCanvasClick(e));
        on(this.d.canvasWrapper, 'dblclick', (e) => {
            if (e.shiftKey) { e.preventDefault(); this._resetFreqView(); }
        });
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
            const xNorm = clamp((e.clientX - rect.left) / rect.width, 0, 1);
            this._seekToTime(xNorm * this.audioBuffer.duration, true);
        });

        // ── Window ──
        on(window, 'resize', () => {
            this._queueCompactToolbarLayoutRefresh();
            if (!this._shouldCompactToolbarBeActive()) this._setCompactToolbarOpen(false);
            if (!this.audioBuffer) return;
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
