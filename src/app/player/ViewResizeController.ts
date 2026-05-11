// ═══════════════════════════════════════════════════════════════════════
// ViewResizeController.ts — Manages the drag-to-resize handle between
// the waveform and spectrogram panes.
//
// Owns:
//   • waveformDisplayHeight / spectrogramDisplayHeight (user-set sizes)
//   • _cachedSpectrogramHeight (invalidation-based DOM measurement cache)
//   • RAF-batched redraw after drag
//   • CSS height helpers (_applyLocalViewHeights, effectiveHeight getters)
//
// All DOM/state dependencies are injected via constructor so this module
// can be tested without a full PlayerState.
// ═══════════════════════════════════════════════════════════════════════

import { MIN_WAVEFORM_HEIGHT, MIN_SPECTROGRAM_DISPLAY_HEIGHT } from '../../shared/constants.ts';
import { clamp } from '../../shared/utils.ts';
import type { InteractionState } from '../interactionState.ts';

export interface ViewResizeDeps {
    d: {
        waveformContainer: HTMLElement | null;
        spectrogramContainer: HTMLElement | null;
        canvasWrapper: HTMLElement | null;
    };
    interaction: InteractionState;
    initialWaveformHeight: number;
    initialSpectrogramHeight: number;
    getShowWaveform: () => boolean;
    getShowSpectrogram: () => boolean;
    getTransportOverlay: () => boolean;
    getAudioBuffer: () => any;
    getSpectroHasData: () => boolean;
    onDrawWaveform: () => void;
    onDrawSpectrogram: () => void;
    onAmplitudeLabels: () => void;
    getPrimaryScrollLeft: () => number;
    setLinkedScrollLeft: (x: number) => void;
    emit: (event: string, detail?: any) => void;
}

export class ViewResizeController {
    waveformDisplayHeight: number;
    spectrogramDisplayHeight: number;

    #rafId = 0;
    #needsWaveformRedraw = false;
    #needsSpectrogramRedraw = false;
    #cachedSpectrogramHeight = 0;

    #d: ViewResizeDeps['d'];
    #interaction: InteractionState;
    #getShowWaveform: () => boolean;
    #getShowSpectrogram: () => boolean;
    #getTransportOverlay: () => boolean;
    #getAudioBuffer: () => any;
    #getSpectroHasData: () => boolean;
    #onDrawWaveform: () => void;
    #onDrawSpectrogram: () => void;
    #onAmplitudeLabels: () => void;
    #getPrimaryScrollLeft: () => number;
    #setLinkedScrollLeft: (x: number) => void;
    #emit: (event: string, detail?: any) => void;

    constructor(deps: ViewResizeDeps) {
        this.waveformDisplayHeight    = deps.initialWaveformHeight;
        this.spectrogramDisplayHeight = deps.initialSpectrogramHeight;
        this.#d                   = deps.d;
        this.#interaction         = deps.interaction;
        this.#getShowWaveform     = deps.getShowWaveform;
        this.#getShowSpectrogram  = deps.getShowSpectrogram;
        this.#getTransportOverlay = deps.getTransportOverlay;
        this.#getAudioBuffer      = deps.getAudioBuffer;
        this.#getSpectroHasData   = deps.getSpectroHasData;
        this.#onDrawWaveform      = deps.onDrawWaveform;
        this.#onDrawSpectrogram   = deps.onDrawSpectrogram;
        this.#onAmplitudeLabels   = deps.onAmplitudeLabels;
        this.#getPrimaryScrollLeft = deps.getPrimaryScrollLeft;
        this.#setLinkedScrollLeft  = deps.setLinkedScrollLeft;
        this.#emit                = deps.emit;
    }

    // ── Height helpers ───────────────────────────────────────────────

    applyLocalViewHeights() {
        const transportOverlay = this.#getTransportOverlay();
        const showWaveform     = this.#getShowWaveform();
        const showSpectrogram  = this.#getShowSpectrogram();

        const overlaySingleWaveform     = transportOverlay && showWaveform && !showSpectrogram;
        const overlaySingleSpectrogram  = transportOverlay && showSpectrogram && !showWaveform;
        const waveformFlexes            = showWaveform && !showSpectrogram;

        if (showWaveform) {
            const c = this.#d.waveformContainer;
            if (c) {
                if (overlaySingleWaveform || waveformFlexes) {
                    c.style.height    = '';
                    c.style.minHeight = waveformFlexes
                        ? `${Math.round(this.waveformDisplayHeight)}px`
                        : '0';
                } else {
                    c.style.minHeight = '';
                    c.style.height    = `${Math.round(this.waveformDisplayHeight)}px`;
                }
            }
        }
        if (showSpectrogram) {
            const c = this.#d.spectrogramContainer;
            if (c) {
                if (overlaySingleSpectrogram) {
                    c.style.height    = '';
                    c.style.minHeight = '0';
                } else {
                    c.style.height    = '';
                    c.style.minHeight = `${Math.round(this.spectrogramDisplayHeight)}px`;
                }
            }
        }
    }

    getEffectiveWaveformHeight(): number {
        if (this.#getShowWaveform() && !this.#getShowSpectrogram()) {
            const h = (this.#d.waveformContainer as HTMLElement | null)?.clientHeight ?? 0;
            if (h > 0) return Math.max(MIN_WAVEFORM_HEIGHT, h);
        }
        return Math.max(MIN_WAVEFORM_HEIGHT, Math.floor(this.waveformDisplayHeight));
    }

    getEffectiveSpectrogramHeight(): number {
        // Cached height avoids a forced layout read on every scroll event.
        // Invalidated by invalidateSpectrogramHeightCache() on resize.
        if (this.#cachedSpectrogramHeight > 0) return this.#cachedSpectrogramHeight;
        const h = (this.#d.canvasWrapper as HTMLElement | null)?.clientHeight
               ?? (this.#d.spectrogramContainer as HTMLElement | null)?.clientHeight
               ?? 0;
        const result = h > 0
            ? Math.max(MIN_SPECTROGRAM_DISPLAY_HEIGHT, h)
            : Math.max(MIN_SPECTROGRAM_DISPLAY_HEIGHT, Math.floor(this.spectrogramDisplayHeight));
        this.#cachedSpectrogramHeight = result;
        return result;
    }

    invalidateSpectrogramHeightCache() {
        this.#cachedSpectrogramHeight = 0;
    }

    // ── Resize drag ──────────────────────────────────────────────────

    start(mode: string, clientY: number) {
        /** @type {Record<string, import('../interactionState.ts').InteractionMode>} */
        const modeMap: Record<string, import('../interactionState.ts').InteractionMode> = {
            split:       'view-resize-split',
            spectrogram: 'view-resize-spectrogram',
        };
        if (!this.#interaction.enter(modeMap[mode])) return;
        this.#interaction.ctx.resizeStartY               = clientY;
        this.#interaction.ctx.resizeStartWaveformH       = this.waveformDisplayHeight;
        this.#interaction.ctx.resizeStartSpectrogramH    = this.spectrogramDisplayHeight;
        document.body.style.cursor = 'row-resize';
    }

    update(clientY: number) {
        const sub = this.#interaction.viewResizeSubMode;
        if (!sub) return;
        const showWaveform    = this.#getShowWaveform();
        const showSpectrogram = this.#getShowSpectrogram();
        if ((sub === 'split'       && (!showWaveform || !showSpectrogram)) ||
            (sub === 'spectrogram' && !showSpectrogram)) return;

        const ctx = this.#interaction.ctx;
        const dy = clientY - (ctx.resizeStartY ?? 0);
        let redrawWav = false;

        if (sub === 'split') {
            const total = (ctx.resizeStartWaveformH ?? 0) + (ctx.resizeStartSpectrogramH ?? 0);
            let nextWav = (ctx.resizeStartWaveformH ?? 0) + dy;
            nextWav = clamp(nextWav, MIN_WAVEFORM_HEIGHT, total - MIN_SPECTROGRAM_DISPLAY_HEIGHT);
            this.waveformDisplayHeight    = nextWav;
            this.spectrogramDisplayHeight = total - nextWav;
            redrawWav = true;
        } else {
            this.spectrogramDisplayHeight = Math.max(
                MIN_SPECTROGRAM_DISPLAY_HEIGHT,
                (ctx.resizeStartSpectrogramH ?? 0) + dy,
            );
        }

        this.applyLocalViewHeights();
        if (redrawWav) this.#onAmplitudeLabels();
        if (!this.#getAudioBuffer()) return;
        this.queueRedraw({
            redrawWaveform:     redrawWav,
            redrawSpectrogram:  this.#getSpectroHasData(),
        });
    }

    stop() {
        if (!this.#interaction.isViewResize) return;
        this.#flushRedraw(true);
        this.#interaction.release();
        document.body.style.cursor = '';
    }

    queueRedraw({ redrawWaveform = false, redrawSpectrogram = false } = {}) {
        this.#needsWaveformRedraw    = this.#needsWaveformRedraw    || redrawWaveform;
        this.#needsSpectrogramRedraw = this.#needsSpectrogramRedraw || redrawSpectrogram;
        if (this.#rafId) return;
        this.#rafId = requestAnimationFrame(() => this.#flushRedraw(false));
    }

    dispose() {
        if (this.#rafId) {
            cancelAnimationFrame(this.#rafId);
            this.#rafId = 0;
        }
    }

    #flushRedraw(force: boolean) {
        if (!this.#getAudioBuffer()) return;
        if (this.#rafId) {
            cancelAnimationFrame(this.#rafId);
            this.#rafId = 0;
        }
        // Container was resized — cached height is stale.
        this.invalidateSpectrogramHeightCache();

        const redrawWaveform    = force || this.#needsWaveformRedraw;
        const redrawSpectrogram = force || this.#needsSpectrogramRedraw;
        this.#needsWaveformRedraw    = false;
        this.#needsSpectrogramRedraw = false;

        const savedScroll = this.#getPrimaryScrollLeft();
        if (redrawWaveform)    this.#onDrawWaveform();
        if (redrawSpectrogram) this.#onDrawSpectrogram();
        this.#setLinkedScrollLeft(savedScroll);
        this.#emit('viewresize', {
            waveformHeight:     this.waveformDisplayHeight,
            spectrogramHeight:  this.spectrogramDisplayHeight,
        });
    }
}
