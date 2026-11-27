// ═══════════════════════════════════════════════════════════════════════
// ui/panels/library/view-bar.ts — the active view above all spaces (Lite)
//
// "View: Site S3 × · Time 18–06 h × · + Filter     3 481 of 102 633 ·
// 7 selected × · Save as dataset". The same view (filter, dataset,
// selection) applies in every space and panel; this bar shows it and
// removes parts of it. Hidden while the project has no catalog.
// ═══════════════════════════════════════════════════════════════════════

import { Filter, Save } from 'lucide-static';
import type { CatalogView, ViewChange } from '../../../domain/catalog/catalog-view.ts';
import { viewChips, type ChipKind } from '../../../domain/catalog/view-chips.ts';
import { valueColor } from './library-view.ts';

const esc = (s: unknown) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));

export interface ViewBarOptions {
    /** "+ Filter": show the fields (Browse). */
    onAddFilter: () => void;
    /** "Save as dataset": the dataset dialog; the host reads filter and picks from the shared view (picks win, saved as a static dataset). */
    onSaveDataset: () => void;
    /** Readable name of a detection class (chip "Detected …"). */
    className?: (cls: string) => string;
}

export class ViewBar {
    readonly el: HTMLElement;
    #v: CatalogView;
    #o: ViewBarOptions;
    #unsubscribe: () => void;

    constructor(view: CatalogView, o: ViewBarOptions) {
        this.#v = view;
        this.#o = o;
        this.el = document.createElement('div');
        this.el.className = 'view-bar';
        this.el.setAttribute('role', 'toolbar');
        this.el.setAttribute('aria-label', 'Current view');
        this.el.innerHTML = `
          <span class="view-bar-title">${Filter}<span>View</span></span>
          <div class="view-bar-chips"></div>
          <span class="view-bar-count" aria-live="polite"></span>
          <button type="button" class="btn btn--sm view-bar-save" data-act="save">${Save}<span>Save as dataset</span></button>`;
        this.el.addEventListener('click', (e) => {
            const b = (e.target as HTMLElement).closest<HTMLElement>('[data-act]');
            if (!b) return;
            const act = b.dataset.act;
            if (act === 'chip-clear') {
                const chip = b.closest<HTMLElement>('[data-k]')!;
                void this.#v.clearChip(chip.dataset.k as ChipKind | 'all', chip.dataset.id != null ? Number(chip.dataset.id) : null);
            } else if (act === 'add') o.onAddFilter();
            else if (act === 'save') o.onSaveDataset();
            else if (act === 'pick-none') this.#v.selectNone();
        });
        this.#unsubscribe = view.subscribe((c) => this.#onView(c));
        this.render();
    }

    dispose() { this.#unsubscribe(); this.el.remove(); }

    #onView(c: ViewChange) {
        if (c === 'query' || c === 'selection') this.render();
        else if (c === 'loading' || c === 'ready') this.el.classList.toggle('is-loading', this.#v.loading);
    }

    render() {
        const v = this.#v;
        const chips = viewChips(v.filter, v.facets, v.datasets, valueColor, this.#o.className);
        // No catalog yet (nothing imported) and nothing filtered: no bar.
        this.el.hidden = !chips.length && (v.allTotal ?? 0) === 0 && !v.error;
        this.el.querySelector('.view-bar-chips')!.innerHTML =
            chips.map((c) => `<span class="lib-chip view-chip" data-k="${c.kind}"${c.id != null ? ` data-id="${c.id}"` : ''}${c.color ? ` style="--pill:${c.color}"` : ''}>
                <span class="view-chip-field">${esc(c.field)}</span>${esc(c.label)}
                <button type="button" data-act="chip-clear" title="Remove this filter" aria-label="Remove ${esc(c.field)} ${esc(c.label)}">×</button></span>`).join('')
            + (chips.length > 1 ? '<span data-k="all"><button type="button" class="lib-chip lib-chip--reset" data-act="chip-clear">Reset</button></span>' : '')
            + '<button type="button" class="view-bar-add" data-act="add" title="Filter by the fields (Browse)">+ Filter</button>';
        const shown = v.facets?.total;
        const count = this.el.querySelector<HTMLElement>('.view-bar-count')!;
        const picked = v.pickedCount;
        count.innerHTML = v.error ? `<span class="lib-warn">${esc(v.error)}</span>`
            : `${shown != null ? `<b>${shown.toLocaleString()}</b>` : '…'}${v.allTotal != null && v.allTotal !== shown ? ` of ${v.allTotal.toLocaleString()}` : ' recordings'}`
              + (picked ? ` <span class="view-bar-picked">${picked.toLocaleString()} selected<button type="button" data-act="pick-none" title="Clear the selection" aria-label="Clear the selection">×</button></span>` : '');
    }
}
