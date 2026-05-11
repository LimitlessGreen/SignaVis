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
import {
    renderMainWaveform,
    renderOverviewWaveform,
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
}

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
        });
        this.#scheduleUiUpdate();
    }

    drawOverviewWaveform(): void {
        if (!this.#getShowOverview()) return;
        const { overviewCanvas, overviewContainer } = this.#d;
        if (!overviewCanvas || !overviewContainer) return;
        renderOverviewWaveform({
            audioBuffer:      this.#getAudioBuffer()!,
            overviewCanvas,
            overviewContainer,
            amplitudePeakAbs: this.#getAmplitudePeakAbs(),
        });
        this.#scheduleUiUpdate();
    }

    createFrequencyLabels(): void {
        if (this.#d.freqLabels) {
            renderFrequencyLabels({ labelsElement: this.#d.freqLabels, coords: this.#getCoords() });
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
