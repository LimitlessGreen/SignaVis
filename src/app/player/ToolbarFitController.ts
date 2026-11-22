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

/**
 * An ignored readout whose text got longer or shorter since the last call (`seen` keeps the
 * lengths). The readouts are monospace, so this is a width change without reading layout.
 */
export function readoutLengthChanged(seen: WeakMap<object, number>, node: Node): boolean {
    const el = (node.nodeType === 1 ? node as Element : node.parentElement)?.closest('[data-fit-ignore]');
    if (!el) return false;
    const len = el.textContent?.length ?? 0;
    const prev = seen.get(el);
    seen.set(el, len);
    return prev !== undefined && prev !== len;
}

/** Record the current text length of every ignored readout under `root`. */
export function seedReadoutLengths(seen: WeakMap<object, number>, root: ParentNode): void {
    for (const el of root.querySelectorAll('[data-fit-ignore]')) seen.set(el, el.textContent?.length ?? 0);
}

export function ignoredForFit(node: Node): boolean {
    const el = node.nodeType === 1 ? node as Element : node.parentElement;
    return !!el?.closest('[data-fit-ignore]');
}

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
            // Live readouts ([data-fit-ignore], e.g. the playback time) change every frame
            // and keep their width; re-fitting on them forced several layouts per frame.
            // They are monospace, so a change in text length (99:59.9 → 100:00.0) is a width change.
            this.#mo = new MutationObserver((records) => {
                if (records.some((r) => !ignoredForFit(r.target) || readoutLengthChanged(this.#readoutLength, r.target))) this.#schedule();
            });
            this.#mo.observe(this.#toolbar, { childList: true, subtree: true, attributes: true, attributeFilter: ['hidden'], characterData: true });
        }
        this.#schedule();
    }

    #readoutLength = new WeakMap<Element, number>();

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
        // The lengths the fit was made for: the first readout change after it compares against them
        seedReadoutLengths(this.#readoutLength, this.#toolbar);
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
