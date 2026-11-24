// ═══════════════════════════════════════════════════════════════════════
// WaveformRenderer.ts — Encapsulates all waveform & amplitude rendering.
//
// Owns:
//   • Main waveform canvas rendering
//   • Overview waveform rendering
//   • Amplitude labels (left-side y-axis)
//   • Frequency labels (left-side freq axis)
//
// All dependencies (audio state, layout dimensions, canvas DOM refs) are
// injected via constructor so the renderer can be tested without a full
// PlayerState.
// ═══════════════════════════════════════════════════════════════════════

import { clamp } from '../../shared/utils.ts';
import { selectedSamples } from '../../shared/channels.ts';
import {
    renderMainWaveform,
    renderOverviewWaveform,
    renderOverviewImage,
    renderFrequencyLabels,
} from '../../ui/components/waveform/waveform.ts';
import type { CoordinateSystem } from '../../domain/coordinateSystem.ts';
import { amplitudeMap, amplitudeTicks, DEFAULT_WAVEFORM_DISPLAY, type WaveformDisplay } from '../../domain/waveformScale.ts';

export interface WaveformRendererDeps {
    d: {
        amplitudeCanvas:        HTMLCanvasElement | null;
        waveformTimelineCanvas: HTMLCanvasElement | null;
        waveformContent:        HTMLElement | null;
        overviewCanvas:         HTMLCanvasElement | null;
        overviewContainer:      HTMLElement | null;
        overviewDetailCanvas?:  HTMLCanvasElement | null;
        overviewDetail?:        HTMLElement | null;
        freqLabels:             HTMLElement | null;
        amplitudeLabels:        HTMLElement | null;
    };
    getAudioBuffer:          () => AudioBuffer | null;
    getAmplitudePeakAbs:     () => number;
    getPixelsPerSecond:      () => number;
    getShowWaveform:         () => boolean;
    getShowOverview:         () => boolean;
    getShowWaveformTimeline: () => boolean;
    getEffectiveWaveformHeight:    () => number;
    getEffectiveSpectrogramHeight: () => number;
    getCoords:               () => CoordinateSystem;
    scheduleUiUpdate:        () => void;
    getScrollLeft?:          () => number;
    getViewportWidth?:       () => number;
    /** 'waveform' (default) or 'spectrogram' for the overview strip. */
    getOverviewMode?:        () => OverviewMode;
    /** Whole-file spectrogram image `cols` wide; null → the waveform is shown instead. */
    getOverviewImage?:       (cols: number) => Promise<CanvasImageSource | null>;
    /** Amplitude scale, reference, dB range and RMS body (default: linear, normalized, RMS). */
    getWaveformDisplay?:     () => WaveformDisplay;
}

export type OverviewMode = 'waveform' | 'spectrogram';

export class WaveformRenderer {
    #d: WaveformRendererDeps['d'];
    #getAudioBuffer: () => AudioBuffer | null;
    #getAmplitudePeakAbs: () => number;
    #getPixelsPerSecond: () => number;
    #getShowWaveform: () => boolean;
    #getShowOverview: () => boolean;
    #getShowWaveformTimeline: () => boolean;
    #getEffectiveWaveformHeight: () => number;
    #getEffectiveSpectrogramHeight: () => number;
    #getCoords: () => CoordinateSystem;
    #scheduleUiUpdate: () => void;
    #getScrollLeft: () => number;
    #getViewportWidth: () => number;
    #getOverviewMode: () => OverviewMode;
    #getOverviewImage: (cols: number) => Promise<CanvasImageSource | null>;
    #getWaveformDisplay: () => WaveformDisplay;
    #overviewToken = 0;
    /** True while the strip shows a spectrogram image (kept on redraws until a new one is ready). */
    #overviewHasImage = false;
    /** What the strip's waveform was drawn for; skips rescanning every sample when nothing changed. */
    #overviewWaveKey: { samples: Float32Array; w: number; h: number; peak: number; display: WaveformDisplay } | null = null;
    #overviewImage: CanvasImageSource | null = null;

    constructor(deps: WaveformRendererDeps) {
        this.#d = deps.d;
        this.#getAudioBuffer = deps.getAudioBuffer;
        this.#getAmplitudePeakAbs = deps.getAmplitudePeakAbs;
        this.#getPixelsPerSecond = deps.getPixelsPerSecond;
        this.#getShowWaveform = deps.getShowWaveform;
        this.#getShowOverview = deps.getShowOverview;
        this.#getShowWaveformTimeline = deps.getShowWaveformTimeline;
        this.#getEffectiveWaveformHeight = deps.getEffectiveWaveformHeight;
        this.#getEffectiveSpectrogramHeight = deps.getEffectiveSpectrogramHeight;
        this.#getCoords = deps.getCoords;
        this.#scheduleUiUpdate = deps.scheduleUiUpdate;
        this.#getScrollLeft = deps.getScrollLeft ?? (() => 0);
        this.#getViewportWidth = deps.getViewportWidth ?? (() => 0);
        this.#getOverviewMode = deps.getOverviewMode ?? (() => 'waveform');
        this.#getOverviewImage = deps.getOverviewImage ?? (async () => null);
        this.#getWaveformDisplay = deps.getWaveformDisplay ?? (() => DEFAULT_WAVEFORM_DISPLAY);
    }

    // ── Public rendering API ─────────────────────────────────────────

    drawMainWaveform(): void {
        if (!this.#getShowWaveform()) return;
        if (!this.#getAudioBuffer()) return;
        const effectiveWaveformHeight = this.#getEffectiveWaveformHeight();
        const { amplitudeCanvas, waveformTimelineCanvas, waveformContent } = this.#d;
        if (!amplitudeCanvas || !waveformTimelineCanvas || !waveformContent) return;
        renderMainWaveform({
            audioBuffer: this.#getAudioBuffer()!,
            amplitudeCanvas,
            waveformTimelineCanvas,
            waveformContent,
            pixelsPerSecond:   this.#getPixelsPerSecond(),
            waveformHeight:    effectiveWaveformHeight,
            amplitudePeakAbs:  this.#getAmplitudePeakAbs(),
            showTimeline:      this.#getShowWaveformTimeline(),
            scrollLeft:        this.#getScrollLeft(),
            viewportWidth:     this.#getViewportWidth(),
            display:           this.#getWaveformDisplay(),
        });
        this.#scheduleUiUpdate();
    }

    #detailRange: { startNorm: number; endNorm: number } | null = null;

    /**
     * Detail strip below the overview (long recordings): always a waveform,
     * since the overview spectrogram is a whole-file image. null = hidden.
     */
    drawOverviewDetail(range?: { startNorm: number; endNorm: number } | null): void {
        if (range !== undefined) this.#detailRange = range;
        const r = this.#detailRange;
        const { overviewDetailCanvas, overviewDetail } = this.#d;
        const audioBuffer = this.#getAudioBuffer();
        if (!r || !overviewDetailCanvas || !overviewDetail || !audioBuffer || overviewDetail.hidden) return;
        renderOverviewWaveform({
            audioBuffer,
            overviewCanvas: overviewDetailCanvas,
            overviewContainer: overviewDetail,
            amplitudePeakAbs: this.#getAmplitudePeakAbs(),
            startNorm: r.startNorm,
            endNorm: r.endNorm,
            display: this.#getWaveformDisplay(),
        });
    }

    drawOverviewWaveform(): void {
        if (!this.#getShowOverview()) return;
        this.drawOverviewDetail();
        const { overviewCanvas, overviewContainer } = this.#d;
        if (!overviewCanvas || !overviewContainer) return;
        const audioBuffer = this.#getAudioBuffer();
        if (!audioBuffer) return;
        const token = ++this.#overviewToken;
        const drawWaveform = (force = true) => {
            const rect = overviewContainer.getBoundingClientRect();
            // The selected samples identify buffer and channel selection.
            const display = this.#getWaveformDisplay();
            const key = { samples: selectedSamples(audioBuffer), w: Math.floor(rect.width), h: Math.floor(rect.height), peak: this.#getAmplitudePeakAbs(), display };
            const k = this.#overviewWaveKey;
            const same = !this.#overviewHasImage && k && k.samples === key.samples && k.w === key.w && k.h === key.h && k.peak === key.peak
                && k.display.scale === display.scale && k.display.reference === display.reference && k.display.dbRange === display.dbRange;
            this.#overviewHasImage = false;
            this.#overviewImage = null;
            if (same && !force) return;
            this.#overviewWaveKey = key;
            renderOverviewWaveform({
                audioBuffer,
                overviewCanvas,
                overviewContainer,
                amplitudePeakAbs: this.#getAmplitudePeakAbs(),
                display,
            });
        };
        if (this.#getOverviewMode() !== 'spectrogram') {
            drawWaveform();
            this.#scheduleUiUpdate();
            return;
        }
        // Spectrogram: keep what is shown until the new image is ready; the
        // waveform stands in while the spectrogram is still being computed.
        if (!this.#overviewHasImage) drawWaveform(false);
        const cols = Math.max(1, Math.floor(overviewContainer.getBoundingClientRect().width));
        this.#getOverviewImage(cols).then((image) => {
            if (token !== this.#overviewToken || this.#getAudioBuffer() !== audioBuffer) return;
            if (image) {
                // Cached images come back as the same object: redraw only on change or resize.
                const sized = overviewCanvas.width === Math.max(1, cols);
                if (image !== this.#overviewImage || !this.#overviewHasImage || !sized) {
                    renderOverviewImage({ image, overviewCanvas, overviewContainer });
                }
                this.#overviewHasImage = true;
                this.#overviewImage = image;
            } else if (this.#overviewHasImage) {
                drawWaveform();
            }
        }).catch((err) => {
            if (token === this.#overviewToken) console.warn('Overview spectrogram failed:', err);
        });
        this.#scheduleUiUpdate();
    }

    /** A new file is loading: the old spectrogram image must not stay on screen. */
    resetOverview(): void {
        this.#overviewHasImage = false;
        this.#overviewImage = null;
        this.#overviewWaveKey = null;
        this.#overviewToken++;
    }

    #freqLabelsRO: ResizeObserver | null = null;
    #freqLabelsH = -1;

    createFrequencyLabels(): void {
        const el = this.#d.freqLabels;
        if (!el) return;
        renderFrequencyLabels({ labelsElement: el, coords: this.#getCoords() });
        this.#freqLabelsH = el.clientHeight;
        // Label density follows the axis height: lay out again when it changes.
        if (!this.#freqLabelsRO && typeof ResizeObserver !== 'undefined') {
            this.#freqLabelsRO = new ResizeObserver(() => {
                if (el.clientHeight !== this.#freqLabelsH) this.createFrequencyLabels();
            });
            this.#freqLabelsRO.observe(el);
        }
    }

    updateAmplitudeLabels(): void {
        const el = this.#d.amplitudeLabels;
        if (!el) return;
        el.innerHTML = '';

        const display  = this.#getWaveformDisplay();
        const clampedH = this.#getEffectiveWaveformHeight();
        const timelineH = this.#getShowWaveformTimeline()
            ? clamp(Math.round(clampedH * 0.22), 18, 32)
            : 0;
        const ampH = Math.max(32, clampedH - timelineH);
        const ticks = amplitudeTicks(amplitudeMap(display, this.#getAmplitudePeakAbs()), ampH);
        el.parentElement?.setAttribute('title', display.scale === 'db'
            ? `Amplitude in dBFS (${display.reference === 'full' ? 'full scale' : 'fit to peak'}, ${display.dbRange} dB from edge to centre)`
            : `Sample value (${display.reference === 'full' ? 'full scale ±1' : 'fit to peak'})`);
        el.classList?.toggle('amplitude-labels--db', display.scale === 'db');

        // Centred on the tick, kept inside the view (edge labels would stick out).
        const LABEL_H = 9;
        for (const t of ticks) {
            const y = t.frac * ampH;
            const top = clamp(y - LABEL_H / 2, 1, ampH - LABEL_H - 1);
            const span = document.createElement('span');
            span.textContent = t.text;
            span.style.top = `${top}px`;
            span.style.setProperty?.('--tick-pos', `${y - top}px`);
            el.appendChild(span);
        }
        if (display.scale === 'db') {
            const unit = document.createElement('span');
            unit.className = 'amplitude-unit';
            unit.textContent = 'dB';
            el.appendChild(unit);
        }
    }
}
