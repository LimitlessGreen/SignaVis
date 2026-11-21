// ═══════════════════════════════════════════════════════════════════════
// ui/panels/library/selection-panel.ts — right side of the library
//
// One recording picked: its metadata (origin of each value), tags, hashes.
// Several picked, or "all filtered": bulk edit — site, recorder, tags,
// metadata. Changing the recorder recomputes times with its clock.
// ═══════════════════════════════════════════════════════════════════════

import {
    bulkReportText, type BulkEdit, type FacetValue, type RecordingDetail, type Selection,
} from '../../../domain/catalog/catalog-types.ts';
import { catalogApi } from '../../../infrastructure/tauri/catalogApi.ts';

const esc = (s: unknown) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));
const KEEP = '__keep', CLEAR = '__clear';

export interface SelectionPanelOptions {
    projectRoot: string;
    /** After a bulk edit: reload list and facets. */
    onApplied: () => void;
}

export class SelectionPanel {
    el: HTMLElement;
    #o: SelectionPanelOptions;
    #sel: Selection = {};
    #count = 0;
    #sites: FacetValue[] = [];
    #devices: FacetValue[] = [];
    #tags: string[] = [];
    #keys: string[] = [];
    #detail: RecordingDetail | null = null;
    #gen = 0;

    constructor(o: SelectionPanelOptions) {
        this.#o = o;
        this.el = document.createElement('aside');
        this.el.className = 'lib-side';
        this.el.addEventListener('click', (e) => void this.#onClick(e));
        this.#render();
    }

    /** What is picked; `count` is how many recordings that is. Lists for the pickers come from the library. */
    async show(sel: Selection, count: number, lists: { sites: FacetValue[]; devices: FacetValue[] }) {
        const gen = ++this.#gen;
        this.#sel = sel;
        this.#count = count;
        this.#sites = lists.sites;
        this.#devices = lists.devices;
        this.#detail = null;
        this.#render();   // at once, with the lists the library already has
        try {
            const [tags, keys, detail] = await Promise.all([
                catalogApi.tags(this.#o.projectRoot),
                catalogApi.metaKeys(this.#o.projectRoot),
                sel.ids?.length === 1 ? catalogApi.recordingDetail(this.#o.projectRoot, sel.ids[0]) : Promise.resolve(null),
            ]);
            if (gen !== this.#gen) return;
            this.#tags = tags.map((t) => t.name);
            this.#keys = keys.map(([k]) => k);
            this.#detail = detail;
        } catch { /* lists stay empty */ }
        this.#render();
    }

    /** Identity of the current selection: form input survives re-renders while it stays the same. */
    #key(): string { return `${this.#count}:${this.#sel.ids?.join(',') ?? 'filter'}`; }
    #renderedKey = '';

    #render() {
        const keep = new Map<string, string>();
        if (this.#renderedKey === this.#key()) {
            this.el.querySelectorAll<HTMLInputElement | HTMLSelectElement>('.lib-field [data-k]').forEach((f) => keep.set(f.dataset.k!, f.value));
        }
        this.#renderedKey = this.#key();
        this.#renderBody();
        for (const [k, v] of keep) {
            const f = this.el.querySelector<HTMLInputElement | HTMLSelectElement>(`.lib-field [data-k="${k}"]`);
            // A select keeps its default when the old choice is gone (e.g. a deleted tag).
            if (!f || (f instanceof HTMLSelectElement && ![...f.options].some((o) => o.value === v))) continue;
            f.value = v;
        }
    }

    #renderBody() {
        const n = this.#count;
        if (!n) {
            this.el.innerHTML = `<h4>Selection</h4><p class="lib-hint">Click a recording; Ctrl+click or Shift+click picks several.
              Or edit all recordings the filter shows.</p>
              <button class="btn btn--sm btn--ghost" data-act="pick-all">Edit all filtered…</button>`;
            return;
        }
        const d = this.#detail;
        const what = this.#sel.ids ? `${n.toLocaleString()} picked` : `all ${n.toLocaleString()} filtered`;
        const opt = (vals: FacetValue[]) => vals.map((v) => `<option value="${v.id}">${esc(v.name)}</option>`).join('');
        this.el.innerHTML = `
          <h4>${d ? 'Recording' : what} ${this.#sel.ids ? '<button class="btn btn--sm btn--ghost" data-act="pick-none" title="Clear the selection">✕</button>' : ''}</h4>
          ${d ? `<div class="lib-detail">
              <div class="lib-hint lib-break">${esc(d.path ?? '')}</div>
              <dl>${d.sampleRate ? `<dt>Format</dt><dd>${d.sampleRate.toLocaleString()} Hz, ${d.channels ?? '?'} ch</dd>` : ''}
                ${d.tz ? `<dt>Clock</dt><dd>${esc(d.tz)}</dd>` : ''}
                ${d.meta.map(([k, v, origin]) => `<dt>${esc(k)}</dt><dd title="from ${esc(origin)}">${esc(v)}<span class="lib-hint"> · ${esc(origin)}</span></dd>`).join('')}
                ${d.fullHash ? `<dt>SHA-256</dt><dd class="lib-break lib-hint">${esc(d.fullHash.replace('sha256:', '').slice(0, 16))}…</dd>` : ''}
              </dl>
              ${d.tags.length ? `<div class="lib-tags">${d.tags.map((t) => `<span class="lib-tag">${esc(t)}</span>`).join('')}</div>` : ''}
            </div><h4>Edit</h4>` : ''}
          <label class="lib-field"><span>Site</span><select class="field-select" data-k="site">
            <option value="${KEEP}">unchanged</option>${opt(this.#sites)}<option value="${CLEAR}">— none —</option></select></label>
          <label class="lib-field"><span>Recorder</span><select class="field-select" data-k="device">
            <option value="${KEEP}">unchanged</option>${opt(this.#devices)}<option value="${CLEAR}">— none —</option></select></label>
          <label class="lib-field"><span>Add tags</span><input class="input" data-k="tag-add" list="lib-tag-list" placeholder="checked, rain, …"></label>
          ${this.#tags.length ? `<label class="lib-field"><span>Remove tag</span><select class="field-select" data-k="tag-remove">
            <option value="">—</option>${this.#tags.map((t) => `<option>${esc(t)}</option>`).join('')}</select></label>` : ''}
          <datalist id="lib-tag-list">${this.#tags.map((t) => `<option value="${esc(t)}">`).join('')}</datalist>
          <div class="lib-field"><span>Metadata</span><div class="lib-row">
            <input class="input" data-k="meta-key" list="lib-key-list" placeholder="key">
            <input class="input" data-k="meta-value" placeholder="value (empty = remove)"></div></div>
          <datalist id="lib-key-list">${this.#keys.map((k) => `<option value="${esc(k)}">`).join('')}</datalist>
          <div class="lib-row"><button class="btn btn--sm" data-act="apply">Apply to ${d ? 'this recording' : what}</button></div>
          <p class="lib-hint" data-k="result"></p>`;
    }

    #readEdit(): BulkEdit {
        const v = (k: string) => this.el.querySelector<HTMLInputElement | HTMLSelectElement>(`[data-k="${k}"]`)?.value ?? '';
        const e: BulkEdit = {};
        const site = v('site'), dev = v('device');
        if (site !== KEEP) e.siteId = site === CLEAR ? null : Number(site);
        if (dev !== KEEP) e.deviceId = dev === CLEAR ? null : Number(dev);
        e.addTags = v('tag-add').split(',').map((s) => s.trim()).filter(Boolean);
        const rm = v('tag-remove');
        e.removeTags = rm ? [rm] : [];
        const key = v('meta-key').trim();
        if (key) e.meta = [[key, v('meta-value').trim() || null]];
        return e;
    }

    async #onClick(ev: Event) {
        const act = (ev.target as HTMLElement | null)?.closest<HTMLElement>('[data-act]')?.dataset.act;
        if (act === 'pick-all') { this.el.dispatchEvent(new CustomEvent('lib-pick-all', { bubbles: true })); return; }
        if (act === 'pick-none') { this.el.dispatchEvent(new CustomEvent('lib-pick-none', { bubbles: true })); return; }
        if (act !== 'apply') return;
        const out = this.el.querySelector<HTMLElement>('[data-k="result"]')!;
        const edit = this.#readEdit();
        const empty = edit.siteId === undefined && edit.deviceId === undefined && !edit.addTags?.length && !edit.removeTags?.length && !edit.meta;
        if (empty) { out.textContent = 'Nothing to change.'; return; }
        if (this.#count > 1 && !confirm(`Change ${this.#count.toLocaleString()} recordings?`)) return;
        try {
            const r = await catalogApi.bulkEdit(this.#o.projectRoot, this.#sel, edit);
            this.#o.onApplied();
            // The selection stays (by id); refresh lists and detail.
            const keep = this.#sel.ids ? this.#sel : {};
            this.#renderedKey = '';   // start with an empty form
            await this.show(keep, this.#sel.ids ? this.#count : 0, { sites: this.#sites, devices: this.#devices });
            this.el.querySelector<HTMLElement>('[data-k="result"]')!.textContent = bulkReportText(r);
        } catch (e) {
            out.textContent = `Error: ${e instanceof Error ? e.message : e}`;
            out.classList.add('lib-warn');
        }
    }
}
