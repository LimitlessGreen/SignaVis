// ═══════════════════════════════════════════════════════════════════════
// FrequencyZoomController.ts — Manages the vertical frequency zoom/pan
// viewport and its associated UI (scrollbar, slider, reset button).
//
// Owns:
//   • FrequencyViewport instance (the [min, max] Hz state)
//   • freqZoomResetBtn visibility
//   • freqScrollbar + freqScrollbarThumb positioning
//   • freqZoomSlider value sync
//
// All downstream effects (redraw, coords update) are delivered via the
// injected onFreqViewChange callback so this module stays free of direct
// PlayerState references.
// ═══════════════════════════════════════════════════════════════════════

import { clamp } from '../../shared/utils.ts';
import { FrequencyViewport } from '../FrequencyViewport.ts';

export interface FrequencyZoomDeps {
    d: {
        freqZoomResetBtn:   HTMLElement | null;
        freqScrollbar:      HTMLElement | null;
        freqScrollbarThumb: HTMLElement | null;
        freqZoomSlider:     HTMLInputElement | null;
    };
    /** Returns the current coords.boundedMaxFreq (may change after audio load). */
    getBoundedMaxFreq: () => number;
    /** Called after every freq-view mutation — triggers redraw + coords + labels + scheduleUiUpdate. */
    onFreqViewChange: () => void;
    /** Emit the 'zoomchange' event with current pixelsPerSecond. */
    emitZoomChange: (pixelsPerSecond: number) => void;
    /** Returns the current pixelsPerSecond (for emitting). */
    getPixelsPerSecond: () => number;
}

export class FrequencyZoomController {
    readonly #freqView = new FrequencyViewport();

    #d: FrequencyZoomDeps['d'];
    #getBoundedMaxFreq: () => number;
    #onFreqViewChange: () => void;
    #emitZoomChange: (pps: number) => void;
    #getPixelsPerSecond: () => number;

    // Bound reference so it can be removed in dispose()
    readonly #changeListener = () => this.#applyChange();

    constructor(deps: FrequencyZoomDeps) {
        this.#d = deps.d;
        this.#getBoundedMaxFreq = deps.getBoundedMaxFreq;
        this.#onFreqViewChange = deps.onFreqViewChange;
        this.#emitZoomChange = deps.emitZoomChange;
        this.#getPixelsPerSecond = deps.getPixelsPerSecond;
        this.#freqView.addEventListener('change', this.#changeListener);
        // Sync the reset button to the initial state (not zoomed)
        this.#syncResetBtn();
    }

    // ── Public state ─────────────────────────────────────────────────

    get min(): number | null { return this.#freqView.min; }
    get max(): number | null { return this.#freqView.max; }
    get isZoomed(): boolean  { return this.#freqView.isZoomed; }

    // ── Mutations (all fire 'change' → #applyChange internally) ──────

    zoom(factor: number, anchorFreq: number): void {
        this.#freqView.zoom(factor, anchorFreq, this.#getBoundedMaxFreq());
    }

    set(min: number, max: number): void {
        this.#freqView.set(min, max);
    }

    reset(): void {
        this.#freqView.reset();
    }

    /** Silent set used when restoring pan context (no downstream redraw). */
    resetSilent(): void {
        this.#freqView.resetSilent();
    }

    // ── Internal effect chain (triggered by FrequencyViewport 'change') ─

    #applyChange(): void {
        this.#onFreqViewChange();
        this.#syncResetBtn();
        this.#updateScrollbar();
        this.#syncSlider();
        this.#emitZoomChange(this.#getPixelsPerSecond());
    }

    #syncResetBtn(): void {
        const btn = this.#d.freqZoomResetBtn;
        if (btn) btn.hidden = !this.#freqView.isZoomed;
    }

    #updateScrollbar(): void {
        const bar   = this.#d.freqScrollbar;
        const thumb = this.#d.freqScrollbarThumb;
        if (!bar || !thumb) return;

        if (!this.#freqView.isZoomed) {
            bar.hidden = true;
            return;
        }
        bar.hidden = false;
        const boundedMax = this.#getBoundedMaxFreq();
        const viewRange  = (this.#freqView.max ?? boundedMax) - (this.#freqView.min ?? 0);
        const thumbFrac  = Math.min(1, viewRange / boundedMax);
        const topFrac    = 1 - (this.#freqView.max ?? boundedMax) / boundedMax;
        thumb.style.height = `${Math.max(8, thumbFrac * 100)}%`;
        thumb.style.top    = `${topFrac * 100}%`;
    }

    #syncSlider(): void {
        const slider = this.#d.freqZoomSlider;
        if (!slider) return;
        if (!this.#freqView.isZoomed) {
            slider.value = '0';
            return;
        }
        const boundedMax = this.#getBoundedMaxFreq();
        const fraction   = ((this.#freqView.max ?? boundedMax) - (this.#freqView.min ?? 0)) / boundedMax;
        const val        = (1 - fraction) / 0.95 * 100;
        slider.value     = String(clamp(Math.round(val), 0, 100));
    }

    // ── Lifecycle ────────────────────────────────────────────────────

    dispose(): void {
        this.#freqView.removeEventListener('change', this.#changeListener);
    }
}
