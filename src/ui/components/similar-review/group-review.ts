// group-review.ts — overview bar: walk through the groups of similar calls, largest first
//
//   Enter      name the group (template species, else the name dialog) → member review
//   X          skip this group                 ↓ / ↑   next / previous group
//   Space      play the group's typical call    Esc     close
//   slider     coarser ↔ finer grouping (re-groups)
// While the member review (similar-review.ts) is open this bar is suspended (hidden, no keys).

import { attachPeek } from './overlay-peek';

export interface GroupItem { size: number }
export interface GroupReviewHandlers {
    onShow: (index: number) => void;
    onPlay: (index: number) => void;
    onName: (index: number) => void;
    onRegroup: (cut: number) => void;
    onClose?: () => void;
    anchor?: () => DOMRect | null;
}

export class GroupReview {
    private el: HTMLElement | null = null;
    private detachPeek: (() => void) | null = null;
    private groups: GroupItem[] = [];
    private done = new Set<number>();
    private pos = 0;
    private cut = 1;
    private suspended = false;
    private readonly onKey = (e: KeyboardEvent) => this.handleKey(e);
    private readonly onResize = () => this.place();

    constructor(private readonly h: GroupReviewHandlers) {}

    get isOpen(): boolean { return !!this.el; }
    get index(): number { return this.pos; }

    /** Open (or refill after re-grouping) with groups largest first. */
    open(groups: GroupItem[], cut: number) {
        this.groups = groups;
        this.cut = cut;
        this.done.clear();
        this.pos = 0;
        if (!this.el) {
            this.el = this.build();
            document.body.appendChild(this.el);
            this.detachPeek = attachPeek(this.el);
            window.addEventListener('resize', this.onResize);
        }
        this.suspended = false;
        document.addEventListener('keydown', this.onKey, true);
        this.el.hidden = false;
        this.render();
        this.show();
        requestAnimationFrame(() => requestAnimationFrame(() => this.place()));
    }

    close() {
        if (!this.el) return;
        document.removeEventListener('keydown', this.onKey, true);
        window.removeEventListener('resize', this.onResize);
        this.detachPeek?.();
        this.detachPeek = null;
        this.el.remove();
        this.el = null;
        this.h.onClose?.();
    }

    /** Hide while the members are reviewed. */
    suspend() {
        if (!this.el || this.suspended) return;
        this.suspended = true;
        document.removeEventListener('keydown', this.onKey, true);
        this.el.hidden = true;
    }

    /** Back after the member review; `named` marks the group done and moves on. */
    resume(named: boolean) {
        if (!this.el || !this.suspended) return;
        this.suspended = false;
        document.addEventListener('keydown', this.onKey, true);
        this.el.hidden = false;
        if (named) { this.done.add(this.pos); this.step(1, true); } else { this.render(); this.show(); }
    }

    private open_(): number[] { return this.groups.map((_, i) => i).filter((i) => !this.done.has(i)); }

    /** Next / previous open group; closes when none is left. */
    private step(d: number, skipCurrent = false) {
        const open = this.open_();
        if (!open.length) { this.close(); return; }
        if (skipCurrent || this.done.has(this.pos)) {
            const after = open.filter((i) => (d > 0 ? i > this.pos : i < this.pos));
            this.pos = after.length ? (d > 0 ? after[0] : after[after.length - 1]) : open[d > 0 ? 0 : open.length - 1];
        } else {
            const at = open.indexOf(this.pos);
            this.pos = open[(at + d + open.length) % open.length];
        }
        this.render();
        this.show();
    }

    private show() { if (this.groups.length) this.h.onShow(this.pos); }

    private handleKey(e: KeyboardEvent) {
        if (e.ctrlKey || e.metaKey || e.altKey) return;
        const t = e.target;
        if (t instanceof HTMLElement && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))
            && !this.el?.contains(t)) return;
        const k = e.key;
        if (t instanceof HTMLElement) {
            // Focused controls keep their own keys: buttons and links anywhere take Enter / Space,
            // the threshold slider its arrows. (Label boxes are role="button" divs: shortcuts stay on.)
            const ctl = t.closest('button, a[href], summary');
            if (ctl && (k === 'Enter' || k === ' ')) return;
            if (t instanceof HTMLInputElement && t.type === 'range' && this.el?.contains(t) && k.startsWith('Arrow')) return;
        }
        let handled = true;
        if (k === 'Enter') this.h.onName(this.pos);
        else if (k === 'x' || k === 'X' || k === 'Delete' || k === 'Backspace') { this.done.add(this.pos); this.step(1, true); }
        else if (k === 'ArrowDown') this.step(1);
        else if (k === 'ArrowUp') this.step(-1);
        else if (k === ' ') this.h.onPlay(this.pos);
        else if (k === 'Escape') this.close();
        else handled = false;
        if (handled) { e.preventDefault(); e.stopPropagation(); }
    }

    private build(): HTMLElement {
        const el = document.createElement('div');
        el.className = 'similar-review similar-review--groups';
        el.setAttribute('role', 'dialog');
        el.setAttribute('aria-label', 'Groups of similar calls');
        el.innerHTML = `
            <span class="similar-review__title">Call groups</span>
            <span class="similar-review__pos"></span>
            <span class="similar-review__score"></span>
            <button type="button" class="similar-review__btn" data-act="prev" title="Previous group (↑)">↑</button>
            <button type="button" class="similar-review__btn" data-act="next" title="Next group (↓)">↓</button>
            <button type="button" class="similar-review__btn" data-act="play" title="Play a typical call (Space)">▶</button>
            <button type="button" class="similar-review__btn similar-review__btn--ok" data-act="name" title="Name this group, then check its calls (Enter)">Name…</button>
            <button type="button" class="similar-review__btn similar-review__btn--no" data-act="skip" title="Skip this group (X)">Skip</button>
            <label class="similar-review__thr" title="Coarser groups: fewer to name, more strays to reject">
                fine <input type="range" min="0.6" max="1.4" step="0.1"> coarse
            </label>
            <button type="button" class="similar-review__btn" data-act="close" title="Close (Esc)">Done</button>`;
        el.addEventListener('click', (e) => {
            const act = (e.target as HTMLElement).closest('button')?.dataset.act;
            if (act === 'prev') this.step(-1);
            else if (act === 'next') this.step(1);
            else if (act === 'play') this.h.onPlay(this.pos);
            else if (act === 'name') this.h.onName(this.pos);
            else if (act === 'skip') { this.done.add(this.pos); this.step(1, true); }
            else if (act === 'close') this.close();
        });
        const range = el.querySelector('input') as HTMLInputElement;
        range.addEventListener('change', () => this.h.onRegroup(Number(range.value)));
        return el;
    }

    private place() {
        const el = this.el;
        if (!el) return;
        // Without a visible anchor (e.g. a narrow layout hides it): bottom centre of the window
        const a = this.h.anchor?.();
        const r = a && a.width && a.height ? a : { left: 0, width: window.innerWidth, bottom: window.innerHeight - 8 };
        const h = el.offsetHeight || 36;
        const w = el.offsetWidth || 0;   // centred by translateX(-50%): keep both edges in the window
        el.style.left = `${Math.round(Math.min(window.innerWidth - w / 2 - 4, Math.max(w / 2 + 4, r.left + r.width / 2)))}px`;
        el.style.top = `${Math.round(Math.min(window.innerHeight - h - 4, Math.max(4, r.bottom - h - 8)))}px`;
        el.style.bottom = 'auto';
    }

    private render() {
        const el = this.el;
        if (!el) return;
        const open = this.open_(), g = this.groups[this.pos];
        (el.querySelector('.similar-review__pos') as HTMLElement).textContent =
            g ? `${open.indexOf(this.pos) + 1} / ${open.length}` : '0';
        (el.querySelector('.similar-review__score') as HTMLElement).textContent = g ? `${g.size} calls` : '';
        (el.querySelector('input') as HTMLInputElement).value = String(this.cut);
        this.place();
    }
}
