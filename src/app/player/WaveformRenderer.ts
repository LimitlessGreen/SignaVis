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
    #overviewToken = 0;
    /** True while the strip shows a spectrogram image (kept on redraws until a new one is ready). */
    #overviewHasImage = false;
    /** What the strip's waveform was drawn for; skips rescanning every sample when nothing changed. */
    #overviewWaveKey: { samples: Float32Array; w: number; h: number; peak: number } | null = null;
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
            const key = { samples: selectedSamples(audioBuffer), w: Math.floor(rect.width), h: Math.floor(rect.height), peak: this.#getAmplitudePeakAbs() };
            const k = this.#overviewWaveKey;
            const same = !this.#overviewHasImage && k && k.samples === key.samples && k.w === key.w && k.h === key.h && k.peak === key.peak;
            this.#overviewHasImage = false;
            this.#overviewImage = null;
            if (same && !force) return;
            this.#overviewWaveKey = key;
            renderOverviewWaveform({
                audioBuffer,
                overviewCanvas,
                overviewContainer,
                amplitudePeakAbs: this.#getAmplitudePeakAbs(),
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

        const peak     = Math.max(1e-6, this.#getAmplitudePeakAbs() || 1);
        const clampedH = this.#getEffectiveWaveformHeight();
        const timelineH = this.#getShowWaveformTimeline()
            ? clamp(Math.round(clampedH * 0.22), 18, 32)
            : 0;
        const ampH = Math.max(32, clampedH - timelineH);

        const fmt = (v: number) => {
            const a = Math.abs(v);
            return a >= 1 ? v.toFixed(1) : a >= 0.01 ? v.toFixed(2) : v.toFixed(3);
        };

        const values = [peak, peak / 2, 0, -peak / 2, -peak];
        values.forEach((value, i) => {
            const frac = i / (values.length - 1);
            const span = document.createElement('span');
            span.textContent = value === 0 ? '0' : `${value > 0 ? '+' : '\u2212'}${fmt(Math.abs(value))}`;
            span.style.top = `${frac * ampH}px`;
            span.style.transform = `translateY(${-frac * 100}%)`;
            span.style.setProperty?.('--tick-pos', `${frac * 100}%`);
            el.appendChild(span);
        });
    }
}
