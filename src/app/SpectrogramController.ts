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
    PROGRESSIVE_CHUNK_SECONDS, PROGRESSIVE_MIN_DURATION_SEC,
    PERCH_FRAME_RATE,
    CQT_FMIN, CQT_BINS_PER_OCTAVE,
    windowHopFromOverlap,
    fftSizeFromOversampling,
} from '../shared/constants.ts';

import {
    updateSpectrogramStats as computeSpectrogramStats,
    autoContrastStats,
    detectMaxFrequency,
    buildSpectrogramGrayscale,
    colorizeSpectrogram,
    GpuColorizer,
    renderSpectrogram,
    createSpectrogramProcessor,
} from '../domain/spectrogram.ts';

import { computeReassignedSpectrogram } from '../domain/dsp.ts';
import { spectrogramCache } from '../infrastructure/SpectrogramCache.ts';

/**
 * SpectrogramController — owns spectrogram state and the compute/render pipeline.
 *
 * @param {Object} d  DOM element refs (same shape as PlayerState.d)
 * @param {Object} [opts]
 * @param {boolean} [opts.enableProgressive=false]
 */
export class SpectrogramController extends EventTarget {
    _d: any;
    _enableProgressive: boolean;
    enableProgressive: boolean;
    processor: any;
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
    _baseCanvas: HTMLCanvasElement | null;
    _grayInfo: { gray: Float32Array; width: number; height: number } | null;
    _gpuReady: boolean;
    _externalMode: boolean;
    _externalImageConfig: { freqRange: [number, number] | null; freqScale: string | null } | null;
    _audioBuffer: AudioBuffer | null;
    _sampleRateHz: number;
    _zoomRedrawRafId: number;
    _freqAxisRafId: number | undefined;
    _lastFreqAxisH: number;
    value: any;
    constructor(d: any, opts: any = {}) {
        super();
        this._d = d;
        this._enableProgressive = opts.enableProgressive === true;

        this.processor = createSpectrogramProcessor();
        this.colorizer = new GpuColorizer();

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
    get hasData()             { return this._data !== null && this._nFrames > 0; }

    // ── Host-side audio reference ────────────────────────────────────

    /**
     * Called by PlayerState whenever a new audio file is loaded.
     * @param {AudioBuffer} audioBuffer
     * @param {number} sampleRateHz
     */
    setAudio(audioBuffer: AudioBuffer, sampleRateHz: number) {
        this._audioBuffer = audioBuffer;
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
        if (d.recomputingOverlay) d.recomputingOverlay.hidden = false;
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

        const effectiveNMels = scale === 'cqt'
            ? Math.ceil(Math.log2((this._audioBuffer.sampleRate / 2) / CQT_FMIN) * CQT_BINS_PER_OCTAVE)
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
            pcenSmoothing:  parseFloat(d.pcenSmoothingInput?.value || '0.025'),
            windowSize,
            hopSize,
        };

        this._activeScale = scale;
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
                this._updateStats();
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

            let result;

            if (useReassigned) {
                result = computeReassignedSpectrogram({ channelData, ...options });
            } else {
                const shouldUseProgressive = this._enableProgressive
                    && this._audioBuffer.duration >= PROGRESSIVE_MIN_DURATION_SEC
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
            }

            this._data      = result.data;
            this._nFrames   = result.nFrames;
            this._nMels     = result.nMels;
            this._hopSize   = result.hopSize || Math.max(1, Math.floor(this._sampleRateHz / PERCH_FRAME_RATE));
            this._winLength = result.winLength || 4 * this._hopSize;
            this._colourScale = result.colourScale || colourScale;

            // Persist to cache (non-blocking)
            spectrogramCache.set(cacheKey, {
                dataBuffer: new Uint8Array(((this._data as Float32Array)).buffer).slice().buffer,
                nFrames:    this._nFrames,
                nMels:      this._nMels,
                hopSize:    this._hopSize,
                winLength:  this._winLength,
                colourScale: this._colourScale,
            }).catch(() => {/* ignore storage errors */});

            this._updateStats();

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
            this._emit('error', { message: error?.message || String(error), source: 'spectrogram' });
            throw error;
        }
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
        if (!this._data) return;
        const d = this._d;
        this._grayInfo = buildSpectrogramGrayscale({
            spectrogramData:    this._data,
            spectrogramFrames:  this._nFrames,
            spectrogramMels:    this._nMels,
            sampleRateHz:       this._sampleRateHz,
            maxFreq:            parseFloat(d.maxFreqSelect?.value || '10000'),
            spectrogramAbsLogMin: this._absLogMin,
            spectrogramAbsLogMax: this._absLogMax,
            scale:       this._activeScale || d.scaleSelect?.value || 'mel',
            colourScale: this._colourScale || d.colourScaleSelect?.value || 'dbSquared',
            noiseReduction: d.noiseReductionCheck?.checked ?? false,
            clahe:          d.claheCheck?.checked ?? false,
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
        if (!this._grayInfo) this.buildGrayscale();
        const d = this._d;
        const floor01 = parseFloat(d.floorSlider?.value || '0')  / 100;
        const ceil01  = parseFloat(d.ceilSlider?.value  || '100') / 100;

        if (this._gpuReady && this._grayInfo) {
            this.colorizer.uploadColorLut(colorScheme);
            this.colorizer.render(floor01, ceil01);
            this._baseCanvas = this.colorizer.canvas;
        } else {
            this._baseCanvas = colorizeSpectrogram(this._grayInfo, floor01, ceil01, colorScheme);
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
        if (!this._audioBuffer || !this._data || this._nFrames <= 0) return;
        if (!this._baseCanvas) this.buildBaseImage(p.colorScheme);
        if (!this._baseCanvas) return;

        let freqViewSrcCrop = null;
        if (p.freqViewMin != null && p.freqViewMax != null) {
            const baseH = this._baseCanvas.height;
            const srcYTop    = p.coords.frequencyToBaseYFraction(p.freqViewMax) * baseH;
            const srcYBottom = p.coords.frequencyToBaseYFraction(p.freqViewMin) * baseH;
            freqViewSrcCrop = { srcY: srcYTop, srcH: Math.max(1, srcYBottom - srcYTop) };
        }

        const totalWidth = Math.max(1, Math.floor(this._audioBuffer.duration * p.pixelsPerSecond));

        renderSpectrogram({
            duration:       this._audioBuffer.duration,
            spectrogramCanvas: this._d.spectrogramCanvas,
            pixelsPerSecond: p.pixelsPerSecond,
            canvasHeight:   p.effectiveHeight,
            baseCanvas:     this._baseCanvas,
            freqViewSrcCrop,
            canvasSizer:    this._d.canvasSizer,
            scrollLeft:     p.scrollLeft,
            viewportWidth:  p.viewportWidth,
            totalWidth,
        });

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
        if (!this._data) return;
        const stats = autoContrastStats(this._data, 2, 98);
        const range = this._absLogMax - this._absLogMin;
        if (range < 1e-8) return;

        const floorPct = this._clamp(((stats.logMin - this._absLogMin) / range) * 100, 0, 100);
        const ceilPct  = this._clamp(((stats.logMax - this._absLogMin) / range) * 100, 0, 100);

        if (this._d.floorSlider) this._d.floorSlider.value = Math.round(floorPct);
        if (this._d.ceilSlider)  this._d.ceilSlider.value  = Math.round(ceilPct);

        if (redraw) this._emit('needsredraw');
    }

    /**
     * Detect best max-frequency from signal content and update the select.
     * @param {boolean} [redraw=false]
     */
    autoFrequency(redraw = false) {
        if (!this._data) return;
        const hzValue = detectMaxFrequency(
            this._data,
            this._nFrames,
            this._nMels,
            this._sampleRateHz,
            this._d.scaleSelect?.value || 'mel',
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
        this.processor.dispose();
        this.colorizer.dispose();
    }

    // ── Private helpers ──────────────────────────────────────────────

    _updateStats() {
        if (!this._data) return;
        const stats = computeSpectrogramStats(this._data as Float32Array);
        this._absLogMin = stats.logMin;
        this._absLogMax = stats.logMax;
    }

    _mergeProgressiveResults(chunkResults: any[], nMels: number) {
        if (!chunkResults.length) return { data: new Float32Array(0), nFrames: 0, nMels, hopSize: 0, winLength: 0 };
        const actualNMels = chunkResults[0].nMels || nMels;
        let totalSize = 0;
        for (const chunk of chunkResults) totalSize += chunk.data.length;
        const totalFrames = Math.floor(totalSize / actualNMels);
        const data = new Float32Array(totalFrames * actualNMels);
        let offset = 0;
        for (const chunk of chunkResults) {
            const toCopy = Math.min(chunk.data.length, data.length - offset);
            if (toCopy > 0) data.set(chunk.data.subarray(0, toCopy), offset);
            offset += toCopy;
        }
        const first = chunkResults[0] || {};
        return { data, nFrames: totalFrames, nMels: actualNMels, hopSize: first.hopSize, winLength: first.winLength };
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
