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
    /** Box | Time only for drawn labels. */
    timeOnly?: { get: () => boolean; set: (on: boolean) => void };
}

/** Choices of the display preset select (skips separators); `current` is the selected value ('' = Custom). */
export function presetChoices(sel: Pick<HTMLSelectElement, 'options' | 'value'>): { value: string; label: string; current: boolean }[] {
    return Array.from(sel.options).filter((o) => !o.disabled)
        .map((o) => ({ value: o.value, label: (o.textContent || o.value).trim(), current: o.value === sel.value }));
}

/** Button text of the quick choice: the selected preset's name, "Custom" when none fits. */
export function presetButtonText(sel: Pick<HTMLSelectElement, 'options' | 'value'>): string {
    const c = presetChoices(sel).find((x) => x.current);
    return !c || c.value === '' ? 'Custom' : c.label.replace(/^⭐ /, '');
}

const ICON_DONE = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg>';

const ICON_BOX = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><rect x="4" y="6" width="16" height="12" rx="1.5"/></svg>';
const ICON_PIN = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M7 4v16M17 4v16M7 12h10"/></svg>';

/** "Display: <preset> ▾" in the editor head: picks a preset of the Display panel's select. */
export class DisplayPresetButton {
    readonly el: HTMLButtonElement;
    #sel: () => HTMLSelectElement | null;

    constructor(sel: () => HTMLSelectElement | null, openMenu: (at: { x: number; y: number }, items: { label: string; action: () => void }[]) => void) {
        this.#sel = sel;
        this.el = document.createElement('button');
        this.el.type = 'button';
        this.el.className = 'display-preset-btn';
        this.el.title = 'Display preset (Display panel has all settings)';
        this.el.addEventListener('click', () => {
            const s = this.#sel();
            if (!s) return;
            const r = this.el.getBoundingClientRect();
            openMenu({ x: r.left, y: r.bottom + 2 }, presetChoices(s).filter((c) => c.value !== '').map((c) => ({
                // One of several: a check mark, not the menu's on/off switch
                label: `${c.current ? '✓' : '\u2003'}\u2002${c.label}`,
                action: () => { s.value = c.value; s.dispatchEvent(new Event('change', { bubbles: true })); this.refresh(); },
            })));
        });
        this.refresh();
    }

    /** Re-read the select (a setting changed in the Display panel may make it "Custom"). */
    refresh() {
        const s = this.#sel();
        this.el.hidden = !s;
        this.el.innerHTML = `<span class="dpb-cap">Display:</span> <strong>${s ? escHtml(presetButtonText(s)) : ''}</strong> ▾`;
    }
}

const escHtml = (t: string) => t.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));

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

    constructor(o: Pick<EditorChromeOptions, 'toggleDone' | 'timeOnly'>) {
        this.el = document.createElement('div');
        this.el.className = 'editor-labelbar';
        this.el.innerHTML = `
          <span class="elb-caption">New labels</span>
          <span class="elb-template"></span>
          <span class="elb-mode" role="radiogroup" aria-label="Shape of drawn labels"${o.timeOnly ? '' : ' hidden'}>
            <button type="button" class="elb-seg" data-mode="box" role="radio" title="Drawn labels are boxes (time and frequency)">${ICON_BOX}<span>Box</span></button>
            <button type="button" class="elb-seg" data-mode="time" role="radio" title="Drawn labels are time spans over the whole band (frequency is ignored)">${ICON_PIN}<span>Time only</span></button>
          </span>
          <span class="elb-tools"></span>
          <span class="elb-spacer"></span>
          <button type="button" class="btn btn--sm elb-done" title="Mark the open recording done and go to the next of the view (D)" hidden>${ICON_DONE}<span>Mark done</span><kbd>D</kbd></button>`;
        this.templateSlot = this.el.querySelector('.elb-template')!;
        this.toolsSlot = this.el.querySelector('.elb-tools')!;
        this.#done = this.el.querySelector('.elb-done')!;
        this.#done.addEventListener('click', () => o.toggleDone());
        const t = o.timeOnly;
        if (t) {
            const sync = () => {
                for (const b of this.el.querySelectorAll<HTMLButtonElement>('.elb-seg')) {
                    const on = (b.dataset.mode === 'time') === t.get();
                    b.classList.toggle('is-on', on);
                    b.setAttribute('aria-checked', String(on));
                }
            };
            this.el.querySelector('.elb-mode')!.addEventListener('click', (e) => {
                const b = (e.target as Element).closest<HTMLButtonElement>('.elb-seg');
                if (!b) return;
                t.set(b.dataset.mode === 'time');
                sync();
            });
            sync();
        }
    }

    /** Mark done follows the open recording's row of the view (hidden without one). */
    setPlace({ row }: EditorPlace) {
        this.#done.hidden = !row;
        const done = row?.review === 'done';
        this.#done.classList.toggle('is-done', done);
        this.#done.querySelector('span')!.textContent = done ? 'Done — undo' : 'Mark done';
    }
}
