import type { OnFn } from '../shared/controller.types.ts';

export interface VolumeHost {
    muted: boolean;
    _setVolume(v: number): void;
    _toggleMute(): void;
}

export class VolumeController {
    private d: any;
    private host: VolumeHost;
    constructor(d: any, host: VolumeHost) { this.d = d; this.host = host; }

    bind(on: OnFn): void {
        on(this.d.volumeSlider, 'input', (e: Event) => {
            this.host.muted = false;
            this.host._setVolume(parseFloat((e.target as HTMLInputElement).value) / 100);
        });
        on(this.d.volumeToggleBtn, 'click', () => this.host._toggleMute());
    }
}
