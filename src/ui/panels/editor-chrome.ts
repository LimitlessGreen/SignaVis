// ═══════════════════════════════════════════════════════════════════════
// ui/panels/editor-chrome.ts — head and label bar of the Editor panel (Lite)
//
// Annotate v2 (lab mockup B6): above the player a head line with the open
// recording (file, site, recorder, local start, length), its review state and
// its place in the current view (‹ 128 / 3 481 ›); below the player the label
// bar: the template for new labels (species + tags), the label tools (Snap,
// Stamp) and Mark done. Only built in Lite with spaces; web and phone keep
// the template in the top bar and the tools in the player toolbar.
// ═══════════════════════════════════════════════════════════════════════

import type { CatalogRow } from '../../domain/catalog/catalog-types.ts';
import { positionText, reviewText } from './library/view-list.ts';

/** "1:00", "30:00", "1:02:03" for a length in seconds. */
export function durationText(s: number): string {
    const t = Math.max(0, Math.round(s));
    const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), sec = t % 60;
    const mm = h ? String(m).padStart(2, '0') : String(m);
    return `${h ? `${h}:` : ''}${mm}:${String(sec).padStart(2, '0')}`;
}

/** Second part of the head: site · recorder · local start · length (only what is known). */
export function headMeta(r: Pick<CatalogRow, 'site' | 'device' | 'startMs' | 'localOffsetMin' | 'durationS'>): string {
    const start = r.startMs != null
        ? new Date(r.startMs + (r.localOffsetMin ?? 0) * 60_000).toISOString().slice(0, 16).replace('T', ' ')
        : null;
    return [r.site, r.device, start, r.durationS ? durationText(r.durationS) : null].filter(Boolean).join(' · ');
}

/** Last part of a path (either separator). */
export function baseName(path: string | null | undefined): string {
    return String(path ?? '').split(/[\\/]/).pop() ?? '';
}

/**
 * The catalog row that belongs to the open recording: the view's current row, but only when its file
 * is the one in the editor (a recording opened from Files or a link is not the view's current one).
 */
export function rowOfOpen(row: CatalogRow | null | undefined, openName: string): CatalogRow | null {
    if (!row || !openName) return null;
    return baseName(row.path) === openName ? row : null;
}

export interface EditorPlace {
    /** The open recording's row of the view (null: not in the view / no catalog). */
    row: CatalogRow | null;
    /** Index of that row in the view, -1 without one. */
    index: number;
    total: number;
}

export interface EditorChromeOptions {
    prev: () => void;
    next: () => void;
    toggleDone: () => void;
}

const ICON_DONE = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg>';

export class EditorHead {
    readonly el: HTMLElement;
    #name: HTMLElement;
    #meta: HTMLElement;
    #state: HTMLElement;
    #pos: HTMLElement;
    #prev: HTMLButtonElement;
    #next: HTMLButtonElement;

    constructor(o: Pick<EditorChromeOptions, 'prev' | 'next'>) {
        this.el = document.createElement('div');
        this.el.className = 'editor-head';
        this.el.innerHTML = `
          <span class="eh-name"></span>
          <span class="eh-meta"></span>
          <span class="eh-spacer"></span>
          <span class="eh-state" hidden></span>
          <span class="eh-nav" hidden>
            <button type="button" class="eh-btn" data-act="prev" title="Previous recording of the view (P)" aria-label="Previous recording">‹</button>
            <span class="eh-pos" title="Place of the open recording in the view"></span>
            <button type="button" class="eh-btn" data-act="next" title="Next recording of the view (N)" aria-label="Next recording">›</button>
          </span>`;
        this.#name = this.el.querySelector('.eh-name')!;
        this.#meta = this.el.querySelector('.eh-meta')!;
        this.#state = this.el.querySelector('.eh-state')!;
        this.#pos = this.el.querySelector('.eh-pos')!;
        this.#prev = this.el.querySelector('[data-act="prev"]')!;
        this.#next = this.el.querySelector('[data-act="next"]')!;
        this.#prev.addEventListener('click', () => o.prev());
        this.#next.addEventListener('click', () => o.next());
    }

    /** Open recording's name (empty: none loaded). */
    setName(name: string) {
        this.#name.textContent = name || 'No recording open';
        this.#name.title = name;
        this.el.classList.toggle('is-empty', !name);
    }

    setPlace({ row, index, total }: EditorPlace, inView: boolean) {
        this.#meta.textContent = row ? headMeta(row) : '';
        const state = row ? reviewText(row) : null;
        this.#state.hidden = !state;
        this.#state.textContent = state ?? '';
        this.#state.className = `eh-state${state ? ` vl-state vl-state--${state}` : ''}`;
        // Position and ‹ › only when there is a view to walk through.
        this.el.querySelector<HTMLElement>('.eh-nav')!.hidden = !inView;
        this.#pos.textContent = positionText(row ? index : -1, total);
        this.#prev.disabled = !row || index <= 0;
        this.#next.disabled = !row || index >= total - 1;
    }
}

export class EditorLabelBar {
    readonly el: HTMLElement;
    /** Where the label template (species search + tags) goes. */
    readonly templateSlot: HTMLElement;
    /** Where the label tools (Snap, Stamp) go. */
    readonly toolsSlot: HTMLElement;
    #done: HTMLButtonElement;

    constructor(o: Pick<EditorChromeOptions, 'toggleDone'>) {
        this.el = document.createElement('div');
        this.el.className = 'editor-labelbar';
        this.el.innerHTML = `
          <span class="elb-caption">New labels</span>
          <span class="elb-template"></span>
          <span class="elb-tools"></span>
          <span class="elb-spacer"></span>
          <button type="button" class="btn btn--sm elb-done" title="Mark the open recording done and go to the next of the view (D)" hidden>${ICON_DONE}<span>Mark done</span><kbd>D</kbd></button>`;
        this.templateSlot = this.el.querySelector('.elb-template')!;
        this.toolsSlot = this.el.querySelector('.elb-tools')!;
        this.#done = this.el.querySelector('.elb-done')!;
        this.#done.addEventListener('click', () => o.toggleDone());
    }

    /** Mark done follows the open recording's row of the view (hidden without one). */
    setPlace({ row }: EditorPlace) {
        this.#done.hidden = !row;
        const done = row?.review === 'done';
        this.#done.classList.toggle('is-done', done);
        this.#done.querySelector('span')!.textContent = done ? 'Done — undo' : 'Mark done';
    }
}
