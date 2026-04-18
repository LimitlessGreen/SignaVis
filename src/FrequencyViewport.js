// ═══════════════════════════════════════════════════════════════════════
// FrequencyViewport.js — Vertical frequency zoom/pan state
// ═══════════════════════════════════════════════════════════════════════
//
// Owns the [min, max] Hz viewport used by the spectrogram frequency axis.
// Fires a 'change' event after any state mutation so listeners (PlayerState)
// can react without polling.
//
// Events emitted:
//   'change'  — after any mutation to min/max

import { clamp } from './utils.js';

export class FrequencyViewport extends EventTarget {
    constructor() {
        super();
        this._min = null;
        this._max = null;
    }

    /** Lower bound of the visible frequency range (Hz), or null = full range. */
    get min() { return this._min; }

    /** Upper bound of the visible frequency range (Hz), or null = full range. */
    get max() { return this._max; }

    /** True when the viewport is zoomed in (min/max are non-null). */
    get isZoomed() { return this._min != null; }

    /**
     * Set an explicit [min, max] range (Hz).
     * Used by drag handlers that compute the new range inline.
     */
    set(min, max) {
        this._min = min;
        this._max = max;
        this._fire();
    }

    /**
     * Reset to full range, firing 'change'.
     * No-op (and no event) if already unzoomed.
     */
    reset() {
        if (!this.isZoomed) return;
        this._min = null;
        this._max = null;
        this._fire();
    }

    /**
     * Reset to full range without emitting 'change'.
     * For callers that own the subsequent redraw sequence themselves.
     */
    resetSilent() {
        this._min = null;
        this._max = null;
    }

    /**
     * Zoom by `factor` around an anchor frequency.
     * factor > 1 = zoom in, factor < 1 = zoom out.
     *
     * @param {number} factor
     * @param {number} anchorFreq  Hz — anchor point for the zoom
     * @param {number} boundedMax  Hz — maximum frequency in the current dataset
     */
    zoom(factor, anchorFreq, boundedMax) {
        const currentMin = this._min ?? 0;
        const currentMax = this._max ?? boundedMax;
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
            this._min = null;
            this._max = null;
        } else {
            this._min = newMin;
            this._max = newMax;
        }
        this._fire();
    }

    /**
     * Pan the viewport by deltaHz (positive = shift up in frequency).
     *
     * @param {number} deltaHz
     * @param {number} boundedMax  Hz — maximum frequency in the current dataset
     */
    pan(deltaHz, boundedMax) {
        const currentMin = this._min ?? 0;
        const currentMax = this._max ?? boundedMax;
        if (currentMin <= 0 && currentMax >= boundedMax) return; // not zoomed

        let newMin = currentMin + deltaHz;
        let newMax = currentMax + deltaHz;
        const range = currentMax - currentMin;

        // Clamp so viewport stays within [0, boundedMax]
        if (newMin < 0) { newMin = 0; newMax = range; }
        if (newMax > boundedMax) { newMax = boundedMax; newMin = boundedMax - range; }

        this._min = Math.max(0, newMin);
        this._max = Math.min(boundedMax, newMax);
        this._fire();
    }

    /**
     * Set zoom level from a slider value (0 = full range, 100 = max zoom).
     * Keeps the viewport centred on the current midpoint.
     *
     * @param {number} sliderValue  0–100
     * @param {number} boundedMax   Hz — maximum frequency in the current dataset
     */
    setFromSlider(sliderValue, boundedMax) {
        if (sliderValue <= 0) { this.reset(); return; }

        // Exponential mapping: 0→full, 100→5% of full range
        const fraction = Math.max(0.05, 1 - sliderValue / 100 * 0.95);
        const range = boundedMax * fraction;

        // Keep centred on current midpoint or centre of full range
        const currentMid = (this._min != null && this._max != null)
            ? (this._min + this._max) / 2
            : boundedMax / 2;
        let newMin = currentMid - range / 2;
        let newMax = currentMid + range / 2;
        if (newMin < 0) { newMin = 0; newMax = range; }
        if (newMax > boundedMax) { newMax = boundedMax; newMin = boundedMax - range; }

        this._min = newMin;
        this._max = newMax;
        this._fire();
    }

    _fire() { this.dispatchEvent(new CustomEvent('change')); }
}
