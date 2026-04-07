// ═══════════════════════════════════════════════════════════════════════
// coordinateSystem.js — Single source of truth for all coordinate
// mappings between time, frequency, pixel, and bin domains.
// ═══════════════════════════════════════════════════════════════════════

import { SPECTROGRAM_HEIGHT, PERCH_FRAME_RATE, DEFAULT_SAMPLE_RATE } from './constants.js';
import { buildMelFrequencies } from './dsp.js';

/**
 * Centralises every coordinate‐space conversion so that all consumers
 * (spectrogram rendering, crosshair, annotations, frequency labels,
 * overview, playhead, etc.) share one coherent set of parameters.
 *
 * Instances are lightweight and designed to be recreated whenever any
 * underlying parameter changes (zoom, mode switch, maxFreq, resize).
 */
export class CoordinateSystem {
    /**
     * @param {object} [params]
     * @param {number} [params.duration]           Audio duration in seconds
     * @param {number} [params.sampleRate]         Audio sample rate in Hz
     * @param {number} [params.pixelsPerSecond]    Current zoom level
     * @param {number} [params.canvasWidth]        Spectrogram canvas width in px
     * @param {number} [params.canvasHeight]       Spectrogram canvas height in px (display size)
     * @param {number} [params.maxFreq]            User-selected max frequency in Hz
     * @param {number} [params.spectrogramMels]    Number of mel bins (nMels)
     * @param {string} [params.scale]               'mel' | 'linear'
     * @param {number} [params.frameRate]          Spectrogram frame rate (default: PERCH_FRAME_RATE)
     * @param {number} [params.hopSize]            Actual hop size in samples (0 = auto from frameRate)
     * @param {number[] | null} [params.freqRange]  [fMin, fMax] in Hz — explicit frequency range (for external images)
     * @param {string | null} [params.freqScale]    Frequency axis mapping: 'mel' | 'linear' | 'log' (for external images)
     */
    constructor({
        duration = 0,
        sampleRate = DEFAULT_SAMPLE_RATE,
        pixelsPerSecond = 100,
        canvasWidth = 0,
        canvasHeight = 0,
        maxFreq = 10000,
        spectrogramMels = 128,
        scale = 'mel',
        frameRate = PERCH_FRAME_RATE,
        hopSize = 0,
        freqRange = null,
        freqScale = null,
    } = {}) {
        this.duration = Math.max(0, duration);
        this.sampleRate = Math.max(1, sampleRate);
        this.pixelsPerSecond = Math.max(0.01, pixelsPerSecond);
        this.canvasWidth = Math.max(0, canvasWidth);
        this.canvasHeight = Math.max(1, canvasHeight);
        this.maxFreq = Math.max(1, maxFreq);
        this.spectrogramMels = Math.max(1, spectrogramMels);
        this.scale = scale;
        this.frameRate = Math.max(1, frameRate);

        // External image frequency range override
        /** @type {number[] | null} */
        this.freqRange = freqRange; // [fMin, fMax] in Hz
        /** @type {string | null} */
        this.freqScale = freqScale; // 'linear' | 'mel' | 'log'

        // Derived constants (computed once)
        this.nyquist = this.sampleRate / 2;
        this.boundedMaxFreq = this.freqRange
            ? Math.max(1, this.freqRange[1])
            : Math.min(this.maxFreq, this.nyquist);
        this.isLinear = this.freqScale
            ? this.freqScale === 'linear'
            : this.scale === 'linear';
        this.hopSize = (hopSize && hopSize > 0) ? hopSize : Math.max(1, Math.floor(this.sampleRate / this.frameRate));

        // Mel / linear bin setup
        /** @type {Float32Array | null} */
        this._melFreqs = null;
        this._maxBin = this._computeMaxBin();
    }

    // ═════════════════════════════════════════════════════════════════
    //  Mel Frequency Cache
    // ═════════════════════════════════════════════════════════════════

    /** @returns {Float32Array} */
    get melFreqs() {
        if (!this._melFreqs) {
            this._melFreqs = buildMelFrequencies(this.sampleRate, this.spectrogramMels);
        }
        return this._melFreqs;
    }

    get maxBin() {
        return this._maxBin;
    }

    /** Compute maxBin for the current bounded max frequency. */
    _computeMaxBin() {
        if (this.isLinear) {
            const binHz = this.nyquist / this.spectrogramMels;
            return Math.max(1, Math.min(this.spectrogramMels - 1, Math.floor(this.boundedMaxFreq / binHz)));
        }
        const freqs = this.melFreqs;
        let maxBin = this.spectrogramMels - 1;
        for (let i = 0; i < freqs.length; i++) {
            if (freqs[i] > this.boundedMaxFreq) { maxBin = Math.max(1, i - 1); break; }
        }
        return maxBin;
    }

    // ═════════════════════════════════════════════════════════════════
    //  TIME ↔ PIXEL X
    // ═════════════════════════════════════════════════════════════════

    /** Seconds → canvas pixel X. */
    timeToPixelX(timeSec) {
        if (this.duration <= 0 || this.canvasWidth <= 0) return 0;
        return (timeSec / this.duration) * this.canvasWidth;
    }

    /** Canvas pixel X → seconds. */
    pixelXToTime(pixelX) {
        if (this.canvasWidth <= 0 || this.duration <= 0) return 0;
        const t = (pixelX / this.canvasWidth) * this.duration;
        return Math.max(0, Math.min(this.duration, t));
    }

    /** Seconds → scroll‐aware pixel X (accounts for pixelsPerSecond). */
    timeToScrollX(timeSec) {
        return timeSec * this.pixelsPerSecond;
    }

    /** Scroll pixel → seconds. */
    scrollXToTime(scrollX) {
        return scrollX / this.pixelsPerSecond;
    }

    // ═════════════════════════════════════════════════════════════════
    //  FREQUENCY ↔ PIXEL Y
    // ═════════════════════════════════════════════════════════════════

    /**
     * Frequency (Hz) → display pixel Y (0 = top).
     * Correctly handles mel, linear, and log modes.
     * When freqRange is set (external image), uses direct mapping over that range.
     */
    frequencyToPixelY(freq) {
        // External image with explicit frequency range
        if (this.freqRange) {
            return this._freqToPixelY_external(freq);
        }

        const cf = Math.max(0, Math.min(this.boundedMaxFreq, freq));
        let bin;

        if (this.isLinear) {
            const binHz = this.nyquist / this.spectrogramMels;
            bin = cf / binHz;
        } else {
            const freqs = this.melFreqs;
            bin = 0;
            if (cf >= freqs[this._maxBin]) {
                bin = this._maxBin;
            } else {
                for (let i = 0; i < this._maxBin; i++) {
                    if (freqs[i + 1] >= cf) {
                        const range = freqs[i + 1] - freqs[i];
                        bin = range > 0 ? i + (cf - freqs[i]) / range : i;
                        break;
                    }
                }
            }
        }

        bin = Math.max(0, Math.min(this._maxBin, bin));
        const internalY = (SPECTROGRAM_HEIGHT - 1) - (bin / this._maxBin * (SPECTROGRAM_HEIGHT - 1));
        return internalY / SPECTROGRAM_HEIGHT * this.canvasHeight;
    }

    /**
     * Display pixel Y (0 = top) → frequency (Hz).
     */
    pixelYToFrequency(displayY) {
        // External image with explicit frequency range
        if (this.freqRange) {
            return this._pixelYToFreq_external(displayY);
        }

        const internalY = displayY / this.canvasHeight * SPECTROGRAM_HEIGHT;
        const bin = Math.round(((SPECTROGRAM_HEIGHT - 1) - internalY) / (SPECTROGRAM_HEIGHT - 1) * this._maxBin);
        const clampedBin = Math.max(0, Math.min(this._maxBin, bin));

        if (this.isLinear) {
            const binHz = this.nyquist / this.spectrogramMels;
            return clampedBin * binHz;
        }
        return this.melFreqs[clampedBin] || 0;
    }

    // ── External image frequency mapping helpers ─────────────────────

    /** @private Map frequency → pixel Y for an external image with known freqRange + freqScale. */
    _freqToPixelY_external(freq) {
        const [fMin, fMax] = /** @type {number[]} */ (this.freqRange);
        const cf = Math.max(fMin, Math.min(fMax, freq));
        const scale = this.freqScale || 'linear';
        let fraction; // 0 = fMin (bottom) … 1 = fMax (top)

        if (scale === 'log') {
            const safeMin = Math.max(1, fMin);
            fraction = Math.log(cf / safeMin) / Math.log(fMax / safeMin);
        } else if (scale === 'mel') {
            const melMin = 2595 * Math.log10(1 + fMin / 700);
            const melMax = 2595 * Math.log10(1 + fMax / 700);
            const melF   = 2595 * Math.log10(1 + cf / 700);
            fraction = (melMax > melMin) ? (melF - melMin) / (melMax - melMin) : 0;
        } else { // 'linear'
            fraction = (fMax > fMin) ? (cf - fMin) / (fMax - fMin) : 0;
        }

        fraction = Math.max(0, Math.min(1, fraction));
        // fraction=0 → bottom → canvasHeight, fraction=1 → top → 0
        return (1 - fraction) * this.canvasHeight;
    }

    /** @private Map pixel Y → frequency for an external image with known freqRange + freqScale. */
    _pixelYToFreq_external(displayY) {
        const [fMin, fMax] = /** @type {number[]} */ (this.freqRange);
        // pixel 0 = top = fMax, pixel canvasHeight = bottom = fMin
        const fraction = 1 - Math.max(0, Math.min(1, displayY / this.canvasHeight));
        const scale = this.freqScale || 'linear';

        if (scale === 'log') {
            const safeMin = Math.max(1, fMin);
            return safeMin * Math.pow(fMax / safeMin, fraction);
        } else if (scale === 'mel') {
            const melMin = 2595 * Math.log10(1 + fMin / 700);
            const melMax = 2595 * Math.log10(1 + fMax / 700);
            const mel = melMin + fraction * (melMax - melMin);
            return 700 * (Math.pow(10, mel / 2595) - 1);
        } else { // 'linear'
            return fMin + fraction * (fMax - fMin);
        }
    }

    /**
     * Frequency → normalized Y fraction (0 = top, 1 = bottom).
     * Useful for CSS positioning (e.g. frequency axis labels).
     */
    frequencyToYFraction(freq) {
        if (this.canvasHeight <= 0) return 0;
        return this.frequencyToPixelY(freq) / this.canvasHeight;
    }

    // ═════════════════════════════════════════════════════════════════
    //  FREQUENCY ↔ BIN
    // ═════════════════════════════════════════════════════════════════

    /** Frequency (Hz) → nearest bin index. */
    frequencyToBin(freq) {
        if (this.isLinear) {
            const binHz = this.nyquist / this.spectrogramMels;
            return Math.max(0, Math.min(this.spectrogramMels - 1, Math.round(freq / binHz)));
        }
        const freqs = this.melFreqs;
        let best = 0, bestDist = Math.abs(freqs[0] - freq);
        for (let i = 1; i < freqs.length; i++) {
            const d = Math.abs(freqs[i] - freq);
            if (d < bestDist) { bestDist = d; best = i; }
            if (freqs[i] > freq) break;
        }
        return best;
    }

    /** Bin index → frequency (Hz). */
    binToFrequency(bin) {
        const clamped = Math.max(0, Math.min(this.spectrogramMels - 1, bin));
        if (this.isLinear) {
            return clamped * (this.nyquist / this.spectrogramMels);
        }
        return this.melFreqs[clamped] || 0;
    }

    // ═════════════════════════════════════════════════════════════════
    //  TIME ↔ FRAME
    // ═════════════════════════════════════════════════════════════════

    /** Time (seconds) → spectrogram frame index. */
    timeToFrame(timeSec, nFrames) {
        const frameCenterSec = 2 * this.hopSize / this.sampleRate;
        return Math.max(0, Math.min(nFrames - 1,
            Math.round((timeSec - frameCenterSec) * this.frameRate)));
    }

    /** Frame index → time (seconds). */
    frameToTime(frame) {
        const frameCenterSec = 2 * this.hopSize / this.sampleRate;
        return frame / this.frameRate + frameCenterSec;
    }

    // ═════════════════════════════════════════════════════════════════
    //  PIXEL Y ↔ BIN (for amplitude lookup)
    // ═════════════════════════════════════════════════════════════════

    /** Display pixel Y → bin index (clamped to maxBin). */
    pixelYToBin(displayY) {
        const internalY = displayY / this.canvasHeight * SPECTROGRAM_HEIGHT;
        const bin = Math.round(((SPECTROGRAM_HEIGHT - 1) - internalY) / (SPECTROGRAM_HEIGHT - 1) * this._maxBin);
        return Math.max(0, Math.min(this._maxBin, bin));
    }

    // ═════════════════════════════════════════════════════════════════
    //  CLIENT EVENT → CANVAS (browser viewport helpers)
    // ═════════════════════════════════════════════════════════════════

    /**
     * Convert browser clientX/clientY relative to a wrapper rect
     * into canvas-local pixel coordinates.
     * @param {number} clientX
     * @param {number} clientY
     * @param {DOMRect} wrapperRect
     * @param {number} scrollLeft
     * @returns {{ canvasX: number, canvasY: number, localX: number, localY: number }}
     */
    clientToCanvas(clientX, clientY, wrapperRect, scrollLeft) {
        const localX = clientX - wrapperRect.left;
        const localY = clientY - wrapperRect.top;
        const canvasX = scrollLeft + localX;
        const canvasY = (localY / Math.max(1, wrapperRect.height)) * this.canvasHeight;
        return { canvasX, canvasY, localX, localY };
    }

    /**
     * Convert browser clientX/clientY to time and frequency.
     * @param {number} clientX
     * @param {number} clientY
     * @param {DOMRect} wrapperRect
     * @param {number} scrollLeft
     * @returns {{ time: number, freq: number, canvasX: number, canvasY: number, localX: number, localY: number }}
     */
    clientToTimeFreq(clientX, clientY, wrapperRect, scrollLeft) {
        const { canvasX, canvasY, localX, localY } = this.clientToCanvas(clientX, clientY, wrapperRect, scrollLeft);
        const time = this.pixelXToTime(canvasX);
        const freq = this.pixelYToFrequency(canvasY);
        return { time, freq, canvasX, canvasY, localX, localY };
    }
}
