import type { OnFn } from '../shared/controller.types.ts';

export interface DocumentEventsHost {
    _compactToolbarOpen: boolean;
    interaction: {
        isViewResize: boolean;
        isDraggingViewport: boolean;
        isDraggingPlayhead: boolean;
        isOverviewDrag: boolean;
        ctx: { panSuppressClick?: boolean; playheadSource?: string | undefined; overviewMoved?: boolean };
        release(): void;
        blockSeekClicks(ms: number): void;
        blockOverviewClicks(ms: number): void;
    };
    _updateViewResize(y: number): void;
    _updateViewportPan(x: number, y: number): void;
    _seekFromClientX(x: number, source?: string): void;
    _updateOverviewDrag(x: number): void;
    _stopViewResize(): void;
    _queueOverviewViewportApply(final: boolean): void;
    _setCompactToolbarOpen(open: boolean): void;
    _handleKeyboardShortcuts(e: KeyboardEvent): void;
    d: { toolbarRoot: HTMLElement | null };
}

export class DocumentEventsController {
    private host: DocumentEventsHost;
    constructor(host: DocumentEventsHost) { this.host = host; }

    bind(on: OnFn): void {
        const h = this.host;

        on(document, 'pointermove', (e: PointerEvent) => {
            if (h.interaction.isViewResize) { h._updateViewResize(e.clientY); return; }
            if (h.interaction.isDraggingViewport) h._updateViewportPan(e.clientX, e.clientY);
            if (h.interaction.isDraggingPlayhead) h._seekFromClientX(e.clientX, h.interaction.ctx.playheadSource);
            if (h.interaction.isOverviewDrag) h._updateOverviewDrag(e.clientX);
        });

        const releaseAll = () => {
            h._stopViewResize();
            if (h.interaction.isDraggingViewport) {
                if (h.interaction.ctx.panSuppressClick) h.interaction.blockSeekClicks(50);
                document.body.style.cursor = '';
            }
            if (h.interaction.isOverviewDrag) {
                h._queueOverviewViewportApply(true);
                if (h.interaction.ctx.overviewMoved) h.interaction.blockOverviewClicks(260);
            }
            h.interaction.release();
        };
        on(document, 'pointerup', releaseAll);
        on(document, 'pointercancel', releaseAll);

        on(document, 'keydown', (e: KeyboardEvent) => h._handleKeyboardShortcuts(e));
        on(document, 'pointerdown', (e: PointerEvent) => {
            if (!h._compactToolbarOpen) return;
            if (h.d.toolbarRoot?.contains(e.target as Node)) return;
            h._setCompactToolbarOpen(false);
        });
    }
}
