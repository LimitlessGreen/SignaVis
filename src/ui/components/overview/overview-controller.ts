import type { OnFn } from '../shared/controller.types.ts';
import { clamp } from '../../../shared/utils.ts';

export interface OverviewHost {
    readonly audioBuffer: AudioBuffer | null;
    _showOverview: boolean;
    interaction: {
        isOverviewClickBlocked(): boolean;
        ctx: { overviewMoved?: boolean };
        blockOverviewClicks(ms: number): void;
    };
    _startOverviewDrag(side: 'left' | 'right' | 'move', x: number): void;
    _queueOverviewViewportApply(final: boolean): void;
    _seekToTime(t: number, ui: boolean): void;
    _toggleOverviewLabelSection(): void;
}

export class OverviewController {
    private d: any;
    private host: OverviewHost;
    constructor(d: any, host: OverviewHost) { this.d = d; this.host = host; }

    bind(on: OnFn): void {
        const h = this.host;

        on(this.d.overviewHandleLeft, 'pointerdown', (e: PointerEvent) => {
            if (!h._showOverview) return;
            e.preventDefault();
            h._startOverviewDrag('left', e.clientX);
        });
        on(this.d.overviewHandleRight, 'pointerdown', (e: PointerEvent) => {
            if (!h._showOverview) return;
            e.preventDefault();
            h._startOverviewDrag('right', e.clientX);
        });
        on(this.d.overviewWindow, 'pointerdown', (e: PointerEvent) => {
            if (!h._showOverview) return;
            if (e.target === this.d.overviewHandleLeft || e.target === this.d.overviewHandleRight) return;
            e.preventDefault();
            h._startOverviewDrag('move', e.clientX);
        });
        on(this.d.overviewCanvas, 'click', (e: MouseEvent) => {
            if (h.interaction.isOverviewClickBlocked()) return;
            if (!h._showOverview || !h.audioBuffer) return;
            const rect = this.d.overviewCanvas.getBoundingClientRect();
            const xNorm = clamp((e.clientX - rect.left) / rect.width, 0, 1);
            h._seekToTime(xNorm * h.audioBuffer.duration, true);
        });
        on(this.d.overviewLabelToggle, 'click', () => h._toggleOverviewLabelSection());
    }
}
