import './settings-panel.scss';
import type { OnFn } from '../shared/controller.types.ts';

export interface SettingsPanelHost {
    readonly audioBuffer: AudioBuffer | null;
    _freqView: { resetSilent(): void };
    _spectro: { hasData: boolean; buildGrayscale(): void; buildBaseImage(scheme: any): void };
    _presets: { currentColorScheme: any; bindEvents(on: OnFn): void };
    _emit(event: string, detail: any): void;
    _updateCoords(): void;
    _createFrequencyLabels(): void;
    _drawSpectrogram(): void;
    _setPixelsPerSecond(pps: number, snap: boolean): void;
    _requestSpectrogramRedraw(): void;
}

export class SettingsPanelController {
    constructor(private d: any, private host: SettingsPanelHost) {}

    bind(on: OnFn): void {
        const h = this.host;

        // PresetManager owns DSP controls and calls back via onRegenerateSpectrogram / onStage1Rebuild
        h._presets.bindEvents(on);

        on(this.d.maxFreqSelect, 'change', () => {
            if (h.audioBuffer && h._spectro.hasData) {
                h._freqView.resetSilent();
                h._emit('spectrogramscalechange', { maxFreq: parseFloat(this.d.maxFreqSelect.value) });
                h._updateCoords();
                h._createFrequencyLabels();
                h._spectro.buildGrayscale();
                h._spectro.buildBaseImage(h._presets.currentColorScheme);
                h._drawSpectrogram();
                if (this.d.freqZoomResetBtn) this.d.freqZoomResetBtn.hidden = true;
            }
        });
        on(this.d.zoomSlider, 'input', (e: Event) => {
            h._setPixelsPerSecond(parseFloat((e.target as HTMLInputElement).value), false);
            h._requestSpectrogramRedraw();
        });
        on(this.d.zoomSlider, 'change', () => {
            if (h._spectro.hasData) h._drawSpectrogram();
        });
        for (const key of ['showCentroidCheck', 'showF0Check', 'showRidgesCheck'] as const) {
            on(this.d[key], 'change', () => {
                if (h._spectro.hasData) h._drawSpectrogram();
            });
        }
    }
}
