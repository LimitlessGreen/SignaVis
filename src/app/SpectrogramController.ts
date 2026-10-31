// ═══════════════════════════════════════════════════════════════════════
// SpectrogramController.ts — spectrogram data, pipeline, and rendering
//
// Owns all spectrogram state (Float32Array data, processed images, metadata)
// and the four-stage pipeline: compute → grayscale → colorize → render.
//
// Events emitted (via EventTarget):
//   'transportstatechange' — { state, reason }
//   'progress'             — { chunk, totalChunks, percent }
//   'computetime'          — { durationMs }
//   'ready'                — { duration, sampleRate, nFrames, nMels, external?, externalImage?, freqRange?, freqScale? }
//   'error'                — { message, source: 'spectrogram' }
//   'scalechange'          — { maxFreq }   (fired by autoFrequency / setMaxFreqToNyquist)
//   'needsredraw'          — {}            (fired to request a full redraw pass from the host)
// ═══════════════════════════════════════════════════════════════════════

import {
    PERCH_FRAME_RATE,
    CQT_FMIN, CQT_BINS_PER_OCTAVE,
    windowHopFromOverlap,
    fftSizeFromOversampling,
    WASM_TILE_MIN_DURATION_SEC,
    DB_CONTRAST,
    AUTO_CONTRAST,
} from '../shared/constants.ts';

import { WasmTileManager, isWasmTileSource, isWavFile, pcmWavBlob, wasmV2ParamsFromDspOptions, v2BinFrequencies, type TileColorOptions } from './WasmTileManager.ts';
// Type-only: the service pulls in Vite worker/wasm imports, so it is loaded lazily.
import type { WasmSpectrogramService, StftParamsV2 } from '../infrastructure/wasm-dsp/WasmSpectrogramService.ts';

import {
    updateSpectrogramStats as computeSpectrogramStats,
    autoContrastStats,
    sampleFrameValues,
    visibleContrastPoints,
    noiseFloorStats,
    detectMaxFrequency,
    buildSpectrogramGrayscale,
    colorizeSpectrogram,
    windowGrayscale,
    getSpectrogramColor,
    limitBandFloor,
    drawTimeGrid,
    GpuColorizer,
    renderSpectrogram,
    createSpectralFeaturesProcessor,
} from '../domain/spectrogram.ts';

import { GpuSpectrogramView } from '../domain/spectrogramGpu.ts';
import { computeSpectralFeatures, computeRidges, type SpectralFeatures, type Ridge } from '../domain/spectralFeatures.ts';
import { spectrogramCache } from '../infrastructure/SpectrogramCache.ts';
import { setOverlayContent } from '../ui/loadingOverlay.ts';

/**
 * SpectrogramController — owns spectrogram state and the compute/render pipeline.
 *
 * @param {Object} d  DOM element refs (same shape as PlayerState.d)
 */
export class SpectrogramController extends EventTarget {
    _d: any;
    colorizer: any;
    _data: Float32Array | null;
    _nFrames: number;
    _nMels: number;
    _hopSize: number;
    _winLength: number;
    _activeScale: string;
    _colourScale: string;
    _absLogMin: number;
    _absLogMax: number;
    /** Current data comes from the v2 engine (dBFS / PCEN, noise-floor contrast). */
    _engineV2 = false;
    /** Local file path of the audio (desktop app), for the native pyramid. */
    _sourcePath: string | null = null;
    /** Direct viewport renderer for v2 data (replaces stages 1–2 when eligible). */
    _gpuView: GpuSpectrogramView | null = null;
    /** Data the GPU view refused (too large), so the CPU path is used for it. */
    _gpuRefused: unknown = null;
    _gpuFloorRef: unknown = null;
    /** v2: per-band noise floor (dB) of _data, for noise reduction. */
    _bandFloor: ArrayLike<number> | null = null;
    /** Last drawn time span and zoom, for auto contrast on what is visible. */
    _lastView: { t0: number; t1: number; pps: number } | null = null;
    /** Auto gain mode: redo auto contrast once the first drawn view has tiles. */
    _autoContrastPending = false;
    /** Floor/ceil sliders in dB (v2) or % (legacy); null until first synced. */
    _gainDbMode: boolean | null = null;
    /** Stage-1 image holds raw dB values (window applied in stage 2). */
    _grayRaw = false;
    /** dB window baked into a normalised stage-1 image (CLAHE), to detect slider changes. */
    _grayWindowKey: string | null = null;
    _v2Params: StftParamsV2 | null = null;
    _binFreqsMemo: { params: StftParamsV2; sampleRate: number; freqs: Float64Array } | null = null;
    /** Lazily created WASM service for whole-file v2 computation. */
    _wasmSvc: Promise<WasmSpectrogramService> | null = null;
    _baseCanvas: HTMLCanvasElement | null;
    _grayInfo: { gray: Float32Array; width: number; height: number } | null;
    _gpuReady: boolean;
    _externalMode: boolean;
    _externalImageConfig: { freqRange: [number, number] | null; freqScale: string | null } | null;
    _audioBuffer: AudioBuffer | null;
    _tileManager: WasmTileManager | null;
    _sourceFile: File | null;
    _spectralFeatures: SpectralFeatures | null;
    _ridges: Ridge[] | null;
    _sfProcessor: ReturnType<typeof createSpectralFeaturesProcessor>;
    _sfGeneration: number;
    _sampleRateHz: number;
    _zoomRedrawRafId: number;
    _freqAxisRafId: number | undefined;
    _lastFreqAxisH: number;
    value: any;
    constructor(d: any) {
        super();
        this._d = d;
        this.colorizer = new GpuColorizer();
        this._sfProcessor = createSpectralFeaturesProcessor();
        this._sfGeneration = 0;

        // ── Spectrogram data ──────────────────────────────────────────
        /** @type {Float32Array|null} */
        this._data = null;
        this._nFrames = 0;
        this._nMels = 0;
        this._hopSize = 0;
        this._winLength = 0;
        /** @type {string} */
        this._activeScale = 'mel';
        /** @type {string} */
        this._colourScale = 'dbSquared';
        this._absLogMin = 0;
        this._absLogMax = 1;

        // ── Rendered image state ──────────────────────────────────────
        /** @type {HTMLCanvasElement|OffscreenCanvas|null} */
        this._baseCanvas = null;
        /** @type {{gray: Uint8Array, width: number, height: number}|null} */
        this._grayInfo = null;
        this._gpuReady = false;

        // ── External injection mode ───────────────────────────────────
        this._externalMode = false;
        /** @type {{freqRange: [number,number]|null, freqScale: string|null}|null} */
        this._externalImageConfig = null;

        // ��─ Audio reference (set by host on each load) ────────────────
        /** @type {AudioBuffer|null} */
        this._audioBuffer = null;
        this._sampleRateHz = 44100;
        this._tileManager = null;
        this._sourceFile = null;
        this._spectralFeatures = null;
        this._ridges = null;

        // Internal redraw debounce rAF id
        this._zoomRedrawRafId = 0;
        // Freq-axis height sync rAF id
        this._freqAxisRafId = /** @type {number|undefined} */ (undefined);
        this._lastFreqAxisH = 0;
    }

    // ── Getters (read by PlayerState for coords, crosshair, etc.) ────

    get data()                { return this._data; }
    get nFrames()             { return this._nFrames; }
    get nMels()               { return this._nMels; }
    /** Exact row frequencies when the v2 engine produced the data, else null (legacy axis formulas). */
    get binFreqs(): Float64Array | null {
        if (this._tileManager) return this._tileManager instanceof WasmTileManager ? this._tileManager.binFreqs : null;
        const params = this._v2Params, sampleRate = this._audioBuffer?.sampleRate;
        if (!this._engineV2 || !params || !sampleRate) return null;
        const m = this._binFreqsMemo;
        if (m?.params === params && m.sampleRate === sampleRate) return m.freqs;
        this._binFreqsMemo = { params, sampleRate, freqs: v2BinFrequencies(params, sampleRate) };
        return this._binFreqsMemo.freqs;
    }
    get hopSize()             { return this._hopSize; }
    get winLength()           { return this._winLength; }
    get baseCanvas()          { return this._baseCanvas; }
    get grayInfo()            { return this._grayInfo; }
    get absLogMin()           { return this._absLogMin; }
    get absLogMax()           { return this._absLogMax; }
    get activeScale()         { return this._activeScale; }
    get colourScale()         { return this._colourScale; }
    get externalMode()        { return this._externalMode; }
    get externalImageConfig() { return this._externalImageConfig; }
    /** True when there is valid spectrogram data to render. */
    get hasData()             { return this._tileManager ? this._tileManager.hasTiles : (this._data !== null && this._nFrames > 0); }
    get isTileMode()          { return this._tileManager !== null; }

    // ── Host-side audio reference ────────────────────────────────────

    /**
     * Called by PlayerState whenever a new audio file is loaded.
     * @param {AudioBuffer} audioBuffer
     * @param {number} sampleRateHz
     * @param {File|null} [sourceFile]  source file (or URL placeholder); enables the WASM tile pipeline
     */
    setAudio(audioBuffer: AudioBuffer, sampleRateHz: number, sourceFile: File | null = null, sourcePath: string | null = null) {
        this._sourcePath = sourcePath;
        this._tileManager?.dispose();
        this._tileManager    = null;
        this._spectralFeatures = null;
        this._ridges           = null;
        this._audioBuffer    = audioBuffer;
        this._lastView       = null; // span of the previous file
        this._sourceFile     = sourceFile;
        this._sampleRateHz = sampleRateHz;
        this._externalMode = false;
        this._externalImageConfig = null;
        this._data = null;
        this._nFrames = 0;
        this._nMels = 0;
        this._baseCanvas = null;
        this._grayInfo = null;
        // Rebuild the max-freq <select> immediately so Nyquist options reflect the
        // new recording's sample rate before generate() / cache lookup runs.
        this.updateMaxFreqOptions(sampleRateHz);
    }

    /** Reset external mode without clearing audio (used on zoom / reload). */
    clearExternalMode() {
        this._externalMode = false;
        this._externalImageConfig = null;
    }

    // ── Pipeline ─────────────────────────────────────────────────────

    /**
     * Full compute pipeline: DSP → store data → optional auto-adjust → Stage 1+2+3.
     * @param {{ autoAdjust?: boolean }} [opts]
     */
    async generate({ autoAdjust = false } = {}) {
        if (!this._audioBuffer) return;
        if (this._externalMode) return;

        const d = this._d;
        if (d.recomputingOverlay) {
            setOverlayContent(d.recomputingOverlay, 'Computing spectrogram…', { progress: null });
            d.recomputingOverlay.hidden = false;
        }
        this._emit('transportstatechange', { state: 'rendering', reason: 'spectrogram-generate' });

        // Yield so the "Computing…" overlay is painted before heavy DSP blocks the thread.
        await new Promise(r => requestAnimationFrame(() => setTimeout(r, 0)));

        const scale          = d.scaleSelect?.value || 'mel';
        const colourScale    = d.colourScaleSelect?.value || 'dbSquared';
        const windowSize     = parseInt(d.windowSizeSelect?.value || '1024', 10);
        const overlapLevel   = parseInt(d.overlapSelect?.value || '2', 10);
        const oversamplingLevel = parseInt(d.oversamplingSelect?.value || '0', 10);
        const hopSize        = windowHopFromOverlap(windowSize, overlapLevel);
        const fftSize        = fftSizeFromOversampling(windowSize, oversamplingLevel);
        const windowFunction = d.windowFunctionSelect?.value || 'hann';
        const nMels          = Math.max(16, Math.min(512, parseInt(d.nMelsInput?.value || '160', 10) || 160));
        const useReassigned  = d.reassignedCheck?.checked ?? false;

        const pcenTimeConstant = Math.max(0.01, parseFloat(d.pcenTimeConstantInput?.value || '0.4') || 0.4);

        const effectiveNMels = scale === 'cqt'
            // floor: the top band edge (one step above the last centre) must stay ≤ Nyquist for v2.
            ? Math.floor(Math.log2((this._audioBuffer.sampleRate / 2) / CQT_FMIN) * CQT_BINS_PER_OCTAVE - 1e-9)
            : nMels;

        const options = {
            scale,
            colourScale,
            sampleRate: this._audioBuffer.sampleRate,
            fftSize,
            windowFunction,
            nMels: effectiveNMels,
            frameRate: PERCH_FRAME_RATE,
            usePcen:        d.pcenEnabledCheck?.checked ?? true,
            pcenGain:       parseFloat(d.pcenGainInput?.value    || '0.8'),
            pcenBias:       parseFloat(d.pcenBiasInput?.value    || '0.01'),
            pcenRoot:       parseFloat(d.pcenRootInput?.value    || '4.0'),
            pcenTimeConstant,
            // Legacy JS/v1 engines take a per-frame smoother coefficient.
            pcenSmoothing:  Math.min(1, hopSize / (this._audioBuffer.sampleRate * pcenTimeConstant)),
            windowSize,
            hopSize,
        };

        this._activeScale = scale;

        const v2Params = wasmV2ParamsFromDspOptions({ ...options, reassigned: useReassigned });
        this._v2Params = v2Params;
        // Part of the cache key, so results of older engines are never reused.
        (options as Record<string, unknown>).engine = 'v2';

        // ── Tile mode for long audio ─────────────────────────────────────
        // WASM pyramid for long local files (WAV read directly, other formats from
        // the decoded PCM); on failure the whole file is computed in one piece.
        if (v2Params && isWasmTileSource(this._sourceFile)
            && this._audioBuffer.duration >= WASM_TILE_MIN_DURATION_SEC) {
            const file = this._sourceFile;
            const audioBuffer = this._audioBuffer;
            const ok = await this._startTileMode(options, autoAdjust, () => WasmTileManager.create({
                file,
                nativePath:   this._sourcePath,
                source:       isWavFile(file) ? undefined : pcmWavBlob(audioBuffer.getChannelData(0), audioBuffer.sampleRate),
                wasmParams:   v2Params,
                duration:     this._audioBuffer!.duration,
                colorOptions: this._getCurrentColorOptions(),
                onProgress:   (f) => this._emit('progress', { chunk: 0, totalChunks: 0, percent: Math.round(f * 100) }),
            })).then(() => true, (err) => {
                console.warn('Spectrogram pyramid failed, computing the whole file:', err);
                this._tileManager?.dispose();
                this._tileManager = null;
                return false;
            });
            if (ok) return;
        }

        const t0 = performance.now();

        try {
            const channelData = this._audioBuffer.getChannelData(0);

            // ── Cache lookup ─────────────────────────────────────────────
            const cacheKey = await spectrogramCache.computeKey(
                channelData,
                this._audioBuffer.sampleRate,
                options,
            );
                const cached = await spectrogramCache.get(cacheKey) as any;
            if (cached) {
                this._data        = new Float32Array(cached.dataBuffer);
                this._nFrames     = cached.nFrames;
                this._nMels       = cached.nMels;
                this._hopSize     = cached.hopSize;
                this._winLength   = cached.winLength;
                this._colourScale = cached.colourScale || colourScale;
                this._engineV2    = !!v2Params;
                this._bandFloor   = cached.bandFloor ?? null;
                this._updateStats();
                // Invalidate stage-1/2 so draw() recomputes grayscale and
                // colorization with the new scale/colourScale settings.
                this._grayInfo    = null;
                this._baseCanvas  = null;
                this._gpuReady    = false;
                // Apply the same auto-adjust logic as the DSP path so that
                // gain and freq settings (including Nyquist) are correct even
                // when the sample rate differs from the previous recording.
                if (autoAdjust) {
                    const gainMode = d.gainModeSelect?.value || 'auto';
                    if (gainMode === 'auto') this.autoContrast(false);
                    const freqMode = d.maxFreqModeSelect?.value || 'auto';
                    if (freqMode === 'auto') {
                        this.autoFrequency(false);
                    } else if (freqMode === 'nyquist') {
                        this.setMaxFreqToNyquist();
                    }
                }
                this._computeSpectralFeaturesAsync(channelData, options);
                this._emit('needsredraw');
                if (d.recomputingOverlay) d.recomputingOverlay.hidden = true;
                this._emit('transportstatechange', { state: 'ready', reason: 'spectrogram-ready' });
                this._emit('computetime', { durationMs: 0 });
                this._emit('ready', {
                    duration: this._audioBuffer.duration,
                    sampleRate: this._audioBuffer.sampleRate,
                    nFrames: this._nFrames,
                    nMels: this._nMels,
                    fromCache: true,
                });
                return;
            }
            // ── Cache miss: run DSP ──────────────────────────────────────

            if (!v2Params) throw new Error(`Unsupported spectrogram settings (scale ${scale}, window ${windowFunction})`);
            const result = await this._computeV2(channelData, v2Params, colourScale);
            this._engineV2 = true;

            this._data      = result.data;
            this._nFrames   = result.nFrames;
            this._nMels     = result.nMels;
            this._hopSize   = result.hopSize || Math.max(1, Math.floor(this._sampleRateHz / PERCH_FRAME_RATE));
            this._winLength = result.winLength || 4 * this._hopSize;
            this._colourScale = result.colourScale || colourScale;
            this._bandFloor   = result.bandFloor ?? null;

            // Persist to cache (non-blocking).
            spectrogramCache.set(cacheKey, {
                dataBuffer: new Uint8Array(((this._data as Float32Array)).buffer).slice().buffer,
                nFrames:    this._nFrames,
                nMels:      this._nMels,
                hopSize:    this._hopSize,
                winLength:  this._winLength,
                colourScale: this._colourScale,
                bandFloor:   this._bandFloor ? Array.from(this._bandFloor) : undefined,
            }).catch(() => {/* ignore storage errors */});

            this._updateStats();

            // Invalidate stage-1/2 so draw() recomputes grayscale and
            // colorization with the new settings.
            this._grayInfo   = null;
            this._baseCanvas = null;
            this._gpuReady   = false;

            this._computeSpectralFeaturesAsync(channelData, options);

            if (autoAdjust) {
                const gainMode = d.gainModeSelect?.value || 'auto';
                if (gainMode === 'auto') this.autoContrast(false);

                const freqMode = d.maxFreqModeSelect?.value || 'auto';
                if (freqMode === 'auto') {
                    this.autoFrequency(false);
                } else if (freqMode === 'nyquist') {
                    this.setMaxFreqToNyquist();
                }
            }

            // Notify host to rebuild coords + freq labels before rendering
            this._emit('needsredraw');

            if (d.recomputingOverlay) d.recomputingOverlay.hidden = true;
            this._emit('transportstatechange', { state: 'ready', reason: 'spectrogram-ready' });
            this._emit('computetime', { durationMs: Math.round(performance.now() - t0) });
            this._emit('ready', {
                duration: this._audioBuffer.duration,
                sampleRate: this._audioBuffer.sampleRate,
                nFrames: this._nFrames,
                nMels: this._nMels,
            });
        } catch (error) {
            if (d.recomputingOverlay) d.recomputingOverlay.hidden = true;
            this._emit('transportstatechange', { state: 'error', reason: 'spectrogram-error' });
            this._emit('error', { message: (error as any)?.message || String(error), source: 'spectrogram' });
            throw error;
        }
    }

    // ── Tile mode ─────────────────────────────────────────────────────

    private async _startTileMode(
        dspOptions: Record<string, any>,
        autoAdjust: boolean,
        createManager: () => Promise<WasmTileManager>,
    ): Promise<void> {
        const d = this._d;
        if (d.recomputingOverlay) {
            setOverlayContent(d.recomputingOverlay, 'Computing spectrogram…', { progress: null });
            d.recomputingOverlay.hidden = false;
        }
        this._emit('transportstatechange', { state: 'rendering', reason: 'spectrogram-generate' });

        // Dispose any previous tile manager.
        this._tileManager?.dispose();
        this._tileManager = null;
        this._data = null;
        this._nFrames = 0;
        this._grayInfo = null;
        this._baseCanvas = null;

        const t0 = performance.now();
        const audioBuffer = this._audioBuffer!;
        const tm = await createManager();
        if (this._audioBuffer !== audioBuffer) { tm.dispose(); return; } // another file was loaded meanwhile

        this._tileManager = tm;
        this._nMels = tm.nMels;
        if (tm instanceof WasmTileManager) {
            this._hopSize = tm.hopSize;
            this._winLength = tm.winLength;
        }

        // Forward tile-ready events as needsredraw to PlayerState.
        tm.addEventListener('tileready', () => {
            // Sync absLogMin/Max so autoContrast works correctly.
            this._absLogMin = tm.globalMin;
            this._absLogMax = tm.globalMax;
            // Auto mode ran on the first tile only; redo it on what is actually drawn.
            if (this._autoContrastPending && this._lastView && this._tileManager === tm) {
                this._autoContrastPending = false;
                this.autoContrast(false);
                tm.updateColorOptions(this._getCurrentColorOptions()); // fires tileready again
            }
            this._emit('needsredraw');
        });

        // Compute first tile synchronously so auto-adjust has real data.
        await tm.computeFirstTile();

        if (this._tileManager !== tm) return; // superseded by a newer generate() call

        // Immediately queue all remaining tiles for background computation so
        // the full spectrogram is available without further scrolling.
        tm.queueAllTiles();

        this._absLogMin = tm.globalMin;
        this._absLogMax = tm.globalMax;

        if (autoAdjust) {
            const gainMode = d.gainModeSelect?.value || 'auto';
            if (gainMode === 'auto') {
                this.autoContrast(false);
                this._autoContrastPending = true;
            }
            const freqMode = d.maxFreqModeSelect?.value || 'auto';
            if (freqMode === 'auto') {
                this.autoFrequency(false);
            } else if (freqMode === 'nyquist') {
                this.setMaxFreqToNyquist();
            }
        }
        // Auto-adjust may have changed maxFreq / floor / ceil after the first tile was colorized.
        tm.updateColorOptions(this._getCurrentColorOptions());

        if (d.recomputingOverlay) d.recomputingOverlay.hidden = true;
        this._emit('transportstatechange', { state: 'ready', reason: 'spectrogram-ready' });
        this._emit('computetime', { durationMs: Math.round(performance.now() - t0) });
        this._emit('ready', {
            duration:   this._audioBuffer!.duration,
            sampleRate: this._audioBuffer!.sampleRate,
            nFrames:    0,
            nMels:      tm.nMels,
            wasmTiles:  tm instanceof WasmTileManager,
        });
        this._emit('needsredraw');
    }

    private _getCurrentColorOptions(): TileColorOptions {
        const d = this._d;
        this._syncGainSliders();
        const db = this._gainDbMode;
        return {
            ...(db ? {
                floorDb: parseFloat(d.floorSlider?.value || String(DB_CONTRAST.floor.def)),
                rangeDb: parseFloat(d.ceilSlider?.value  || String(DB_CONTRAST.range.def)),
            } : {}),
            colorScheme:    d.colorSchemeSelect?.value    || 'grayscale',
            maxFreq:        parseFloat(d.maxFreqSelect?.value || '10000'),
            floor01:        parseFloat(d.floorSlider?.value   || '0')   / 100,
            ceil01:         parseFloat(d.ceilSlider?.value    || '100') / 100,
            noiseReduction: d.noiseReductionCheck?.checked ?? false,
            clahe:          d.claheCheck?.checked          ?? false,
            scale:          d.scaleSelect?.value           || 'mel',
            colourScale:    d.colourScaleSelect?.value     || 'dbSquared',
        };
    }

    // ── Spectral features (centroid + F0) ────────────────────────────

    // Kicks off feature computation off the main thread via the worker.
    // Results arrive asynchronously; each phase emits 'needsredraw' when done.
    private _computeSpectralFeaturesAsync(channelData: Float32Array, dspOptions: Record<string, any>): void {
        this._spectralFeatures = null;
        this._ridges = null;
        const hopSize    = dspOptions.hopSize    || this._hopSize    || 320;
        const windowSize = dspOptions.windowSize || this._winLength  || 1024;
        const nFrames    = this._nFrames;
        if (!nFrames || !channelData?.length) return;

        const gen = ++this._sfGeneration;

        this._sfProcessor.computeFeatures(channelData, this._sampleRateHz, hopSize, windowSize, nFrames)
            .then((features) => {
                if (this._sfGeneration !== gen) return;
                this._spectralFeatures = features;
                this._emit('needsredraw');
                return this._sfProcessor.computeRidges(channelData, this._sampleRateHz, hopSize, windowSize, nFrames);
            })
            .then((ridges) => {
                if (!ridges || this._sfGeneration !== gen) return;
                this._ridges = ridges;
                this._emit('needsredraw');
            })
            .catch(() => { /* non-fatal */ });
    }

    // Draw centroid / F0 curves + gap on top of the already-rendered spectrogram.
    private _drawSpectralOverlay(
        ctx: CanvasRenderingContext2D,
        p: any,
        totalWidth: number,
        scrollLeft: number,
        viewportWidth: number,
        canvasHeight: number,
    ): void {
        const d   = this._d;
        const sf  = this._spectralFeatures;
        const showCentroid = d.showCentroidCheck?.checked && sf?.centroid;
        const showF0       = d.showF0Check?.checked       && sf?.f0;
        const showRidges   = d.showRidgesCheck?.checked   && this._ridges?.length;
        if (!showCentroid && !showF0 && !showRidges) return;

        const nFrames = this._nFrames;
        if (!nFrames) return;

        // Map frame index → viewport x pixel.
        const frameToX = (i: number) => (i / nFrames) * totalWidth - scrollLeft;
        // Map frequency in Hz → viewport y pixel (0 = top = high freq).
        const freqToY  = (hz: number) => {
            if (hz <= 0) return -1;
            const frac = p.coords.frequencyToBaseYFraction(hz);
            // Account for active frequency-viewport crop if any.
            if (p.freqViewMin != null && p.freqViewMax != null) {
                const topFrac = p.coords.frequencyToBaseYFraction(p.freqViewMax);
                const botFrac = p.coords.frequencyToBaseYFraction(p.freqViewMin);
                const span    = botFrac - topFrac;
                if (span < 1e-6) return -1;
                return ((frac - topFrac) / span) * canvasHeight;
            }
            return frac * canvasHeight;
        };

        // Colors
        const COLOR_CENTROID = '#f59e0b';          // amber
        const COLOR_F0       = '#22d3ee';          // cyan
        const COLOR_GAP      = 'rgba(167,139,250,0.25)'; // violet fill

        ctx.save();
        ctx.lineWidth   = 1.5;
        ctx.strokeStyle = COLOR_CENTROID;

        // Collect per-frame (x, y) for both curves, skipping out-of-viewport frames.
        const cx = new Float32Array(nFrames);
        const cy = new Float32Array(nFrames);
        const fx = new Float32Array(nFrames);
        const fy = new Float32Array(nFrames);

        for (let i = 0; i < nFrames; i++) {
            const x = frameToX(i);
            cx[i] = x;
            cy[i] = showCentroid ? freqToY(sf!.centroid[i]) : -1;
            fx[i] = x;
            fy[i] = showF0       ? freqToY(sf!.f0[i])       : -1;
        }

        // ── Gap fill between centroid and F0 ─────────────────────────
        if (showCentroid && showF0) {
            ctx.fillStyle = COLOR_GAP;
            ctx.beginPath();
            let started = false;
            for (let i = 0; i < nFrames; i++) {
                if (cx[i] < 0 || cx[i] > viewportWidth) continue;
                if (cy[i] < 0 || fy[i] < 0) { started = false; continue; }
                if (!started) { ctx.moveTo(cx[i], cy[i]); started = true; }
                else ctx.lineTo(cx[i], cy[i]);
            }
            for (let i = nFrames - 1; i >= 0; i--) {
                if (fx[i] < 0 || fx[i] > viewportWidth) continue;
                if (fy[i] < 0 || cy[i] < 0) continue;
                ctx.lineTo(fx[i], fy[i]);
            }
            ctx.closePath();
            ctx.fill();
        }

        // ── Centroid curve ───────────────────────────────────────────
        if (showCentroid) {
            ctx.strokeStyle = COLOR_CENTROID;
            ctx.beginPath();
            let started = false;
            for (let i = 0; i < nFrames; i++) {
                if (cx[i] < -2 || cx[i] > viewportWidth + 2) { started = false; continue; }
                if (cy[i] < 0) { started = false; continue; }
                if (!started) { ctx.moveTo(cx[i], cy[i]); started = true; }
                else ctx.lineTo(cx[i], cy[i]);
            }
            ctx.stroke();
        }

        // ── F0 curve ─────────────────────────────────────────────────
        if (showF0) {
            ctx.strokeStyle = COLOR_F0;
            ctx.beginPath();
            let started = false;
            for (let i = 0; i < nFrames; i++) {
                if (fx[i] < -2 || fx[i] > viewportWidth + 2) { started = false; continue; }
                if (fy[i] < 0) { started = false; continue; } // unvoiced gap
                if (!started) { ctx.moveTo(fx[i], fy[i]); started = true; }
                else ctx.lineTo(fx[i], fy[i]);
            }
            ctx.stroke();
        }

        // ── Spectral ridges ───────────────────────────────────────────
        if (showRidges && this._ridges) {
            // Sort weakest first so strong ridges render on top.
            const sorted = [...this._ridges].sort((a, b) => {
                const ma = a.strength.reduce((s, v) => s + v, 0) / a.strength.length;
                const mb = b.strength.reduce((s, v) => s + v, 0) / b.strength.length;
                return ma - mb;
            });

            for (const ridge of sorted) {
                const len = ridge.frames.length;
                // Mean strength → line alpha and width
                let meanStr = 0;
                for (let i = 0; i < len; i++) meanStr += ridge.strength[i];
                meanStr /= len;

                const alpha = 0.25 + meanStr * 0.65;   // 0.25 – 0.90
                const lw    = 0.8 + meanStr * 1.2;      // 0.8 – 2.0 px

                // Hue based on median frequency: low→warm(30°) high→cool(200°)
                const nyquist   = this._sampleRateHz / 2;
                let   medianHz  = ridge.freqHz[Math.floor(len / 2)];
                const hue       = 30 + (medianHz / nyquist) * 170; // 30°–200°
                ctx.strokeStyle = `hsla(${hue.toFixed(0)},100%,75%,${alpha.toFixed(2)})`;
                ctx.lineWidth   = lw;

                ctx.beginPath();
                let started = false;
                for (let i = 0; i < len; i++) {
                    const x = frameToX(ridge.frames[i]);
                    if (x < -2 || x > viewportWidth + 2) { started = false; continue; }
                    const y = freqToY(ridge.freqHz[i]);
                    if (y < 0) { started = false; continue; }
                    if (!started) { ctx.moveTo(x, y); started = true; }
                    else ctx.lineTo(x, y);
                }
                ctx.stroke();
            }
            // Restore line width for subsequent draws
            ctx.lineWidth = 1.5;
        }

        ctx.restore();
    }

    // ── External injection ────────────────────────────────────────────

    /**
     * Mode 1: inject raw Float32Array data — enters pipeline at Stage 1 (grayscale → colorize → render).
     */
    setExternalData(data: Float32Array | ArrayBuffer | string, nFrames: number, nMels: number, options: any = {}) {
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

        this._externalMode = true;
        this._data    = floats;
        this._nFrames = nFrames;
        this._nMels   = nMels;
        this._engineV2 = false;   // external data uses the legacy axis formulas

        if (options.sampleRate) {
            this._sampleRateHz = options.sampleRate;
            this.updateMaxFreqOptions(options.sampleRate);
        }
        if (options.scale && this._d.scaleSelect) {
            this._d.scaleSelect.value = options.scale;
        }

        this._updateStats();

        const gainMode = this._d.gainModeSelect?.value || 'auto';
        if (gainMode === 'auto') this.autoContrast(false);
        const freqMode = this._d.maxFreqModeSelect?.value || 'auto';
        if (freqMode === 'auto') {
            this.autoFrequency(false);
        } else if (freqMode === 'nyquist') {
            this.setMaxFreqToNyquist();
        }

        this._emit('needsredraw');
        this._emit('transportstatechange', { state: 'ready', reason: 'spectrogram-external-data' });
        this._emit('ready', {
            duration: this._audioBuffer?.duration || 0,
            sampleRate: this._sampleRateHz,
            nFrames: this._nFrames,
            nMels: this._nMels,
            external: true,
        });
    }

    /**
     * Mode 2: inject a pre-rendered image — bypasses DSP + colorization.
     * @returns {Promise<void>}
     */
    async setExternalImage(image: HTMLImageElement | HTMLCanvasElement | string, options: any = {}): Promise<void> {
        return new Promise<void>((resolve, reject) => {
            const apply = (img: HTMLImageElement | HTMLCanvasElement) => {
                const canvas = document.createElement('canvas');
                canvas.width  = (img as any).naturalWidth  || (img as any).width;
                canvas.height = (img as any).naturalHeight || (img as any).height;
                const ctx = canvas.getContext('2d');
                if (!ctx) { reject(new Error('Could not get 2d context')); return; }
                ctx.drawImage(img as CanvasImageSource, 0, 0);

                this._externalMode  = true;
                this._baseCanvas    = canvas;
                this._data          = new Float32Array(0);
                this._nFrames       = canvas.width;
                this._nMels         = canvas.height;
                this._grayInfo      = null;

                this._externalImageConfig = (options.freqRange || options.freqScale)
                    ? { freqRange: options.freqRange || null, freqScale: options.freqScale || null }
                    : null;

                if (options.sampleRate) {
                    this._sampleRateHz = options.sampleRate;
                    this.updateMaxFreqOptions(options.sampleRate);
                }

                this.setDspControlsEnabled(false);

                this._emit('needsredraw');
                this._emit('transportstatechange', { state: 'ready', reason: 'spectrogram-external-image' });
                this._emit('ready', {
                    duration: this._audioBuffer?.duration || 0,
                    sampleRate: this._sampleRateHz,
                    nFrames: this._nFrames,
                    nMels: this._nMels,
                    external: true,
                    externalImage: true,
                    freqRange: options.freqRange || null,
                    freqScale: options.freqScale || null,
                });
                resolve();
            };

            if (image instanceof HTMLCanvasElement || (image instanceof HTMLImageElement && image.complete)) {
                apply(image as HTMLImageElement | HTMLCanvasElement);
            } else if (image instanceof HTMLImageElement) {
                image.onload = () => apply(image);
                image.onerror = reject;
            } else if (typeof image === 'string') {
                const img = new Image();
                img.onload  = () => apply(img);
                img.onerror = reject;
                img.src = image;
            } else {
                reject(new Error('setSpectrogramImage: unsupported image type'));
            }
        });
    }

    // ── Rendering stages ─────────────────────────────────────────────

    /**
     * Stage 1 — expensive: spectrogram data → float32 grayscale.
     * Run once per audio/FFT/frequency change.
     */
    buildGrayscale() {
        if (this._tileManager) {
            this._tileManager.updateColorOptions(this._getCurrentColorOptions());
            return;
        }
        if (!this._data) return;
        const d = this._d;
        this._syncGainSliders();
        if (this._gpuViewEligible()) { this._grayInfo = null; return; }
        const colourScale = this._colourScale || d.colourScaleSelect?.value || 'dbSquared';
        const clahe = d.claheCheck?.checked ?? false;
        const win = this._dbWindow();
        // Without CLAHE the dB window is a pure stage-2 operation (shader); CLAHE
        // equalises a normalised image, so the window has to be applied first.
        this._grayRaw = !!win && !clahe && colourScale !== 'phase';
        this._grayWindowKey = win && !this._grayRaw ? win.join() : null;
        const [absMin, absMax] = win && !this._grayRaw ? win : [this._absLogMin, this._absLogMax];
        this._grayInfo = buildSpectrogramGrayscale({
            spectrogramData:    this._data,
            spectrogramFrames:  this._nFrames,
            spectrogramMels:    this._nMels,
            sampleRateHz:       this._sampleRateHz,
            maxFreq:            parseFloat(d.maxFreqSelect?.value || '10000'),
            spectrogramAbsLogMin: absMin,
            spectrogramAbsLogMax: absMax,
            scale:       this._activeScale || d.scaleSelect?.value || 'mel',
            binFreqs:    this.binFreqs,
            colourScale,
            noiseReduction: d.noiseReductionCheck?.checked ?? false,
            clahe,
            raw:         this._grayRaw,
            bandFloor:   this._bandFloor,
        }) as { gray: Float32Array; width: number; height: number } | null;
        if (this._grayInfo && this.colorizer.ok) {
            const { gray, width, height } = this._grayInfo;
            this._gpuReady = this.colorizer.uploadGrayscale(gray, width, height);
        } else {
            this._gpuReady = false;
        }
    }

    /**
     * Stage 2 — fast: grayscale → colored canvas.
     * GPU path: ~0.1 ms. JS fallback: ~20–80 ms.
     * @param {string} colorScheme
     * @returns {HTMLCanvasElement|OffscreenCanvas|null}
     */
    buildBaseImage(colorScheme: any) {
        if (this._tileManager) {
            this._tileManager.updateColorOptions(this._getCurrentColorOptions());
            return null;
        }
        this._syncGainSliders();
        if (this._gpuViewEligible()) { this._baseCanvas = null; return null; }
        const win = this._dbWindow();
        if (!this._grayInfo || (win && !this._grayRaw && win.join() !== this._grayWindowKey)) this.buildGrayscale();
        const d = this._d;
        // Raw dB image: the window is the dB range itself. Normalised image: % sliders,
        // or [0, 1] when the dB window was already applied in stage 1.
        const [lo, hi] = this._grayRaw && win ? win
            : win ? [0, 1]
            : [parseFloat(d.floorSlider?.value || '0') / 100, parseFloat(d.ceilSlider?.value || '100') / 100];

        if (this._gpuReady && this._grayInfo) {
            this.colorizer.uploadColorLut(colorScheme);
            this.colorizer.render(lo, hi);
            this._baseCanvas = this.colorizer.canvas;
        } else if (this._grayRaw && this._grayInfo) {
            this._baseCanvas = colorizeSpectrogram(windowGrayscale(this._grayInfo, lo, hi), 0, 1, colorScheme);
        } else {
            this._baseCanvas = colorizeSpectrogram(this._grayInfo, lo, hi, colorScheme);
        }
        return this._baseCanvas;
    }

    /**
     * Stage 3 — render the spectrogram to the visible canvas.
     *
     * @param {Object} p
     * @param {boolean}  p.show              - Whether the spectrogram pane is visible
     * @param {number}   p.pixelsPerSecond
     * @param {number|null} p.freqViewMin
     * @param {number|null} p.freqViewMax
     * @param {import('../domain/coordinateSystem.ts').CoordinateSystem} p.coords
     * @param {number}   p.effectiveHeight
     * @param {number}   p.currentTime       - for the UI-update after draw
     * @param {number}   p.scrollLeft
     * @param {number}   p.viewportWidth
     * @param {string}   p.colorScheme       - needed if baseCanvas is missing
     */
    draw(p: any) {
        if (!p.show) return;
        if (!this._audioBuffer) return;

        // ── Tile mode ──────────────────────────────────────────────────
        if (this._tileManager) {
            const tm           = this._tileManager;
            const duration     = this._audioBuffer.duration;
            const totalWidth   = Math.max(1, Math.floor(duration * p.pixelsPerSecond));
            const canvasHeight = Math.max(140, Math.floor(p.effectiveHeight));
            const vw           = p.viewportWidth ?? 0;
            const width        = vw > 0 ? Math.min(vw, totalWidth) : totalWidth;
            const sl           = vw > 0 ? (p.scrollLeft ?? 0) : 0;
            this._lastView = { t0: sl / p.pixelsPerSecond, t1: (sl + width) / p.pixelsPerSecond, pps: p.pixelsPerSecond };

            this._sizeViewCanvas(totalWidth, width, canvasHeight);

            const ctx = this._d.spectrogramCanvas.getContext('2d');
            const gpu = ctx ? this._drawGpuTiles(tm, p, width, canvasHeight, sl) : null;
            if (ctx && gpu) {
                ctx.clearRect(0, 0, width, canvasHeight);
                ctx.drawImage(gpu, 0, 0);
                drawTimeGrid({ ctx, width, height: canvasHeight, duration, pixelsPerSecond: p.pixelsPerSecond, scrollLeft: sl });
            } else if (ctx) {
                ctx.clearRect(0, 0, width, canvasHeight);

                let freqViewSrcCrop = null;
                if (p.freqViewMin != null && p.freqViewMax != null) {
                    const baseH    = tm.nMels;
                    const srcYTop  = p.coords.frequencyToBaseYFraction(p.freqViewMax) * baseH;
                    const srcYBot  = p.coords.frequencyToBaseYFraction(p.freqViewMin) * baseH;
                    freqViewSrcCrop = { srcY: srcYTop, srcH: Math.max(1, srcYBot - srcYTop) };
                }

                tm.renderToCanvas(ctx, {
                    duration, totalDisplayWidth: totalWidth,
                    canvasHeight, scrollLeft: sl, viewportWidth: width,
                    freqViewSrcCrop,
                });
            }

            // Schedule background loading for the visible viewport.
            const startTime = sl / p.pixelsPerSecond;
            const endTime   = (sl + width) / p.pixelsPerSecond;
            tm.requestViewport(startTime, endTime, p.pixelsPerSecond);

            this._syncFreqAxisHeight();
            return;
        }

        // ── Standard (non-tile) mode ───────────────────────────────────
        if (!this._data || this._nFrames <= 0) return;
        if (!this._drawGpuView(p)) {
            if (!this._baseCanvas) this.buildBaseImage(p.colorScheme);
            if (!this._baseCanvas) return;
            this._drawBaseImage(p);
        }
        this._drawOverlays(p);
    }

    /**
     * Scroll extent and viewport canvas size. Runs on every scroll frame, so
     * unchanged sizes are left alone: a canvas resize reallocates its bitmap
     * and a style write invalidates layout. A kept canvas gets the state a
     * resize would have reset.
     */
    private _sizeViewCanvas(totalWidth: number, width: number, height: number) {
        const sizer = this._d.canvasSizer as HTMLElement | null;
        const w = `${totalWidth}px`;
        if (sizer && sizer.style.width !== w) sizer.style.width = w;
        const canvas = this._d.spectrogramCanvas as HTMLCanvasElement;
        if (canvas.width !== width || canvas.height !== height) {
            canvas.width = width;
            canvas.height = height;
            return;
        }
        const ctx = canvas.getContext('2d');
        if (!ctx) return;
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.globalAlpha = 1;
        ctx.globalCompositeOperation = 'source-over';
        ctx.imageSmoothingEnabled = true;
    }

    /** CPU path: scale the stage-2 base image into the viewport. */
    private _drawBaseImage(p: any) {
        if (!this._baseCanvas || !this._audioBuffer) return;

        let freqViewSrcCrop = null;
        if (p.freqViewMin != null && p.freqViewMax != null) {
            const baseH = this._baseCanvas.height;
            const srcYTop    = p.coords.frequencyToBaseYFraction(p.freqViewMax) * baseH;
            const srcYBottom = p.coords.frequencyToBaseYFraction(p.freqViewMin) * baseH;
            freqViewSrcCrop = { srcY: srcYTop, srcH: Math.max(1, srcYBottom - srcYTop) };
        }

        const totalWidth = Math.max(1, Math.floor(this._audioBuffer.duration * p.pixelsPerSecond));
        const vwCpu = p.viewportWidth > 0 ? Math.min(p.viewportWidth, totalWidth) : totalWidth;
        const slCpu = p.viewportWidth > 0 ? (p.scrollLeft ?? 0) : 0;
        this._lastView = { t0: slCpu / p.pixelsPerSecond, t1: (slCpu + vwCpu) / p.pixelsPerSecond, pps: p.pixelsPerSecond };

        renderSpectrogram({
            duration:          this._audioBuffer.duration,
            spectrogramCanvas: this._d.spectrogramCanvas,
            pixelsPerSecond:   p.pixelsPerSecond,
            canvasHeight:      p.effectiveHeight,
            baseCanvas:        this._baseCanvas,
            freqViewSrcCrop,
            canvasSizer:       this._d.canvasSizer,
            scrollLeft:        p.scrollLeft,
            viewportWidth:     p.viewportWidth,
            totalWidth,
        });
    }

    /** v2 data, no CLAHE, and the GPU accepted the data. */
    _gpuViewEligible(): boolean {
        const d = this._d;
        return !!this._data && this._engineV2 && !this._tileManager
            && this._gpuRefused !== this._data
            && !(d.claheCheck?.checked ?? false)
            && (this._gpuView ??= new GpuSpectrogramView()).ok;
    }

    _isPhase(): boolean {
        return (this._colourScale || this._d.colourScaleSelect?.value || 'dbSquared') === 'phase';
    }

    /**
     * Value window [black, white] for the GPU view, as the CPU path maps it:
     * the dB window, or the % sliders over noise floor … p99.9 (phase: −π … π).
     */
    private _gpuWindow(phase: boolean): [number, number] {
        const win = this._dbWindow();
        if (win) return win;
        const d = this._d;
        const [a, b] = phase ? [-Math.PI, Math.PI] : [this._absLogMin, this._absLogMax];
        const f = parseFloat(d.floorSlider?.value || '0') / 100;
        const c = parseFloat(d.ceilSlider?.value || '100') / 100;
        return [a + f * (b - a), a + c * (b - a)];
    }

    /** Renders the visible viewport straight from the data. False → use the CPU path. */
    private _drawGpuView(p: any): boolean {
        if (!this._gpuViewEligible() || !this._audioBuffer) return false;
        const view = this._gpuView!;
        const data = this._data as Float32Array;
        if (!view.holds(data)) {
            if (!view.setData(data, this._nFrames, this._nMels)) { this._gpuRefused = data; return false; }
            this._gpuFloorRef = null;
        }
        if (this._gpuFloorRef !== this._bandFloor) {
            view.setBandFloor(this._bandFloor ? limitBandFloor(this._bandFloor) : null);
            this._gpuFloorRef = this._bandFloor;
        }
        const scheme = p.colorScheme || this._d.colorSchemeSelect?.value || 'grayscale';
        view.setLut(scheme, (t) => getSpectrogramColor(t, scheme));

        const duration = this._audioBuffer.duration;
        const totalWidth = Math.max(1, Math.floor(duration * p.pixelsPerSecond));
        const height = Math.max(140, Math.floor(p.effectiveHeight));
        const vw = p.viewportWidth ?? 0;
        const width = vw > 0 ? Math.min(vw, totalWidth) : totalWidth;
        const sl = vw > 0 ? (p.scrollLeft ?? 0) : 0;
        this._lastView = { t0: sl / p.pixelsPerSecond, t1: (sl + width) / p.pixelsPerSecond, pps: p.pixelsPerSecond };
        const canvas = this._d.spectrogramCanvas;
        this._sizeViewCanvas(totalWidth, width, height);

        // Centred frames: frame i sits at i · hop / sr; the time axis spans totalWidth.
        const framesPerSec = this._audioBuffer.sampleRate / Math.max(1, this._hopSize);
        const framesPerPx = duration / totalWidth * framesPerSec;
        const coords = p.coords;
        const binTop = coords.yFractionToBinFractional(0);
        const binsPerPx = (binTop - coords.yFractionToBinFractional(1)) / height;
        const phase = this._isPhase();
        const [lo, hi] = this._gpuWindow(phase);
        const out = view.render({
            width, height, frame0: sl * framesPerPx, framesPerPx, binTop, binsPerPx, lo, hi,
            useFloor: (this._d.noiseReductionCheck?.checked ?? false) && !!this._bandFloor && !phase,
            pool: phase ? 'nearest' : 'max',
        });
        const ctx = canvas.getContext('2d');
        if (!out || !ctx) return false;
        ctx.clearRect(0, 0, width, height);
        ctx.drawImage(out, 0, 0);
        drawTimeGrid({ ctx, width, height, duration, pixelsPerSecond: p.pixelsPerSecond, scrollLeft: sl });
        return true;
    }

    /** Tile mode on the GPU (no CLAHE). Null → CPU tiles. */
    private _drawGpuTiles(tm: WasmTileManager, p: any,
                          width: number, height: number, scrollLeft: number): HTMLCanvasElement | null {
        if (!(tm instanceof WasmTileManager) || !tm.gpuEligible) return null;
        const view = (this._gpuView ??= new GpuSpectrogramView());
        if (!view.ok) return null;
        // The tiles replace the band floor and data on the view; the full-data path re-uploads.
        this._gpuFloorRef = null;
        const scheme = p.colorScheme || this._d.colorSchemeSelect?.value || 'grayscale';
        view.setLut(scheme, (t) => getSpectrogramColor(t, scheme));
        const binTop = p.coords.yFractionToBinFractional(0);
        return tm.renderGpu(view, {
            width, height, pixelsPerSecond: p.pixelsPerSecond, scrollLeft,
            binTop, binsPerPx: (binTop - p.coords.yFractionToBinFractional(1)) / height,
        });
    }

    /** Spectral overlays and axis sync after the spectrogram itself is drawn. */
    private _drawOverlays(p: any) {
        // Spectral overlay (centroid + F0 + ridges) drawn on top of the rendered canvas.
        if (this._spectralFeatures || this._ridges) {
            const ctx = (this._d.spectrogramCanvas as HTMLCanvasElement).getContext('2d');
            if (ctx && this._audioBuffer) {
                const totalWidth = Math.max(1, Math.floor(this._audioBuffer.duration * p.pixelsPerSecond));
                const canvasHeight = Math.max(140, Math.floor(p.effectiveHeight));
                const vw = p.viewportWidth ?? 0;
                const sl = vw > 0 ? (p.scrollLeft ?? 0) : 0;
                const width = vw > 0 ? Math.min(vw, totalWidth) : totalWidth;
                this._drawSpectralOverlay(ctx, p, totalWidth, sl, width, canvasHeight);
            }
        }

        this._syncFreqAxisHeight();
    }

    /**
     * Request a debounced redraw on the next animation frame.
     * Fires 'needsredraw' so the host can call draw() with current params.
     */
    requestRedraw() {
        if (this._zoomRedrawRafId) return;
        this._zoomRedrawRafId = requestAnimationFrame(() => {
            this._zoomRedrawRafId = 0;
            this._emit('needsredraw');
        });
    }

    // ── Auto-adjust ─────────────────────────────────────────────���────

    /**
     * Compute optimal floor/ceil percentiles and write them to the sliders.
     * Pass redraw=true when called from a button click to also re-render.
     * @param {boolean} [redraw=false]
     */
    autoContrast(redraw = false) {
        this._syncGainSliders();
        if (this._gainDbMode || this._isNoiseFloorContrast()) {
            const vis = this._visibleValues();
            const pts = vis && visibleContrastPoints(vis.values, AUTO_CONTRAST.blackMarginDb, AUTO_CONTRAST.whitePercentile);
            if (pts && vis) {
                if (this._gainDbMode) {
                    // Black a little above the visible noise floor, white above its p99.9.
                    const floor = this._clamp(Math.round(pts.black - vis.noise), DB_CONTRAST.floor.min, DB_CONTRAST.floor.max);
                    const range = this._clamp(Math.round(pts.white + AUTO_CONTRAST.headroomDb - (vis.noise + floor)), DB_CONTRAST.range.min, DB_CONTRAST.range.max);
                    if (this._d.floorSlider) this._d.floorSlider.value = String(floor);
                    if (this._d.ceilSlider)  this._d.ceilSlider.value  = String(range);
                } else {
                    // PCEN: same points as % of the level's contrast range.
                    const [a, b] = vis.range;
                    if (b - a > 1e-8) {
                        const lo = this._clamp(Math.round(((pts.black - a) / (b - a)) * 100), 0, 99);
                        const hi = this._clamp(Math.round(((pts.white - a) / (b - a)) * 100), lo + 1, 100);
                        if (this._d.floorSlider) this._d.floorSlider.value = String(lo);
                        if (this._d.ceilSlider)  this._d.ceilSlider.value  = String(hi);
                    }
                }
            } else if (this._gainDbMode) {
                // Nothing drawn yet: fall back to the defaults.
                if (this._d.floorSlider) this._d.floorSlider.value = String(DB_CONTRAST.floor.def);
                if (this._d.ceilSlider)  this._d.ceilSlider.value  = String(DB_CONTRAST.range.def);
            } else {
                if (this._d.floorSlider) this._d.floorSlider.value = '0';
                if (this._d.ceilSlider)  this._d.ceilSlider.value  = '100';
            }
            this.updateGainReadout();
            if (redraw) this._emit('needsredraw');
            return;
        }
        const data = this._tileManager ? this._tileManager.firstReadyTileData() : this._data;
        if (!data) return;
        const absMin = this._tileManager ? this._tileManager.globalMin : this._absLogMin;
        const absMax = this._tileManager ? this._tileManager.globalMax : this._absLogMax;
        const stats = autoContrastStats(data, 2, 98);
        const range = absMax - absMin;
        if (range < 1e-8) return;

        const floorPct = this._clamp(((stats.logMin - absMin) / range) * 100, 0, 100);
        const ceilPct  = this._clamp(((stats.logMax - absMin) / range) * 100, 0, 100);

        if (this._d.floorSlider) this._d.floorSlider.value = Math.round(floorPct);
        if (this._d.ceilSlider)  this._d.ceilSlider.value  = Math.round(ceilPct);

        if (redraw) this._emit('needsredraw');
    }

    /**
     * v2 values in the last drawn time span (band floor removed with noise
     * reduction in dB mode), with the noise reference of the dB window and
     * the % contrast range. Whole file before the first draw.
     */
    _visibleValues(): { values: Float32Array; noise: number; range: [number, number] } | null {
        const duration = this._audioBuffer?.duration ?? 0;
        const view = this._lastView ?? { t0: 0, t1: duration, pps: 1 };
        const tm = this._tileManager;
        if (tm) return tm.visibleValues(view.t0, view.t1, view.pps);
        if (!this._data || this._nFrames <= 0 || this._nMels <= 0 || duration <= 0) return null;
        const f0 = this._clamp(Math.floor((view.t0 / duration) * this._nFrames), 0, this._nFrames);
        const f1 = this._clamp(Math.ceil((view.t1 / duration) * this._nFrames), f0, this._nFrames);
        const freqs = this.binFreqs;
        const maxFreq = parseFloat(this._d.maxFreqSelect?.value || '0');
        let bins = this._nMels;
        if (freqs && maxFreq > 0) {
            bins = 0;
            while (bins < freqs.length && freqs[bins] <= maxFreq) bins++;
            if (bins === 0) bins = this._nMels;
        }
        const nr = !!this._gainDbMode && !!this._d.noiseReductionCheck?.checked;
        const values = sampleFrameValues(this._data, this._nMels, f0, f1, bins, nr ? this._bandFloor : null);
        return { values, noise: nr ? 0 : this._absLogMin, range: [this._absLogMin, this._absLogMax] };
    }

    /**
     * Detect best max-frequency from signal content and update the select.
     * @param {boolean} [redraw=false]
     */
    autoFrequency(redraw = false) {
        const data = this._tileManager ? this._tileManager.firstReadyTileData() : this._data;
        const nMels = this._tileManager ? this._tileManager.nMels : this._nMels;
        const nFrames = this._tileManager
            ? Math.floor((data?.length ?? 0) / nMels)
            : this._nFrames;
        if (!data) return;
        const hzValue = detectMaxFrequency(
            data,
            nFrames,
            nMels,
            this._sampleRateHz,
            this._d.scaleSelect?.value || 'mel',
            undefined,
            this.binFreqs,
        );
        const opts = Array.from((this._d.maxFreqSelect?.options || []) as any) as HTMLOptionElement[];
        let best = opts[opts.length - 1] as HTMLOptionElement | undefined;
        for (const opt of opts) {
            if (parseFloat(opt.value) >= hzValue) { best = opt; break; }
        }
        if (this._d.maxFreqSelect && best) this._d.maxFreqSelect.value = best.value;
        this._emit('scalechange', { maxFreq: parseFloat(best?.value || '10000') });
        if (redraw) this._emit('needsredraw');
    }

    /** Set maxFreq select to the Nyquist frequency. */
    setMaxFreqToNyquist() {
        const nyquist = this._sampleRateHz / 2;
        const opts = Array.from((this._d.maxFreqSelect?.options || []) as any) as HTMLOptionElement[];
        const last = opts[opts.length - 1] as HTMLOptionElement | undefined;
        if (last && this._d.maxFreqSelect) this._d.maxFreqSelect.value = last.value;
        this._emit('scalechange', { maxFreq: nyquist });
    }

    /**
     * Rebuild the max-frequency <select> options for the current sample rate.
     * @param {number} sampleRateHz
     */
    updateMaxFreqOptions(sampleRateHz: number) {
        const nyquist = sampleRateHz / 2;
        const select = this._d.maxFreqSelect;
        if (!select) return;

        const candidates = [
            1000, 2000, 4000, 6000, 8000, 10000, 12000,
            16000, 20000, 24000, 32000, 44100, 48000,
        ];
        const prev = parseFloat(select.value) || 10000;
        const kept = candidates.filter(f => f <= nyquist);
        if (!kept.length || kept[kept.length - 1] < nyquist) kept.push(nyquist);

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

        if (kept.includes(prev)) {
            select.value = String(prev);
        } else {
            let best = kept[kept.length - 1];
            for (const v of kept) { if (v >= prev) { best = v; break; } }
            select.value = String(best);
        }
    }

    /**
     * Enable or disable DSP/display controls that have no effect on
     * pre-rendered spectrogram images.
     * @param {boolean} enabled
     */
    setDspControlsEnabled(enabled: boolean) {
        const d = this._d;
        const settingsEls = [
            d.scaleSelect, d.windowSizeSelect, d.windowFunctionSelect, d.overlapSelect,
            d.oversamplingSelect, d.nMelsInput, d.floorSlider, d.ceilSlider,
            d.colorSchemeSelect, d.maxFreqSelect,
        ];
        for (const el of settingsEls) {
            if (!el) continue;
            el.disabled = !enabled;
            const row = el.closest?.('.settings-row');
            if (row) row.style.opacity = enabled ? '' : '0.35';
        }
        for (const btn of [d.autoContrastBtn, d.autoFreqBtn]) {
            if (btn) btn.disabled = !enabled;
        }
        const pcen = d.pcenSection || d.container?.querySelector('[data-aw="pcenSection"]');
        if (pcen) pcen.style.display = enabled ? '' : 'none';
        if (d.presetSelect) d.presetSelect.disabled = !enabled;
    }

    // ── Lifecycle ───────────────────────────────────────────────��────

    destroy() {
        if (this._zoomRedrawRafId) { cancelAnimationFrame(this._zoomRedrawRafId); this._zoomRedrawRafId = 0; }
        if (typeof this._freqAxisRafId === 'number') { cancelAnimationFrame(this._freqAxisRafId); this._freqAxisRafId = undefined; }
        this._sfProcessor.dispose();
        this.colorizer.dispose();
        this._wasmSvc?.then((svc) => svc.dispose(), () => {});
        this._wasmSvc = null;
    }

    // ── Private helpers ──────────────────────────────────────────────

    /** v2 dB window [black, white] for the in-memory spectrogram, null in % mode. */
    _dbWindow(): [number, number] | null {
        if (!this._gainDbMode) return null;
        const d = this._d;
        // Spectral subtraction leaves the noise floor at 0 dB.
        const noise = d.noiseReductionCheck?.checked ? 0 : this._absLogMin;
        const lo = noise + parseFloat(d.floorSlider?.value || String(DB_CONTRAST.floor.def));
        return [lo, lo + parseFloat(d.ceilSlider?.value || String(DB_CONTRAST.range.def))];
    }

    /**
     * Switch the floor/ceil sliders between dB (v2: floor above the noise floor +
     * dynamic range) and % (legacy engines) when the active engine changes.
     * Values carry over only in fixed gain mode and only when they fit the new range.
     */
    _syncGainSliders(): void {
        const db = this._isDbContrast();
        if (db === this._gainDbMode) return;
        this._gainDbMode = db;
        const d = this._d;
        const fixed = d.gainModeSelect?.value === 'fixed';
        const setup = (el: HTMLInputElement | null, label: HTMLElement | null, text: string, title: string,
                       min: number, max: number, def: number) => {
            if (label) label.textContent = text;
            if (!el) return;
            const v = parseFloat(el.value);
            el.min = String(min); el.max = String(max); el.step = '1'; el.title = title;
            el.value = String(fixed && v >= min && v <= max ? v : def);
        };
        if (db) {
            setup(d.floorSlider, d.floorLabel, 'Floor', 'Black level in dB above the noise floor',
                DB_CONTRAST.floor.min, DB_CONTRAST.floor.max, DB_CONTRAST.floor.def);
            setup(d.ceilSlider, d.ceilLabel, 'Range', 'Dynamic range in dB from black to white',
                DB_CONTRAST.range.min, DB_CONTRAST.range.max, DB_CONTRAST.range.def);
        } else {
            setup(d.floorSlider, d.floorLabel, 'Floor', 'Spectrogram floor', 0, 100, 0);
            setup(d.ceilSlider, d.ceilLabel, 'Ceiling', 'Spectrogram ceiling', 0, 100, 100);
        }
        this.updateGainReadout();
    }

    /** Show slider values in dB; the % sliders have no readout. */
    updateGainReadout(): void {
        const d = this._d;
        const db = !!this._gainDbMode;
        const f = parseFloat(d.floorSlider?.value || '0');
        if (d.floorValue) d.floorValue.textContent = db ? `${f > 0 ? '+' : ''}${f} dB` : '';
        if (d.ceilValue)  d.ceilValue.textContent  = db ? `${d.ceilSlider?.value} dB` : '';
    }

    /** v2 values in dB (not PCEN): contrast is a dB window above the noise floor. */
    _isDbContrast(): boolean {
        const tm = this._tileManager;
        const p = this._v2Params;
        return tm ? tm.dbValues : this._engineV2 && !p?.pcen && (p?.output ?? 'db') === 'db';
    }

    _isNoiseFloorContrast(): boolean {
        const tm = this._tileManager;
        return tm ? tm instanceof WasmTileManager && tm.noiseFloorContrast : this._engineV2;
    }

    /** Whole file with the v2 engine in the WASM worker pool. */
    private async _computeV2(channelData: Float32Array, params: StftParamsV2, colourScale: string) {
        this._wasmSvc ??= import('../infrastructure/wasm-dsp/WasmSpectrogramService.ts')
            .then(({ WasmSpectrogramService }) => WasmSpectrogramService.create());
        const svc = await this._wasmSvc.catch((err) => { this._wasmSvc = null; throw err; });
        const r = await svc.compute(channelData, this._audioBuffer!.sampleRate, params);
        return { data: r.data, nFrames: r.nFrames, nMels: r.bins, hopSize: r.hop, winLength: r.winLen, colourScale, bandFloor: r.bandFloor };
    }

    _updateStats() {
        if (!this._data) return;
        const stats = this._engineV2
            ? noiseFloorStats(this._data as Float32Array)
            : computeSpectrogramStats(this._data as Float32Array);
        this._absLogMin = stats.logMin;
        this._absLogMax = stats.logMax;
    }

    /** Keep the freq-axis height element in sync with the rendered canvas height. */
    _syncFreqAxisHeight() {
        const h = this._d.spectrogramCanvas?.height;
        if (!h || !this._d.freqAxisSpacer) return;
        if (this._lastFreqAxisH === h) return;
        this._lastFreqAxisH = h;
        if (typeof this._freqAxisRafId === 'number') cancelAnimationFrame(this._freqAxisRafId);
        this._freqAxisRafId = requestAnimationFrame(() => {
            this._freqAxisRafId = undefined;
            const ch = this._d.spectrogramCanvas?.height;
            if (ch > 0) {
                this._d.freqAxisSpacer.style.height = `${ch}px`;
                if (this._d.crosshairCanvas) this._d.crosshairCanvas.style.marginTop = `-${ch}px`;
            }
        });
    }

    _clamp(v: number, lo: number, hi: number) { return v < lo ? lo : v > hi ? hi : v; }

    /**
     * @param {string} name
     * @param {any} detail
     */
    _emit(name: string, detail: any = {}) {
        this.dispatchEvent(new CustomEvent(name, { detail }));
    }
}
