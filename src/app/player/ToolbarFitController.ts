// ═══════════════════════════════════════════════════════════════════════
// ToolbarFitController.ts — keeps the player toolbar on one line
//
// The toolbar never wraps on its own. When its contents do not fit, it is
// compacted step by step until they do:
//   0  everything in the toolbar, buttons with icon + text
//   1  zoom widget moves into the strip below the spectrogram
//   2  view/tool buttons show only their icon (.tb-compact)
//   3  view toggles fold behind a "⋯" popover (.tb-overflow)
//   4  last resort: the toolbar may wrap (.tb-wrap)
// Each resize starts again from level 0, so wide players get the zoom back.
// ═══════════════════════════════════════════════════════════════════════

export class ToolbarFitController {
    #toolbar: HTMLElement | null;
    #widget: HTMLElement | null;
    #sep: HTMLElement | null;
    #dock: HTMLElement | null;
    #anchor: Comment | null = null;
    #ro: ResizeObserver | null = null;
    #mo: MutationObserver | null = null;
    #raf = 0;
    #lastWidth = -1;
    level = 0;

    constructor(container: HTMLElement) {
        this.#toolbar = container.querySelector('[data-aw="toolbarRoot"]');
        this.#widget = container.querySelector('.zoom-widget');
        this.#dock = container.querySelector('[data-aw="zoomDock"]');
        const prev = this.#widget?.previousElementSibling as HTMLElement | null;
        this.#sep = prev?.classList.contains('toolbar-sep') ? prev : null;
        if (!this.#toolbar || typeof ResizeObserver === 'undefined') return;
        if (this.#widget && this.#dock && !this.#widget.hidden) {
            this.#anchor = document.createComment('zoom-widget');
            this.#widget.before(this.#anchor);
        }
        this.#ro = new ResizeObserver(() => {
            const w = this.#toolbar!.clientWidth;
            if (w === this.#lastWidth) return;  // height changes come from our own steps
            this.#lastWidth = w;
            this.#schedule();
        });
        this.#ro.observe(this.#toolbar);
        // Buttons added later (label tools) or shown/hidden (ultrasound chip) change the fit too.
        if (typeof MutationObserver !== 'undefined') {
            this.#mo = new MutationObserver(() => this.#schedule());
            this.#mo.observe(this.#toolbar, { childList: true, subtree: true, attributes: true, attributeFilter: ['hidden'], characterData: true });
        }
        this.#schedule();
    }

    /** Re-check the fit (e.g. after the host added toolbar buttons). */
    refresh() { this.#schedule(); }

    #schedule() {
        if (this.#raf) return;
        this.#raf = requestAnimationFrame(() => { this.#raf = 0; this.#fit(); });
    }

    #overflows(): boolean {
        const t = this.#toolbar!;
        return t.scrollWidth > t.clientWidth + 1;
    }

    #apply(level: number) {
        const t = this.#toolbar!;
        const docked = level >= 1 && !!this.#anchor;
        if (this.#anchor && this.#widget && this.#dock) {
            if (docked) {
                if (this.#widget.parentElement !== this.#dock) this.#dock.appendChild(this.#widget);
            } else if (this.#widget.parentElement !== this.#anchor.parentNode) {
                this.#anchor.after(this.#widget);
            }
            this.#dock.hidden = !docked;
            if (this.#sep) this.#sep.hidden = docked;
        }
        t.classList.toggle('tb-compact', level >= 2);
        t.classList.toggle('tb-overflow', level >= 3);
        t.classList.toggle('tb-wrap', level >= 4);
        this.level = level;
    }

    #fit() {
        if (!this.#toolbar) return;
        let level = 0;
        this.#apply(level);
        while (level < 4 && this.#overflows()) {
            level += (level === 0 && !this.#anchor) ? 2 : 1;
            this.#apply(level);
        }
        this.#mo?.takeRecords();  // our own moves are not a reason to re-fit
    }

    dispose() {
        this.#ro?.disconnect();
        this.#mo?.disconnect();
        if (this.#raf) cancelAnimationFrame(this.#raf);
    }
}
