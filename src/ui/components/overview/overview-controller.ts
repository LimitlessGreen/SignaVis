import type { OnFn, UiController } from '../shared/controller.types.ts';
import type { DomRefs } from '../../../app/domRefs.ts';
import { clamp } from '../../../shared/utils.ts';

export interface OverviewHost {
    readonly audioBuffer: AudioBuffer | null;
    _showOverview: boolean;
    interaction: {
        isOverviewClickBlocked(): boolean;
        ctx: { overviewMoved?: boolean };
        blockOverviewClicks(ms: number): void;
    };
    _startOverviewDrag(side: 'left' | 'right' | 'move', x: number, scale?: number): void;
    readonly _viewport: { lensActive: boolean; lensStartNorm: number; lensEndNorm: number };
    _queueOverviewViewportApply(final: boolean): void;
    _seekToTime(t: number, ui: boolean): void;
    _toggleOverviewLabelSection(): void;
    _onLabelViewTabClick(view: 'tracks' | 'table'): void;
    _startLabelTableResize(e: PointerEvent): void;
}

export class OverviewController implements UiController {
    private d: DomRefs;
    private host: OverviewHost;
    constructor(d: DomRefs, host: OverviewHost) { this.d = d; this.host = host; }

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
        // Lens bracket on the main strip: a wide grab area for the thin window.
        on(this.d.overviewLens, 'pointerdown', (e: PointerEvent) => {
            if (!h._showOverview) return;
            e.preventDefault();
            h._startOverviewDrag('move', e.clientX);
        });
        // Detail strip: same gestures, scaled to the magnified range.
        const lensScale = () => Math.max(1e-9, h._viewport.lensEndNorm - h._viewport.lensStartNorm);
        on(this.d.overviewDetailHandleLeft, 'pointerdown', (e: PointerEvent) => {
            e.preventDefault();
            h._startOverviewDrag('left', e.clientX, lensScale());
        });
        on(this.d.overviewDetailHandleRight, 'pointerdown', (e: PointerEvent) => {
            e.preventDefault();
            h._startOverviewDrag('right', e.clientX, lensScale());
        });
        on(this.d.overviewDetailWindow, 'pointerdown', (e: PointerEvent) => {
            if (e.target === this.d.overviewDetailHandleLeft || e.target === this.d.overviewDetailHandleRight) return;
            e.preventDefault();
            h._startOverviewDrag('move', e.clientX, lensScale());
        });
        on(this.d.overviewDetailCanvas, 'click', (e: MouseEvent) => {
            if (h.interaction.isOverviewClickBlocked()) return;
            if (!h._viewport.lensActive || !h.audioBuffer) return;
            const rect = this.d.overviewDetailCanvas!.getBoundingClientRect();
            const xNorm = clamp((e.clientX - rect.left) / rect.width, 0, 1);
            const v = h._viewport;
            h._seekToTime((v.lensStartNorm + xNorm * (v.lensEndNorm - v.lensStartNorm)) * h.audioBuffer.duration, true);
        });
        on(this.d.overviewCanvas, 'click', (e: MouseEvent) => {
            if (h.interaction.isOverviewClickBlocked()) return;
            if (!h._showOverview || !h.audioBuffer) return;
            const rect = this.d.overviewCanvas!.getBoundingClientRect();
            const xNorm = clamp((e.clientX - rect.left) / rect.width, 0, 1);
            h._seekToTime(xNorm * h.audioBuffer.duration, true);
        });
        on(this.d.overviewLabelToggle, 'click', () => h._toggleOverviewLabelSection());
        on(this.d.overviewLabelTabs, 'click', (e: MouseEvent) => {
            const b = (e.target as HTMLElement).closest<HTMLElement>('[data-view]');
            if (b) h._onLabelViewTabClick(b.dataset.view === 'table' ? 'table' : 'tracks');
        });
        on(this.d.overviewLabelTableResize, 'pointerdown', (e: PointerEvent) => h._startLabelTableResize(e));
    }
}
