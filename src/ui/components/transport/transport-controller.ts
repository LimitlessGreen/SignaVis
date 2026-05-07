import type { OnFn, UiController } from '../shared/controller.types.ts';
import type { DomRefs } from '../../../app/domRefs.ts';
import { SEEK_COARSE_SEC, DEFAULT_ZOOM_PPS } from '../../../shared/constants.ts';

export interface TransportHost {
    readonly audioBuffer: AudioBuffer | null;
    loopPlayback: boolean;
    _compactToolbarOpen: boolean;
    _freqView: { reset(): void };
    d: { audioFile: HTMLInputElement };
    _handleFileSelect(e: Event): void;
    _togglePlayPause(): void;
    _stopPlayback(): void;
    _seekToTime(t: number, ui: boolean): void;
    _seekByDelta(delta: number): void;
    _cycleFollowMode(): void;
    _updateToggleButtons(): void;
    _toggleCrosshair(): void;
    _fitEntireTrackInView(): void;
    _setPixelsPerSecond(pps: number, snap: boolean): void;
    _setLinkedScrollLeft(x: number): void;
    _syncOverviewWindowToViewport(): void;
    _toggleSettingsPanel(): void;
    _setSettingsPanelOpen(open: boolean): void;
    _setCompactToolbarOpen(open: boolean): void;
}

export class TransportController implements UiController {
    private d: DomRefs;
    private host: TransportHost;
    constructor(d: DomRefs, host: TransportHost) { this.d = d; this.host = host; }

    bind(on: OnFn): void {
        const h = this.host;
        on(this.d.openFileBtn, 'click', () => h.d.audioFile.click());
        on(this.d.compactMoreBtn, 'click', (e: MouseEvent) => {
            e.preventDefault();
            e.stopPropagation();
            h._setCompactToolbarOpen(!h._compactToolbarOpen);
        });
        on(this.d.settingsToggleBtn, 'click', () => h._toggleSettingsPanel());
        on(this.d.settingsPanelClose, 'click', () => h._setSettingsPanelOpen(false));
        on(this.d.audioFile, 'change', (e: Event) => h._handleFileSelect(e));
        on(this.d.playPauseBtn, 'click', () => h._togglePlayPause());
        on(this.d.stopBtn, 'click', () => h._stopPlayback());
        on(this.d.jumpStartBtn, 'click', () => h._seekToTime(0, true));
        on(this.d.jumpEndBtn, 'click', () => h._seekToTime(h.audioBuffer?.duration ?? 0, true));
        on(this.d.backwardBtn, 'click', () => h._seekByDelta(-SEEK_COARSE_SEC));
        on(this.d.forwardBtn, 'click', () => h._seekByDelta(SEEK_COARSE_SEC));
        on(this.d.followToggleBtn, 'click', () => h._cycleFollowMode());
        on(this.d.loopToggleBtn, 'click', () => {
            h.loopPlayback = !h.loopPlayback;
            h._updateToggleButtons();
        });
        on(this.d.crosshairToggleBtn, 'click', () => h._toggleCrosshair());
        on(this.d.freqZoomResetBtn, 'click', () => h._freqView.reset());
        on(this.d.fitViewBtn, 'click', () => h._fitEntireTrackInView());
        on(this.d.resetViewBtn, 'click', () => {
            h._setPixelsPerSecond(DEFAULT_ZOOM_PPS, true);
            h._setLinkedScrollLeft(0);
            h._freqView.reset();
            h._syncOverviewWindowToViewport();
        });
    }
}
