// ═══════════════════════════════════════════════════════════════════════
// ui/panels/library/view-list.ts — panel "View" in the Annotate space (Lite)
//
// The current view (shared filter) as a list with review state new / open /
// done, so labeling goes through it one recording after the other: click a
// row to open it, N / P (or the buttons) for next / previous, D marks the open
// recording done and moves on. "To do" / "Done" narrow the view by state.
// ═══════════════════════════════════════════════════════════════════════

import type { CatalogRow, ReviewFilter } from '../../../domain/catalog/catalog-types.ts';
import type { CatalogView, ViewChange } from '../../../domain/catalog/catalog-view.ts';

const esc = (s: unknown) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));
const ROW_H = 40;

/** Second line of a row: site · local start · labels (only what is known). */
export function rowSub(r: Pick<CatalogRow, 'site' | 'startMs' | 'localOffsetMin' | 'labels'>): string {
    const time = r.startMs != null ? new Date(r.startMs + (r.localOffsetMin ?? 0) * 60_000).toISOString().slice(5, 16).replace('T', ' ') : null;
    const labels = r.labels ? `${r.labels} label${r.labels === 1 ? '' : 's'}` : null;
    return [r.site, time, labels].filter(Boolean).join(' · ') || 'no site, no start time';
}
/** Load the next page when fewer rows than this are left below the visible ones. */
const PREFETCH = 30;

export interface ViewListOptions {
    /** Open row i of the view in the editor (and make it current). */
    open: (i: number) => Promise<void>;
    /** Store the review state of recordings (true: done, false: back to open). */
    setDone: (ids: number[], done: boolean) => Promise<void>;
    /** Catalog id of the recording confirmed open in the editor (null: none, or one opened from Files). */
    openId: () => number | null;
}

export function reviewText(r: Pick<CatalogRow, 'review'>): 'new' | 'open' | 'done' {
    return r.review ?? 'new';
}

/** "1 234 / 3 481" for the current row (1-based), "– / 3 481" without one. */
export function positionText(current: number, total: number): string {
    return `${current >= 0 ? (current + 1).toLocaleString() : '–'} / ${total.toLocaleString()}`;
}

export class ViewList {
    readonly el: HTMLElement;
    #v: CatalogView;
    #o: ViewListOptions;
    #unsubscribe: () => void;
    #busy = false;

    constructor(view: CatalogView, o: ViewListOptions) {
        this.#v = view;
        this.#o = o;
        this.el = document.createElement('div');
        this.el.className = 'view-list';
        this.el.innerHTML = `
          <div class="vl-head">
            <span class="lib-seg" role="group" aria-label="Review state">
              <button type="button" data-review="">All</button><button type="button" data-review="todo" title="Not done yet">To do</button><button type="button" data-review="done">Done</button>
            </span>
            <span class="vl-pos" title="Open recording in the view"></span>
          </div>
          <div class="vl-progress" title="Recordings of the view marked done"><span class="vl-bar"><span></span></span><span class="vl-progress-text"></span></div>
          <div class="vl-list" tabindex="0" aria-label="Recordings of the view"><div class="vl-spacer"></div><div class="vl-rows" role="list"></div></div>
          <div class="vl-foot">
            <button type="button" class="btn btn--sm btn--ghost" data-act="prev" title="Previous recording of the view (P)">‹ Prev</button>
            <button type="button" class="btn btn--sm btn--ghost" data-act="next" title="Next recording of the view (N)">Next ›</button>
            <button type="button" class="btn btn--sm vl-done" data-act="done" title="Mark the open recording done and go to the next (D)">Mark done ✓</button>
          </div>`;
        this.el.addEventListener('click', (e) => this.#onClick(e));
        this.#q('.vl-list').addEventListener('scroll', () => this.#renderRows(), { passive: true });
        new ResizeObserver(() => this.#renderRows()).observe(this.el);
        this.#unsubscribe = view.subscribe((c) => this.#onView(c));
        this.render();
    }

    dispose() { this.#unsubscribe(); this.el.remove(); }

    #q<T extends HTMLElement = HTMLElement>(sel: string): T { return this.el.querySelector<T>(sel)!; }

    /** Last page-load error (shown until the next successful render of rows). */
    #loadError: string | null = null;

    #onView(c: ViewChange) {
        if (c === 'loading') { this.el.classList.add('is-loading'); return; }
        if (c === 'ready') this.el.classList.remove('is-loading');
        const openId = this.#o.openId();
        if ((c === 'rows' || c === 'ready') && this.#v.current < 0 && openId != null) {
            // The open recording is found again after the view reloads (filter change).
            const i = this.#v.rows.findIndex((r) => r.id === openId);
            if (i >= 0) { this.#v.setCurrent(i); return; }   // emits 'selection', which renders
        }
        if (c === 'selection') this.#reveal(this.#v.current);
        this.render();
    }

    render() {
        const v = this.#v;
        const f = v.facets;
        const review = v.filter.review ?? '';
        this.el.querySelectorAll<HTMLElement>('[data-review]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.review === review)));
        this.#q('.vl-pos').textContent = positionText(v.current, v.total);
        const done = f?.reviewDone ?? 0;
        const total = v.total;
        this.#q('.vl-bar > span').style.width = `${total ? Math.min(100, (done / total) * 100) : 0}%`;
        this.#q('.vl-progress-text').textContent = v.error ? v.error
            : this.#loadError ? `Could not load more: ${this.#loadError} (scroll or click to retry)`
            : `done ${done.toLocaleString()} / ${total.toLocaleString()}${f?.reviewOpen ? ` · opened ${f.reviewOpen.toLocaleString()}` : ''}`;
        const cur = this.#openRow();
        const doneBtn = this.#q<HTMLButtonElement>('.vl-done');
        doneBtn.disabled = !cur;
        doneBtn.textContent = cur?.review === 'done' ? 'Done ✓ — undo' : 'Mark done ✓';
        doneBtn.classList.toggle('is-done', cur?.review === 'done');
        this.#q<HTMLButtonElement>('[data-act="prev"]').disabled = v.current <= 0;
        this.#q<HTMLButtonElement>('[data-act="next"]').disabled = v.current >= total - 1;
        this.#renderRows();
    }

    #renderRows() {
        const v = this.#v;
        const list = this.#q('.vl-list');
        const total = v.total;
        this.#q('.vl-spacer').style.height = `${total * ROW_H}px`;
        const first = Math.max(0, Math.floor(list.scrollTop / ROW_H) - 5);
        const last = Math.min(total - 1, Math.ceil((list.scrollTop + list.clientHeight) / ROW_H) + 5);
        if (last >= v.rows.length - PREFETCH && v.hasMore) {
            v.loadMore().then(() => { if (this.#loadError) { this.#loadError = null; this.render(); } }, (e) => this.#failed(e));
        }
        const html: string[] = [];
        for (let i = first; i <= last; i++) {
            const r = v.rows[i];
            const top = `style="transform:translateY(${i * ROW_H}px)"`;
            if (!r) { html.push(`<div class="vl-r is-pending" ${top}></div>`); continue; }
            const name = (r.path ?? `#${r.id}`).split(/[\\/]/).pop();
            const state = reviewText(r);
            html.push(`<button type="button" class="vl-r${i === v.current ? ' is-cur' : ''}" role="listitem" data-i="${i}" ${top} title="${esc(r.path ?? '')}">
              <span class="vl-name">${esc(name)}</span>
              <span class="vl-sub">${esc(rowSub(r))}</span>
              <span class="vl-state vl-state--${state}">${state}</span></button>`);
        }
        // Keyboard focus on a row survives the redraw (the rows are rebuilt).
        const focused = (document.activeElement as HTMLElement | null)?.closest?.<HTMLElement>('.vl-r[data-i]');
        const keep = focused && this.el.contains(focused) ? focused.dataset.i : null;
        this.#q('.vl-rows').innerHTML = html.join('');
        if (keep != null) this.#q('.vl-rows').querySelector<HTMLElement>(`.vl-r[data-i="${keep}"]`)?.focus({ preventScroll: true });
    }

    #failed(e: unknown) {
        this.#loadError = e instanceof Error ? e.message : String(e);
        this.render();
    }

    /** The view row of the recording open in the editor (null: none of the view's loaded rows). */
    #openRow(): CatalogRow | null {
        const id = this.#o.openId();
        return id == null ? null : this.#v.rows.find((r) => r.id === id) ?? null;
    }

    #reveal(i: number) {
        if (i < 0) return;
        const list = this.#q('.vl-list');
        const top = i * ROW_H;
        if (top < list.scrollTop) list.scrollTop = top;
        else if (top + ROW_H > list.scrollTop + list.clientHeight) list.scrollTop = top + ROW_H - list.clientHeight;
    }

    #onClick(e: Event) {
        const t = e.target as HTMLElement;
        const seg = t.closest<HTMLElement>('[data-review]');
        if (seg) {
            const r = (seg.dataset.review || null) as ReviewFilter | null;
            if ((this.#v.filter.review ?? null) !== r) void this.#v.updateFilter((f) => { f.review = r; });
            return;
        }
        const row = t.closest<HTMLElement>('.vl-r[data-i]');
        if (row) { void this.#go(Number(row.dataset.i)); return; }
        const act = t.closest<HTMLElement>('[data-act]')?.dataset.act;
        if (act === 'next') void this.next();
        else if (act === 'prev') void this.prev();
        else if (act === 'done') void this.toggleDone();
    }

    async #go(i: number) {
        if (this.#busy || i < 0 || i >= this.#v.total) return;
        this.#busy = true;
        try {
            const row = await this.#v.rowAt(i);
            if (!row) return;
            await this.#o.open(i);
        } catch (e) { this.#failed(e); } finally { this.#busy = false; }
    }

    /** Whether N / P / D should go to this list: a recording of the view is open in the editor. */
    get active(): boolean { return this.#openRow() != null; }

    next(): Promise<void> { return this.#go(this.#v.current + 1); }
    prev(): Promise<void> { return this.#go(this.#v.current - 1); }

    /** Mark the open recording done and go on to the next; on a done one: back to open (undo). */
    async toggleDone() {
        if (this.#busy) return;
        const r = this.#openRow();   // the recording in the editor, not just the list cursor
        if (!r) return;
        const done = r.review !== 'done';
        this.#busy = true;   // N / P / clicks wait until the state is stored
        try { await this.#o.setDone([r.id], done); } catch (e) { this.#failed(e); return; } finally { this.#busy = false; }
        if (done) await this.#go(this.#v.rows.indexOf(r) + 1);
    }
}
