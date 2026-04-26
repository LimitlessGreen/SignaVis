import type { OnFn } from '../shared/controller.types.ts';
import { SEEK_FINE_SEC } from '../../../shared/constants.ts';
import { isTypingContext } from '../../../shared/utils.ts';

export interface CanvasInteractionHost {
    readonly audioBuffer: AudioBuffer | null;
    readonly scrollSyncLock: boolean;
    _freqView: { reset(): void };
    _spectro: { hasData: boolean };
    _getPrimaryScrollWrapper(): HTMLElement;
    _setLinkedScrollLeft(x: number): void;
    _drawSpectrogram(): void;
    _handleCanvasClick(e: MouseEvent): void;
    _handleWaveformClick(e: MouseEvent): void;
    _updateCrosshair(e: MouseEvent): void;
    _hideCrosshair(): void;
    _handleWheel(e: WheelEvent, source: 'spectrogram' | 'waveform'): void;
    _seekByDelta(delta: number): void;
    _seekToTime(t: number, ui: boolean): void;
    _startViewportPan(e: PointerEvent, source: 'spectrogram' | 'waveform'): void;
}

export class CanvasInteractionController {
    private d: any;
    private host: CanvasInteractionHost;
    constructor(d: any, host: CanvasInteractionHost) { this.d = d; this.host = host; }

    bind(on: OnFn): void {
        const h = this.host;

        on(this.d.canvasWrapper, 'click', (e: MouseEvent) => h._handleCanvasClick(e));
        on(this.d.canvasWrapper, 'dblclick', (e: MouseEvent) => {
            if (e.shiftKey) { e.preventDefault(); h._freqView.reset(); }
        });
        on(this.d.canvasWrapper, 'mousemove', (e: MouseEvent) => h._updateCrosshair(e));
        on(this.d.canvasWrapper, 'mouseleave', () => h._hideCrosshair());
        on(this.d.waveformWrapper, 'click', (e: MouseEvent) => h._handleWaveformClick(e));

        on(this.d.canvasWrapper, 'scroll', () => {
            if (h.scrollSyncLock) return;
            if (h._getPrimaryScrollWrapper() !== this.d.canvasWrapper) return;
            h._setLinkedScrollLeft(this.d.canvasWrapper.scrollLeft);
            // Synchronous redraw so canvas doesn't lag behind the label overlay
            if (h._spectro.hasData) h._drawSpectrogram();
        });
        on(this.d.waveformWrapper, 'scroll', () => {
            if (h.scrollSyncLock) return;
            if (h._getPrimaryScrollWrapper() !== this.d.waveformWrapper) return;
            h._setLinkedScrollLeft(this.d.waveformWrapper.scrollLeft);
            if (h._spectro.hasData) h._drawSpectrogram();
        });

        on(this.d.canvasWrapper, 'wheel', (e: WheelEvent) => h._handleWheel(e, 'spectrogram'), { passive: false });
        on(this.d.waveformWrapper, 'wheel', (e: WheelEvent) => h._handleWheel(e, 'waveform'), { passive: false });

        on(this.d.canvasWrapper, 'keydown', (e: KeyboardEvent) => {
            if (!h.audioBuffer) return;
            if (isTypingContext(e.target)) return;
            switch (e.key) {
                case 'ArrowLeft':  e.preventDefault(); h._seekByDelta(-SEEK_FINE_SEC); break;
                case 'ArrowRight': e.preventDefault(); h._seekByDelta(SEEK_FINE_SEC); break;
                case 'Home': e.preventDefault(); h._seekToTime(0, true); break;
                case 'End':  e.preventDefault(); h._seekToTime(h.audioBuffer!.duration, true); break;
            }
        });

        on(this.d.canvasWrapper, 'pointerdown', (e: PointerEvent) => h._startViewportPan(e, 'spectrogram'));
        on(this.d.waveformWrapper, 'pointerdown', (e: PointerEvent) => h._startViewportPan(e, 'waveform'));
    }
}
