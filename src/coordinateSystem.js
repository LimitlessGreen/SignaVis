// ═══════════════════════════════════════════════════════════════════════
// coordinateSystem.js — Single source of truth for all coordinate
// mappings between time, frequency, pixel, and bin domains.
// ═══════════════════════════════════════════════════════════════════════

import { PERCH_FRAME_RATE, DEFAULT_SAMPLE_RATE, CQT_FMIN, CQT_BINS_PER_OCTAVE } from './constants.js';
import { buildMelFrequencies, buildCQTFrequencies, hzToMel, melToHz } from './dsp.js';
import { clamp } from './utils.js';

/**
 * Compute the highest visible bin index for a given frequency ceiling.
 * Shared by CoordinateSystem and spectrogram rendering.
 *
 * @param {{ isLinear: boolean, nyquist: number, spectrogramMels: number, boundedMaxFreq: number, melFreqs: Float32Array | null }} p
 * @returns {number}
 */
export function computeMaxBin({ isLinear, nyquist, spectrogramMels, boundedMaxFreq, melFreqs }) {
    if (isLinear) {
        const binHz = nyquist / spectrogramMels;
        return clamp(Math.floor(boundedMaxFreq / binHz), 1, spectrogramMels - 1);
    }
    let maxBin = spectrogramMels - 1;
    const freqs = /** @type {Float32Array} */ (melFreqs);
    for (let i = 0; i < freqs.length; i++) {
        if (freqs[i] > boundedMaxFreq) { maxBin = Math.max(1, i - 1); break; }
    }
    return maxBin;
}

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
     * @param {string} [params.scale]               'mel' | 'linear' | 'cqt'
     * @param {number} [params.frameRate]          Spectrogram frame rate (default: PERCH_FRAME_RATE)
     * @param {number} [params.hopSize]            Actual hop size in samples (0 = auto from frameRate)
     * @param {number[] | null} [params.freqRange]  [fMin, fMax] in Hz — explicit frequency range (for external images)
     * @param {string | null} [params.freqScale]    Frequency axis mapping: 'mel' | 'linear' | 'log' (for external images)
     * @param {number | null} [params.freqViewMin]  Frequency viewport bottom (Hz) for vertical zoom (null = 0)
     * @param {number | null} [params.freqViewMax]  Frequency viewport top (Hz) for vertical zoom (null = boundedMaxFreq)
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
        freqViewMin = null,
        freqViewMax = null,
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

        // ── Frequency viewport (vertical zoom) ──
        const hasView = freqViewMin != null && freqViewMax != null
            && (freqViewMin > 0 || freqViewMax < this.boundedMaxFreq);
        this.freqViewMin = hasView ? Math.max(0, freqViewMin) : null;
        this.freqViewMax = hasView ? Math.min(this.boundedMaxFreq, freqViewMax) : null;
        this._hasFreqView = hasView;
        if (hasView) {
            this._viewMinBin = this._freqToBinFractional(this.freqViewMin);
            this._viewMaxBin = this._freqToBinFractional(this.freqViewMax);
            this._viewBinRange = this._viewMaxBin - this._viewMinBin;
        } else {
            this._viewMinBin = 0;
            this._viewMaxBin = this._maxBin;
            this._viewBinRange = this._maxBin;
        }
    }

    // ═════════════════════════════════════════════════════════════════
    //  Mel Frequency Cache
    // ═════════════════════════════════════════════════════════════════

    /** @returns {Float32Array} */
    get melFreqs() {
        if (!this._melFreqs) {
            this._melFreqs = this.scale === 'cqt'
                ? buildCQTFrequencies(this.spectrogramMels, CQT_FMIN, CQT_BINS_PER_OCTAVE)
                : buildMelFrequencies(this.sampleRate, this.spectrogramMels);
        }
        return this._melFreqs;
    }

    get maxBin() {
        return this._maxBin;
    }

    /** Compute maxBin for the current bounded max frequency. */
    _computeMaxBin() {
        return computeMaxBin({
            isLinear: this.isLinear,
            nyquist: this.nyquist,
            spectrogramMels: this.spectrogramMels,
            boundedMaxFreq: this.boundedMaxFreq,
            melFreqs: this.melFreqs,
        });
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
        return clamp(t, 0, this.duration);
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
     * Frequency → fractional bin index [0 .. maxBin].
     * Shared helper for both full-range and viewport-aware mappings.
     * @private
     */
    _freqToBinFractional(freq) {
        const cf = clamp(freq, 0, this.boundedMaxFreq);
        if (this.isLinear) {
            const binHz = this.nyquist / this.spectrogramMels;
            return clamp(cf / binHz, 0, this._maxBin);
        }
        const freqs = this.melFreqs;
        if (cf >= freqs[this._maxBin]) return this._maxBin;
        for (let i = 0; i < this._maxBin; i++) {
            if (freqs[i + 1] >= cf) {
                const range = freqs[i + 1] - freqs[i];
                return range > 0 ? i + (cf - freqs[i]) / range : i;
            }
        }
        return 0;
    }

    /**
     * Frequency (Hz) → display pixel Y (0 = top).
     * Correctly handles mel, linear, and log modes.
     * When freqRange is set (external image), uses direct mapping over that range.
     * When freqViewMin/freqViewMax are set (vertical zoom), maps within that viewport.
     */
    frequencyToPixelY(freq) {
        // External image with explicit frequency range
        if (this.freqRange) {
            return this._freqToPixelY_external(freq);
        }

        const bin = this._freqToBinFractional(freq);

        if (this._hasFreqView) {
            // Viewport mode: map bin within [viewMinBin, viewMaxBin] → [0, canvasHeight]
            const fraction = this._viewBinRange > 0
                ? (bin - this._viewMinBin) / this._viewBinRange
                : 0;
            // fraction: 0 = viewMin (bottom), 1 = viewMax (top)
            return (1 - fraction) * this.canvasHeight;
        }

        // Full range
        const clampedBin = clamp(bin, 0, this._maxBin);
        const h = this.spectrogramMels;
        const internalY = (h - 1) - (clampedBin / this._maxBin * (h - 1));
        return internalY / h * this.canvasHeight;
    }

    /**
     * Display pixel Y (0 = top) → frequency (Hz).
     */
    pixelYToFrequency(displayY) {
        // External image with explicit frequency range
        if (this.freqRange) {
            return this._pixelYToFreq_external(displayY);
        }

        if (this._hasFreqView) {
            const fraction = 1 - clamp(displayY / this.canvasHeight, 0, 1);
            const bin = this._viewMinBin + fraction * this._viewBinRange;
            const clampedBin = clamp(Math.round(bin), 0, this._maxBin);
            if (this.isLinear) {
                return clampedBin * (this.nyquist / this.spectrogramMels);
            }
            return this.melFreqs[clampedBin] || 0;
        }

        const h = this.spectrogramMels;
        const internalY = displayY / this.canvasHeight * h;
        const bin = Math.round(((h - 1) - internalY) / (h - 1) * this._maxBin);
        const clampedBin = clamp(bin, 0, this._maxBin);

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
        const cf = clamp(freq, fMin, fMax);
        const scale = this.freqScale || 'linear';
        let fraction; // 0 = fMin (bottom) … 1 = fMax (top)

        if (scale === 'log') {
            const safeMin = Math.max(1, fMin);
            fraction = Math.log(cf / safeMin) / Math.log(fMax / safeMin);
        } else if (scale === 'mel') {
            const melMin = hzToMel(fMin);
            const melMax = hzToMel(fMax);
            const melF   = hzToMel(cf);
            fraction = (melMax > melMin) ? (melF - melMin) / (melMax - melMin) : 0;
        } else { // 'linear'
            fraction = (fMax > fMin) ? (cf - fMin) / (fMax - fMin) : 0;
        }

        fraction = clamp(fraction, 0, 1);
        // fraction=0 → bottom → canvasHeight, fraction=1 → top → 0
        return (1 - fraction) * this.canvasHeight;
    }

    /** @private Map pixel Y → frequency for an external image with known freqRange + freqScale. */
    _pixelYToFreq_external(displayY) {
        const [fMin, fMax] = /** @type {number[]} */ (this.freqRange);
        // pixel 0 = top = fMax, pixel canvasHeight = bottom = fMin
        const fraction = 1 - clamp(displayY / this.canvasHeight, 0, 1);
        const scale = this.freqScale || 'linear';

        if (scale === 'log') {
            const safeMin = Math.max(1, fMin);
            return safeMin * Math.pow(fMax / safeMin, fraction);
        } else if (scale === 'mel') {
            const melMin = hzToMel(fMin);
            const melMax = hzToMel(fMax);
            const mel = melMin + fraction * (melMax - melMin);
            return melToHz(mel);
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

    /**
     * Frequency → Y fraction in the base spectrogram image (full range, viewport-independent).
     * 0 = top (highest freq), 1 = bottom (0 Hz).
     * Used for computing source crop when rendering with vertical zoom.
     */
    frequencyToBaseYFraction(freq) {
        if (this.freqRange) {
            // For external images, normalize the external mapping
            return this._freqToPixelY_external(freq) / Math.max(1, this.canvasHeight);
        }
        const bin = this._freqToBinFractional(freq);
        const h = this.spectrogramMels;
        return ((h - 1) - (bin / this._maxBin * (h - 1))) / h;
    }

    // ═════════════════════════════════════════════════════════════════
    //  FREQUENCY ↔ BIN
    // ═════════════════════════════════════════════════════════════════

    /** Frequency (Hz) → nearest bin index. */
    frequencyToBin(freq) {
        if (this.isLinear) {
            const binHz = this.nyquist / this.spectrogramMels;
            return clamp(Math.round(freq / binHz), 0, this.spectrogramMels - 1);
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
        const clamped = clamp(bin, 0, this.spectrogramMels - 1);
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
        return clamp(Math.round((timeSec - frameCenterSec) * this.frameRate), 0, nFrames - 1);
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
        if (this._hasFreqView) {
            const fraction = 1 - clamp(displayY / this.canvasHeight, 0, 1);
            const bin = this._viewMinBin + fraction * this._viewBinRange;
            return clamp(Math.round(bin), 0, this._maxBin);
        }
        const h = this.spectrogramMels;
        const internalY = displayY / this.canvasHeight * h;
        const bin = Math.round(((h - 1) - internalY) / (h - 1) * this._maxBin);
        return clamp(bin, 0, this._maxBin);
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
