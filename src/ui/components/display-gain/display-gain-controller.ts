import type { OnFn } from '../shared/controller.types.ts';

export interface DisplayGainHost {
    readonly audioBuffer: AudioBuffer | null;
    _spectro: {
        hasData: boolean;
        data: any;
        buildBaseImage(scheme: any): void;
        autoContrast(rebuild: boolean): void;
        autoFrequency(rebuild: boolean): void;
        setMaxFreqToNyquist(): void;
        generate(): void;
    };
    _presets: { currentColorScheme: any; persistCurrentSettings(): void };
    _drawSpectrogram(): void;
}

export class DisplayGainController {
    private d: any;
    private host: DisplayGainHost;
    constructor(d: any, host: DisplayGainHost) { this.d = d; this.host = host; }

    bind(on: OnFn): void {
        const h = this.host;
        const rebuildDisplay = () => {
            if (!h._spectro.hasData) return;
            h._spectro.buildBaseImage(h._presets.currentColorScheme);
            h._drawSpectrogram();
        };

        on(this.d.gainModeSelect, 'change', () => {
            h._presets.persistCurrentSettings();
            if (this.d.gainModeSelect.value === 'auto' && h._spectro.data) {
                h._spectro.autoContrast(true);
            }
        });
        on(this.d.maxFreqModeSelect, 'change', () => {
            h._presets.persistCurrentSettings();
            if (!h.audioBuffer) return;
            const mode = this.d.maxFreqModeSelect.value;
            if (mode === 'auto') h._spectro.autoFrequency(true);
            else if (mode === 'nyquist') { h._spectro.setMaxFreqToNyquist(); h._spectro.generate(); }
        });
        on(this.d.floorSlider, 'input', () => { h._presets.persistCurrentSettings(); rebuildDisplay(); });
        on(this.d.ceilSlider, 'input', () => { h._presets.persistCurrentSettings(); rebuildDisplay(); });
        on(this.d.autoContrastBtn, 'click', () => h._spectro.autoContrast(true));
        on(this.d.autoFreqBtn, 'click', () => h._spectro.autoFrequency(true));
    }
}
