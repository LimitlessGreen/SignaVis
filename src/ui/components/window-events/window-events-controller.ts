import type { OnFn } from '../shared/controller.types.ts';

export interface WindowEventsHost {
    readonly audioBuffer: AudioBuffer | null;
    readonly waveformDisplayHeight: number;
    readonly spectrogramDisplayHeight: number;
    _queueCompactToolbarLayoutRefresh(): void;
    _shouldCompactToolbarBeActive(): boolean;
    _setCompactToolbarOpen(open: boolean): void;
    _invalidateSpectrogramHeightCache(): void;
    _drawSpectrogram(): void;
    _drawMainWaveform(): void;
    _drawOverviewWaveform(): void;
    _syncOverviewWindowToViewport(): void;
    _emit(event: string, detail: any): void;
    dispose(): void;
}

export class WindowEventsController {
    constructor(private host: WindowEventsHost) {}

    bind(on: OnFn): void {
        const h = this.host;

        on(window, 'resize', () => {
            h._queueCompactToolbarLayoutRefresh();
            if (!h._shouldCompactToolbarBeActive()) h._setCompactToolbarOpen(false);
            if (!h.audioBuffer) return;
            h._invalidateSpectrogramHeightCache();
            h._drawSpectrogram();
            h._drawMainWaveform();
            h._drawOverviewWaveform();
            h._syncOverviewWindowToViewport();
            h._emit('viewresize', {
                waveformHeight: h.waveformDisplayHeight,
                spectrogramHeight: h.spectrogramDisplayHeight,
            });
        });
        on(window, 'beforeunload', () => h.dispose());
    }
}
