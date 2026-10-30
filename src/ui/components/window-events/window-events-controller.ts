import type { OnFn, UiController } from '../shared/controller.types.ts';

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

export class WindowEventsController implements UiController {
    private host: WindowEventsHost;
    private observed: (Element | null | undefined)[];
    /** @param observed elements whose own resizes (not only the window's) re-layout the view */
    constructor(host: WindowEventsHost, observed: (Element | null | undefined)[] = []) {
        this.host = host;
        this.observed = observed;
    }

    bind(on: OnFn): void {
        const h = this.host;

        const relayout = () => {
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
        };

        // The player's width also changes without a window resize (panels
        // around it, a page scrollbar appearing); observe the views themselves.
        const targets = this.observed.filter((el): el is Element => !!el);
        const ro = typeof ResizeObserver !== 'undefined' && targets.length
            ? new ResizeObserver(() => relayout())
            : null;
        if (ro) {
            for (const el of targets) ro.observe(el);
            // OnFn only knows listeners; this adapter makes disposal disconnect.
            on({ addEventListener() {}, removeEventListener: () => ro.disconnect() }, 'resize', null);
        }

        on(window, 'resize', () => {
            h._queueCompactToolbarLayoutRefresh();
            if (!h._shouldCompactToolbarBeActive()) h._setCompactToolbarOpen(false);
            if (!ro) relayout();
        });
        on(window, 'beforeunload', () => h.dispose());
    }
}
