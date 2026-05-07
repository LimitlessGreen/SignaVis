import type { OnFn, UiController } from '../shared/controller.types.ts';
import type { DomRefs } from '../../../app/domRefs.ts';

export interface PlayheadHost {
    _showWaveform: boolean;
    _showSpectrogram: boolean;
    _startPlayheadDrag(e: PointerEvent, source: 'spectrogram' | 'waveform'): void;
    _startViewResize(type: 'split' | 'spectrogram', y: number): void;
}

export class PlayheadController implements UiController {
    private d: DomRefs;
    private host: PlayheadHost;
    constructor(d: DomRefs, host: PlayheadHost) { this.d = d; this.host = host; }

    bind(on: OnFn): void {
        const h = this.host;

        on(this.d.playhead, 'pointerdown', (e: PointerEvent) => h._startPlayheadDrag(e, 'spectrogram'));
        on(this.d.waveformPlayhead, 'pointerdown', (e: PointerEvent) => h._startPlayheadDrag(e, 'waveform'));

        on(this.d.viewSplitHandle, 'pointerdown', (e: PointerEvent) => {
            if (!h._showWaveform || !h._showSpectrogram) return;
            e.preventDefault();
            h._startViewResize('split', e.clientY);
        });
        on(this.d.spectrogramResizeHandle, 'pointerdown', (e: PointerEvent) => {
            if (!h._showSpectrogram) return;
            e.preventDefault();
            h._startViewResize('spectrogram', e.clientY);
        });
    }
}
