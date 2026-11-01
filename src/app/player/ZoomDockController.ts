// ═══════════════════════════════════════════════════════════════════════
// ZoomDockController.ts — keeps the zoom widget on one line
//
// The zoom widget lives in the toolbar. When the toolbar is too narrow for it
// to sit on the same line as the controls before it (it would wrap), it moves
// into a strip below the spectrogram, and back once there is room again.
// ═══════════════════════════════════════════════════════════════════════

export class ZoomDockController {
    #widget: HTMLElement | null;
    #sep: HTMLElement | null;
    #dock: HTMLElement | null;
    #anchor: Comment | null = null;
    #ro: ResizeObserver | null = null;
    #raf = 0;

    constructor(container: HTMLElement) {
        this.#widget = container.querySelector('.zoom-widget');
        this.#dock = container.querySelector('[data-aw="zoomDock"]');
        const prev = this.#widget?.previousElementSibling as HTMLElement | null;
        this.#sep = prev?.classList.contains('toolbar-sep') ? prev : null;
        const toolbar = container.querySelector('[data-aw="toolbarRoot"]') as HTMLElement | null;
        if (!this.#widget || !this.#dock || !toolbar || this.#widget.hidden || typeof ResizeObserver === 'undefined') return;
        this.#anchor = document.createComment('zoom-widget');
        this.#widget.before(this.#anchor);
        this.#ro = new ResizeObserver(() => this.#schedule());
        this.#ro.observe(toolbar);
        this.#schedule();
    }

    #schedule() {
        if (this.#raf) return;
        this.#raf = requestAnimationFrame(() => { this.#raf = 0; this.#place(); });
    }

    /** Try the toolbar first; dock below the spectrogram if the widget wraps there. */
    #place() {
        const w = this.#widget!, dock = this.#dock!, anchor = this.#anchor!;
        if (w.parentElement !== anchor.parentNode) anchor.after(w);
        if (this.#sep) this.#sep.hidden = false;
        if (!this.#wraps(w)) {
            dock.hidden = true;
            return;
        }
        if (this.#sep) this.#sep.hidden = true;
        dock.appendChild(w);
        dock.hidden = false;
    }

    /** True when the widget starts a new line, i.e. sits below the first item of its row group. */
    #wraps(w: HTMLElement): boolean {
        const parent = w.parentElement;
        if (!parent) return false;
        const top = w.getBoundingClientRect().top;
        for (const el of Array.from(parent.children) as HTMLElement[]) {
            if (el === w) break;
            const r = el.getBoundingClientRect();
            if (r.width === 0 && r.height === 0) continue;
            // An earlier visible item ends above the widget's top: the widget wrapped.
            return top >= r.bottom - 1;
        }
        return false;
    }

    dispose() {
        this.#ro?.disconnect();
        if (this.#raf) cancelAnimationFrame(this.#raf);
    }
}
