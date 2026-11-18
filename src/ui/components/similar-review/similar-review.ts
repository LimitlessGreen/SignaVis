// similar-review.ts — review bar for "find similar calls" suggestions
//
// One suggestion at a time, best first: the host shows and plays it (onFocus).
//   Enter        copy into my labels       X / Delete   reject (not proposed again)
//   Shift+Enter  copy all at or above the threshold
//   ↓ / ↑        next / previous           Space        play again
//   Esc          close (suggestions stay visible; ✓ on a box still copies it)
// The suggestion on screen is highlighted and resizable by the host (fine corrections before copying);
// clicking another suggestion's box makes it the one under review (focusId).
// Keys are taken in the capture phase on window while the bar is open, ahead of the player's
// own shortcuts on document (X would delete the selected label: the one under review is unlocked).

export interface ReviewItem { id: string; score: number }
export interface SimilarReviewHandlers {
    onFocus: (id: string) => void;
    onPlay: (id: string) => void;
    onAccept: (ids: string[]) => void;
    onReject: (ids: string[]) => void;
    onClose?: () => void;
    /** True while the host is in the middle of something that owns Escape (e.g. resizing a box). */
    busy?: () => boolean;
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
            document.body.classList.add('similar-reviewing');
            window.addEventListener('keydown', this.onKey, true);
            window.addEventListener('resize', this.onResize);
        }
        this.render();
        this.focusCurrent();
        // The new 'Similar calls' track shrinks the spectrogram after this frame: place again
        requestAnimationFrame(() => requestAnimationFrame(() => this.place()));
    }

    close() {
        if (!this.el) return;
        window.removeEventListener('keydown', this.onKey, true);
        window.removeEventListener('resize', this.onResize);
        this.el.remove();
        this.el = null;
        document.body.classList.remove('similar-reviewing');
        this.h.onClose?.();
    }

    /** The item under review (null when closed or empty). */
    get currentId(): string | null { return this.el ? this.current?.id ?? null : null; }
    /** `id` is one of the suggestions of this review. */
    has(id: string): boolean { return !!this.el && this.items.some((i) => i.id === id); }

    /**
     * Drop items that no longer exist (removed elsewhere), keeping the position.
     * `decided`: they went by a decision on the box (✓ / ✗): a re-rank may move on to the new best.
     */
    retain(ids: Set<string>, { decided = false } = {}) {
        const cur = this.items[this.pos]?.id;
        // Only a decision on the one under review moves on; a clicked (pinned) one stays otherwise
        if (decided && !(cur && ids.has(cur))) this.fresh = true;
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

    /** The user picked a suggestion elsewhere (click on its box): review it now. */
    focusId(id: string): boolean {
        if (!this.el) return false;
        const at = this.items.findIndex((i) => i.id === id);
        if (at < 0) return false;
        this.fresh = false;   // like ↑/↓: a re-rank keeps it on screen (also when it is already the current one)
        if (at === this.pos) return true;
        this.pos = at;
        this.render();
        this.focusCurrent();
        return true;
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
        // A modal dialog (e.g. Replace / Keep) or the host's own interaction (resizing) keeps its keys
        if (this.h.busy?.()) return;
        // (closed app modals stay in the DOM, hidden: only a visible one counts)
        const shown = (m: Element) => !this.el?.contains(m) && ((m as any).checkVisibility ? (m as any).checkVisibility() : (m as HTMLElement).offsetParent !== null);
        if ([...document.querySelectorAll('[aria-modal="true"], dialog[open]')].some(shown)) return;
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
            <span class="similar-review__pager" role="group" aria-label="Suggestions">
                <button type="button" class="similar-review__step" data-act="prev" title="Previous (↑)" aria-label="Previous"><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m18 15-6-6-6 6"/></svg></button>
                <span class="similar-review__pos"></span>
                <button type="button" class="similar-review__step" data-act="next" title="Next (↓)" aria-label="Next"><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg></button>
            </span>
            <span class="similar-review__score"></span>
            <button type="button" class="similar-review__play" data-act="play" title="Play (Space)" aria-label="Play"><svg viewBox="0 0 24 24" width="12" height="12" fill="currentColor" aria-hidden="true"><path d="M7 4.5v15a1 1 0 0 0 1.5.86l12.5-7.5a1 1 0 0 0 0-1.72L8.5 3.64A1 1 0 0 0 7 4.5Z"/></svg></button>
            <button type="button" class="similar-review__btn similar-review__btn--no" data-act="reject" title="Reject: not proposed again (X)">✗ Reject <kbd>X</kbd></button>
            <button type="button" class="similar-review__btn similar-review__btn--ok" data-act="accept" title="Copy into my labels (Enter)">✓ Copy <kbd>Enter</kbd></button>
            <span class="similar-review__bulk" role="group" aria-label="Copy all from a score">
                <label class="similar-review__thr" title="Lowest score for “Copy all”">
                    Score ≥ <input type="range" min="0.2" max="1" step="0.01"> <output></output>
                </label>
                <button type="button" class="similar-review__btn similar-review__btn--bulk" data-act="all"></button>
            </span>
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
        const it = this.current;
        (el.querySelector('.similar-review__title') as HTMLElement).textContent = `Similar to ${this.title}`;
        (el.querySelector('.similar-review__pos') as HTMLElement).textContent = it ? `${this.pos + 1} / ${this.items.length}` : '0';
        (el.querySelector('.similar-review__score') as HTMLElement).textContent = it ? `score ${it.score.toFixed(2)}` : '';
        (el.querySelector('output') as HTMLOutputElement).textContent = this.threshold.toFixed(2);
        const n = this.aboveThreshold().length, all = el.querySelector('[data-act="all"]') as HTMLButtonElement;
        all.textContent = `Copy all ${n}`;
        all.title = `Copy the ${n} suggestion${n === 1 ? '' : 's'} with score ≥ ${this.threshold.toFixed(2)} (Shift+Enter)`;
        all.disabled = !n;
        this.place();   // after the text: its height decides the top
    }
}
