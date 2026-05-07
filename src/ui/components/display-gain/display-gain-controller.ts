import type { OnFn, UiController } from '../shared/controller.types.ts';
import type { DomRefs } from '../../../app/domRefs.ts';

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

export class DisplayGainController implements UiController {
    private d: DomRefs;
    private host: DisplayGainHost;
    constructor(d: DomRefs, host: DisplayGainHost) { this.d = d; this.host = host; }

    bind(on: OnFn): void {
        const h = this.host;

        const rebuildDisplay = () => {
            if (!h._spectro.hasData) return;
            h._spectro.buildBaseImage(h._presets.currentColorScheme);
            h._drawSpectrogram();
        };

        // Debounce: the slider moves freely with no JS blocking the native repaint.
        // The spectrogram rebuilds 150 ms after the last input so the user's
        // pointer never competes with canvas rendering.
        let debounceId = 0;
        const scheduleRebuild = () => {
            clearTimeout(debounceId);
            debounceId = window.setTimeout(() => { debounceId = 0; rebuildDisplay(); }, 150);
        };

        on(this.d.gainModeSelect, 'change', () => {
            h._presets.persistCurrentSettings();
            if (this.d.gainModeSelect!.value === 'auto' && h._spectro.data) {
                h._spectro.autoContrast(true);
            }
        });
        on(this.d.maxFreqModeSelect, 'change', () => {
            h._presets.persistCurrentSettings();
            if (!h.audioBuffer) return;
            const mode = this.d.maxFreqModeSelect!.value;
            if (mode === 'auto') h._spectro.autoFrequency(true);
            else if (mode === 'nyquist') { h._spectro.setMaxFreqToNyquist(); h._spectro.generate(); }
        });
        on(this.d.floorSlider, 'input', () => { h._presets.persistCurrentSettings(); scheduleRebuild(); });
        on(this.d.ceilSlider,  'input', () => { h._presets.persistCurrentSettings(); scheduleRebuild(); });
        on(this.d.autoContrastBtn, 'click', () => h._spectro.autoContrast(true));
        on(this.d.autoFreqBtn,     'click', () => h._spectro.autoFrequency(true));
    }
}
