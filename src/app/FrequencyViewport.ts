// ═══════════════════════════════════════════════════════════════════════
// FrequencyViewport.ts — Vertical frequency zoom/pan state
//
// Owns the [min, max] Hz viewport used by the spectrogram frequency axis.
// Fires a 'change' event after any state mutation so listeners (PlayerState)
// can react without polling.
// ═══════════════════════════════════════════════════════════════════════

import { clamp } from '../shared/utils.ts'; // utils.js stays .js (not migrated yet)

export class FrequencyViewport extends EventTarget {
    private _min: number | null = null;
    private _max: number | null = null;

    get min(): number | null { return this._min; }
    get max(): number | null { return this._max; }
    get isZoomed(): boolean  { return this._min != null; }

    set(min: number, max: number): void {
        this._min = min;
        this._max = max;
        this._fire();
    }

    reset(): void {
        if (!this.isZoomed) return;
        this._min = null;
        this._max = null;
        this._fire();
    }

    resetSilent(): void {
        this._min = null;
        this._max = null;
    }

    zoom(factor: number, anchorFreq: number, boundedMax: number): void {
        const currentMin = this._min ?? 0;
        const currentMax = this._max ?? boundedMax;
        const anchor = clamp(anchorFreq, currentMin, currentMax);

        let newMin = anchor - (anchor - currentMin) / factor;
        let newMax = anchor + (currentMax - anchor) / factor;

        const minRange = Math.max(100, boundedMax * 0.05);
        if (newMax - newMin < minRange) {
            const mid = (newMin + newMax) / 2;
            newMin = mid - minRange / 2;
            newMax = mid + minRange / 2;
        }

        newMin = Math.max(0, newMin);
        newMax = Math.min(boundedMax, newMax);

        if (newMin <= 1 && newMax >= boundedMax - 1) {
            this._min = null;
            this._max = null;
        } else {
            this._min = newMin;
            this._max = newMax;
        }
        this._fire();
    }

    pan(deltaHz: number, boundedMax: number): void {
        const currentMin = this._min ?? 0;
        const currentMax = this._max ?? boundedMax;
        if (currentMin <= 0 && currentMax >= boundedMax) return;

        let newMin = currentMin + deltaHz;
        let newMax = currentMax + deltaHz;
        const range = currentMax - currentMin;

        if (newMin < 0)          { newMin = 0;          newMax = range;             }
        if (newMax > boundedMax) { newMax = boundedMax;  newMin = boundedMax - range; }

        this._min = Math.max(0, newMin);
        this._max = Math.min(boundedMax, newMax);
        this._fire();
    }

    setFromSlider(sliderValue: number, boundedMax: number): void {
        if (sliderValue <= 0) { this.reset(); return; }

        const fraction = Math.max(0.05, 1 - sliderValue / 100 * 0.95);
        const range    = boundedMax * fraction;
        const currentMid = (this._min != null && this._max != null)
            ? (this._min + this._max) / 2
            : boundedMax / 2;
        let newMin = currentMid - range / 2;
        let newMax = currentMid + range / 2;
        if (newMin < 0)          { newMin = 0;          newMax = range;             }
        if (newMax > boundedMax) { newMax = boundedMax;  newMin = boundedMax - range; }

        this._min = newMin;
        this._max = newMax;
        this._fire();
    }

    private _fire(): void { this.dispatchEvent(new CustomEvent('change')); }
}
