// similar-review.ts — review bar for "find similar calls" suggestions
//
// One suggestion at a time, best first: the host shows and plays it (onFocus).
//   Enter        copy into my labels       X / Delete   reject (not proposed again)
//   Shift+Enter  copy all at or above the threshold
//   ↓ / ↑        next / previous           Space        play again
//   Esc          close (suggestions stay visible; ✓ on a box still copies it)
// Keys are taken in the capture phase while the bar is open, ahead of the player's
// own shortcuts (X would delete the selected label).

export interface ReviewItem { id: string; score: number }
export interface SimilarReviewHandlers {
    onFocus: (id: string) => void;
    onPlay: (id: string) => void;
    onAccept: (ids: string[]) => void;
    onReject: (ids: string[]) => void;
    onClose?: () => void;
    /** Area to sit at the bottom of (e.g. the spectrogram); fixed near the window bottom without. */
    anchor?: () => DOMRect | null;
}

// Real recordings score lower than clean tests (Powdermill: correct repeats mostly 0.2–0.6)
const DEFAULT_THRESHOLD = 0.35;

export class SimilarReview {
    private el: HTMLElement | null = null;
    private items: ReviewItem[] = [];
    private pos = 0;
    /** No ↑/↓ since the last decision: a re-rank may move on to the new best. */
    private fresh = true;
    private threshold = DEFAULT_THRESHOLD;
    private title = '';
    private readonly onKey = (e: KeyboardEvent) => this.handleKey(e);
    private readonly onResize = () => this.place();

    constructor(private readonly h: SimilarReviewHandlers) {}

    get isOpen(): boolean { return !!this.el; }

    /** Open (or refill) for suggestions of one exemplar; `items` best first. */
    open(title: string, items: ReviewItem[]) {
        this.title = title;
        this.items = [...items].sort((a, b) => b.score - a.score);
        this.pos = 0;
        if (!this.el) {
            this.el = this.build();
            document.body.appendChild(this.el);
            document.addEventListener('keydown', this.onKey, true);
            window.addEventListener('resize', this.onResize);
        }
        this.render();
        this.focusCurrent();
        // The new 'Similar calls' track shrinks the spectrogram after this frame: place again
        requestAnimationFrame(() => requestAnimationFrame(() => this.place()));
    }

    close() {
        if (!this.el) return;
        document.removeEventListener('keydown', this.onKey, true);
        window.removeEventListener('resize', this.onResize);
        this.el.remove();
        this.el = null;
        this.h.onClose?.();
    }

    /** Drop items that no longer exist (removed elsewhere), keeping the position. */
    retain(ids: Set<string>) {
        const cur = this.items[this.pos]?.id;
        this.items = this.items.filter((i) => ids.has(i.id));
        const at = cur ? this.items.findIndex((i) => i.id === cur) : -1;
        this.pos = at >= 0 ? at : Math.min(this.pos, Math.max(0, this.items.length - 1));
        if (!this.el) return;
        if (!this.items.length) { this.close(); return; }
        this.render();
        // The previewed one went: preview the one now in its place
        if (this.items[this.pos]?.id !== cur) this.focusCurrent();
    }

    /**
     * New scores (e.g. re-ranked after a decision): best first again. The item on screen stays
     * unless the user has not moved since the last decision, then the new best is shown.
     */
    rescore(scores: Map<string, number>) {
        if (!this.el || !this.items.length) return;
        const cur = this.current?.id;
        for (const it of this.items) { const v = scores.get(it.id); if (v !== undefined && Number.isFinite(v)) it.score = v; }
        this.items.sort((a, b) => b.score - a.score);
        if (this.fresh) { this.pos = 0; this.render(); if (this.items[0].id !== cur) this.focusCurrent(); return; }
        this.pos = Math.max(0, this.items.findIndex((i) => i.id === cur));
        this.render();
    }

    private get current(): ReviewItem | undefined { return this.items[this.pos]; }
    private aboveThreshold(): ReviewItem[] { return this.items.filter((i) => i.score >= this.threshold); }

    private decide(accept: boolean) {
        const it = this.current;
        if (!it) return;
        this.items.splice(this.pos, 1);
        this.pos = 0;   // best remaining first
        (accept ? this.h.onAccept : this.h.onReject)([it.id]);
        this.afterChange();
    }

    private acceptAbove() {
        const ids = this.aboveThreshold().map((i) => i.id);
        if (!ids.length) return;
        const set = new Set(ids);
        this.items = this.items.filter((i) => !set.has(i.id));
        this.pos = 0;
        this.h.onAccept(ids);
        this.afterChange();
    }

    private afterChange() {
        this.fresh = true;
        if (!this.items.length) { this.close(); return; }
        this.render();
        this.focusCurrent();
    }

    private move(d: number) {
        if (!this.items.length) return;
        this.fresh = false;
        this.pos = (this.pos + d + this.items.length) % this.items.length;
        this.render();
        this.focusCurrent();
    }

    private focusCurrent() {
        const it = this.current;
        if (it) this.h.onFocus(it.id);
    }

    private handleKey(e: KeyboardEvent) {
        if (e.ctrlKey || e.metaKey || e.altKey) return;
        const t = e.target;
        if (t instanceof HTMLElement && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))
            && !this.el?.contains(t)) return;
        const k = e.key;
        // A focused button of the bar keeps Enter / Space for itself
        if ((k === 'Enter' || k === ' ') && t instanceof HTMLElement && t.closest('button') && this.el?.contains(t)) return;
        let done = true;
        if (k === 'Enter') { if (e.shiftKey) this.acceptAbove(); else this.decide(true); }
        else if (k === 'x' || k === 'X' || k === 'Delete' || k === 'Backspace') this.decide(false);
        else if (k === 'ArrowDown') this.move(1);
        else if (k === 'ArrowUp') this.move(-1);
        else if (k === ' ') { const it = this.current; if (it) this.h.onPlay(it.id); }
        else if (k === 'Escape') this.close();
        else done = false;
        if (done) { e.preventDefault(); e.stopPropagation(); }
    }

    private build(): HTMLElement {
        const el = document.createElement('div');
        el.className = 'similar-review';
        el.setAttribute('role', 'dialog');
        el.setAttribute('aria-label', 'Review similar calls');
        el.innerHTML = `
            <span class="similar-review__title"></span>
            <span class="similar-review__pos"></span>
            <span class="similar-review__score"></span>
            <button type="button" class="similar-review__btn" data-act="prev" title="Previous (↑)">↑</button>
            <button type="button" class="similar-review__btn" data-act="next" title="Next (↓)">↓</button>
            <button type="button" class="similar-review__btn" data-act="play" title="Play (Space)">▶</button>
            <button type="button" class="similar-review__btn similar-review__btn--ok" data-act="accept" title="Copy into my labels (Enter)">✓</button>
            <button type="button" class="similar-review__btn similar-review__btn--no" data-act="reject" title="Reject (X)">✗</button>
            <label class="similar-review__thr" title="Copy all suggestions with at least this score (Shift+Enter)">
                ≥ <input type="range" min="0.2" max="1" step="0.01"> <output></output>
            </label>
            <button type="button" class="similar-review__btn" data-act="all"></button>
            <button type="button" class="similar-review__btn" data-act="close" title="Close (Esc)">Done</button>`;
        el.addEventListener('click', (e) => {
            const act = (e.target as HTMLElement).closest('button')?.dataset.act;
            if (act === 'prev') this.move(-1);
            else if (act === 'next') this.move(1);
            else if (act === 'play') { const it = this.current; if (it) this.h.onPlay(it.id); }
            else if (act === 'accept') this.decide(true);
            else if (act === 'reject') this.decide(false);
            else if (act === 'all') this.acceptAbove();
            else if (act === 'close') this.close();
        });
        const range = el.querySelector('input') as HTMLInputElement;
        range.value = String(this.threshold);
        range.addEventListener('input', () => { this.threshold = Number(range.value); this.render(); });
        return el;
    }

    /** Bottom centre of the anchor, kept inside the window. */
    private place() {
        const el = this.el, r = this.h.anchor?.();
        if (!el || !r || !r.width || !r.height) return;
        const h = el.offsetHeight || 36;
        const w = el.offsetWidth || 0;   // centred by translateX(-50%): keep both edges in the window
        el.style.left = `${Math.round(Math.min(window.innerWidth - w / 2 - 4, Math.max(w / 2 + 4, r.left + r.width / 2)))}px`;
        el.style.top = `${Math.round(Math.min(window.innerHeight - h - 4, Math.max(4, r.bottom - h - 8)))}px`;
        el.style.bottom = 'auto';
    }

    private render() {
        const el = this.el;
        if (!el) return;
        const it = this.current;
        (el.querySelector('.similar-review__title') as HTMLElement).textContent = `Similar to ${this.title}`;
        (el.querySelector('.similar-review__pos') as HTMLElement).textContent = it ? `${this.pos + 1} / ${this.items.length}` : '0';
        (el.querySelector('.similar-review__score') as HTMLElement).textContent = it ? `score ${it.score.toFixed(2)}` : '';
        (el.querySelector('output') as HTMLOutputElement).textContent = this.threshold.toFixed(2);
        const n = this.aboveThreshold().length, all = el.querySelector('[data-act="all"]') as HTMLButtonElement;
        all.textContent = `Copy ${n}`;
        all.title = `Copy the ${n} suggestion${n === 1 ? '' : 's'} with score ≥ ${this.threshold.toFixed(2)} (Shift+Enter)`;
        all.disabled = !n;
        this.place();   // after the text: its height decides the top
    }
}
