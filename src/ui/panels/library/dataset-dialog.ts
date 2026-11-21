// ═══════════════════════════════════════════════════════════════════════
// ui/panels/library/dataset-dialog.ts — create or edit a dataset
//
// Dynamic: stores the library filter and follows the catalog.
// Static: a fixed list, optionally filled with what the library shows now.
// ═══════════════════════════════════════════════════════════════════════

import { normalizeFilter, type CatalogFilter, type DatasetInfo } from '../../../domain/catalog/catalog-types.ts';
import { catalogApi } from '../../../infrastructure/tauri/catalogApi.ts';

const esc = (s: unknown) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));
export const DATASET_COLORS = ['#ee8c3b', '#4cb5e8', '#9b7bf0', '#5cc98a', '#e8618c', '#d9c23f', '#3fc9c0', '#7f9cf5'];

export interface DatasetDialogOptions {
    projectRoot: string;
    /** Edit this one; absent = create. */
    dataset?: DatasetInfo;
    /** The library's filter now, and a readable summary of it. */
    filter: CatalogFilter;
    filterText: string;
    /** How many recordings the filter shows. */
    shown: number;
    /** Preselected kind when creating. */
    kind?: 'static' | 'filter';
    onDone: (id: number) => void;
}

export class DatasetDialog {
    el: HTMLElement;
    #o: DatasetDialogOptions;

    constructor(o: DatasetDialogOptions) {
        this.#o = o;
        const d = o.dataset;
        const color = d?.color ?? DATASET_COLORS[0];
        this.el = document.createElement('form');
        this.el.className = 'lib-ds-form';
        this.el.innerHTML = `
          <label class="lib-field"><span>Name</span><input class="input" data-k="name" required value="${esc(d?.name ?? '')}" placeholder="e.g. Site 2 nights March"></label>
          <label class="lib-field"><span>Description</span><textarea class="input" data-k="description" rows="2" placeholder="What it is for, how it was chosen">${esc(d?.description ?? '')}</textarea></label>
          <div class="lib-field"><span>Colour</span><div class="lib-ds-colors" role="radiogroup">
            ${DATASET_COLORS.map((c) => `<label style="--pill:${c}" title="${c}"><input type="radio" name="ds-color" value="${c}"${c === color ? ' checked' : ''}><span></span></label>`).join('')}
          </div></div>
          ${d ? `<p class="lib-hint">${d.kind === 'filter' ? 'Dynamic dataset: to change its filter, open it, change the filters and press “Save filter”.' : 'Static dataset: add or remove recordings in the selection panel on the right.'}</p>` : `
          <fieldset class="lib-ds-kind"><legend>Kind</legend>
            <label><input type="radio" name="ds-kind" value="filter"${o.kind !== 'static' ? ' checked' : ''}>
              <span><b>Dynamic</b> — saves the current filter. New imports and edits that match it appear automatically.
              <span class="lib-hint lib-break">Filter: ${esc(o.filterText || 'none (all recordings)')}</span></span></label>
            <label><input type="radio" name="ds-kind" value="static"${o.kind === 'static' ? ' checked' : ''}>
              <span><b>Static</b> — a fixed list that only changes when you add or remove recordings. Good for a training set or a set you report on.</span></label>
            <label class="lib-ds-fill"><input type="checkbox" data-k="fill" checked> <span>Start with the ${o.shown.toLocaleString()} recordings shown now</span></label>
          </fieldset>`}
          <div class="lib-row"><span class="lib-spacer"></span><span class="lib-hint lib-warn-text" data-k="err"></span>
            <button class="btn btn--sm" type="submit">${d ? 'Save' : 'Create dataset'}</button></div>`;
        const syncFill = () => {
            const fill = this.el.querySelector<HTMLElement>('.lib-ds-fill');
            if (fill) fill.hidden = this.#kind() !== 'static';
        };
        this.el.addEventListener('change', syncFill);
        syncFill();
        this.el.addEventListener('submit', (e) => { e.preventDefault(); void this.#submit(); });
        queueMicrotask(() => this.el.querySelector<HTMLInputElement>('[data-k="name"]')?.focus());
    }

    #kind(): 'static' | 'filter' {
        return (this.el.querySelector<HTMLInputElement>('input[name="ds-kind"]:checked')?.value as 'static' | 'filter') ?? 'filter';
    }

    async #submit() {
        const o = this.#o;
        const val = (k: string) => this.el.querySelector<HTMLInputElement>(`[data-k="${k}"]`)?.value ?? '';
        const edit = {
            name: val('name').trim(),
            description: val('description').trim() || null,
            color: this.el.querySelector<HTMLInputElement>('input[name="ds-color"]:checked')?.value ?? null,
        };
        const err = this.el.querySelector<HTMLElement>('[data-k="err"]')!;
        const btn = this.el.querySelector<HTMLButtonElement>('button[type="submit"]')!;
        if (!edit.name) { err.textContent = 'Please give it a name.'; return; }
        btn.disabled = true;
        err.textContent = '';
        try {
            if (o.dataset) {
                await catalogApi.updateDataset(o.projectRoot, o.dataset.id, edit);
                o.onDone(o.dataset.id);
            } else {
                const kind = this.#kind();
                const id = await catalogApi.createDataset(o.projectRoot, kind, kind === 'filter' ? { ...edit, filter: normalizeFilter(o.filter) } : edit);
                if (kind === 'static' && this.el.querySelector<HTMLInputElement>('[data-k="fill"]')?.checked && o.shown) {
                    await catalogApi.datasetAdd(o.projectRoot, id, { filter: o.filter });
                }
                o.onDone(id);
            }
        } catch (e) {
            err.textContent = String(e);
            btn.disabled = false;
        }
    }
}
