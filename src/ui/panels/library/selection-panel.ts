// ═══════════════════════════════════════════════════════════════════════
// ui/panels/library/selection-panel.ts — right side of the library
//
// One recording picked: its metadata (origin of each value), tags, hashes.
// Several picked, or "all filtered": bulk edit — site, recorder, tags,
// metadata. Changing the recorder recomputes times with its clock.
// ═══════════════════════════════════════════════════════════════════════

import {
    bulkReportText, parseCoords, safeColor, type BulkEdit, type DatasetInfo, type Membership, type FacetValue, type RecordingDetail, type Selection,
} from '../../../domain/catalog/catalog-types.ts';
import { catalogApi } from '../../../infrastructure/tauri/catalogApi.ts';
import { openMapModal } from '../../components/geo-map-modal/geo-map-modal.ts';

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
    /** Static datasets (targets for "add"), the open static one (for "remove"), memberships of a single recording. */
    #datasets: DatasetInfo[] = [];
    #activeStatic: number | null = null;
    #members: Membership[] = [];
    #dsResult: { text: string; bad: boolean } | null = null;
    #lastTarget: number | null = null;
    #gen = 0;

    constructor(o: SelectionPanelOptions) {
        this.#o = o;
        this.el = document.createElement('aside');
        this.el.className = 'lib-side';
        this.el.addEventListener('click', (e) => void this.#onClick(e));
        this.#render();
    }

    /** What is picked; `count` is how many recordings that is. Lists for the pickers come from the library. */
    async show(sel: Selection, count: number, lists: { sites: FacetValue[]; devices: FacetValue[]; datasets?: DatasetInfo[]; activeStatic?: number | null }) {
        const gen = ++this.#gen;
        this.#sel = sel;
        this.#count = count;
        this.#sites = lists.sites;
        this.#devices = lists.devices;
        this.#datasets = lists.datasets ?? this.#datasets;
        this.#activeStatic = lists.activeStatic === undefined ? this.#activeStatic : lists.activeStatic;
        this.#detail = null;
        this.#members = [];
        this.#render();   // at once, with the lists the library already has
        try {
            const one = sel.ids?.length === 1 ? sel.ids[0] : null;
            const [tags, keys, detail, members] = await Promise.all([
                catalogApi.tags(this.#o.projectRoot),
                catalogApi.metaKeys(this.#o.projectRoot),
                one != null ? catalogApi.recordingDetail(this.#o.projectRoot, one) : Promise.resolve(null),
                one != null ? catalogApi.recordingDatasets(this.#o.projectRoot, one).catch(() => []) : Promise.resolve([]),
            ]);
            if (gen !== this.#gen) return;
            this.#tags = tags.map((t) => t.name);
            this.#keys = keys.map(([k]) => k);
            this.#detail = detail;
            this.#members = members;
        } catch { /* lists stay empty */ }
        if (gen !== this.#gen) return;   // a newer selection owns the panel (also after a failed lookup)
        this.#render();
    }

    /** Identity of the current selection: form input survives re-renders while it stays the same. */
    #key(): string { return `${this.#count}:${this.#sel.ids?.join(',') ?? JSON.stringify(this.#sel.filter ?? {})}`; }
    #renderedKey = '';
    /** Outcome of the last apply; stays through refreshes of the same selection. */
    #result: { text: string; bad: boolean } | null = null;

    #render() {
        const keep = new Map<string, string>();
        if (this.#renderedKey !== this.#key() && this.#renderedKey !== '') { this.#result = null; this.#dsResult = null; }
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
                ${d.lat != null && d.lon != null ? `<dt>Position</dt><dd>${d.lat.toFixed(5)}, ${d.lon.toFixed(5)}${d.alt != null ? `, ${Math.round(d.alt)} m` : ''}<span class="lib-hint"> · ${esc({ manual: 'by hand', header: 'from the recorder', track: 'from a GPS track' }[d.posOrigin ?? 'manual'] ?? d.posOrigin)}</span></dd>` : ''}
                ${d.meta.map(([k, v, origin]) => `<dt>${esc(k)}</dt><dd title="from ${esc(origin)}">${esc(v)}<span class="lib-hint"> · ${esc(origin)}</span></dd>`).join('')}
                ${d.fullHash ? `<dt>SHA-256</dt><dd class="lib-break lib-hint">${esc(d.fullHash.replace('sha256:', '').slice(0, 16))}…</dd>` : ''}
              </dl>
              ${d.tags.length ? `<div class="lib-tags">${d.tags.map((t) => `<span class="lib-tag">${esc(t)}</span>`).join('')}</div>` : ''}
            </div>` : ''}
          ${this.#datasetBlock(d ? 'this recording' : what)}
          ${d ? '<h4>Edit</h4>' : ''}
          <label class="lib-field"><span>Site</span><select class="field-select" data-k="site">
            <option value="${KEEP}">unchanged</option>${opt(this.#sites)}<option value="${CLEAR}">— none —</option></select></label>
          <label class="lib-field"><span>Recorder</span><select class="field-select" data-k="device">
            <option value="${KEEP}">unchanged</option>${opt(this.#devices)}<option value="${CLEAR}">— none —</option></select></label>
          <label class="lib-field"><span>Add tags</span><input class="input" data-k="tag-add" list="lib-tag-list" placeholder="checked, rain, …"></label>
          ${this.#tags.length ? `<label class="lib-field"><span>Remove tag</span><select class="field-select" data-k="tag-remove">
            <option value="">—</option>${this.#tags.map((t) => `<option>${esc(t)}</option>`).join('')}</select></label>` : ''}
          <datalist id="lib-tag-list">${this.#tags.map((t) => `<option value="${esc(t)}">`).join('')}</datalist>
          <div class="lib-field"><span>Position (own, overrides the site)</span><div class="lib-row">
            <input class="input" data-k="position" placeholder="lat, lon — or “none”" title="Latitude, longitude in decimal degrees; “none” removes it">
            <button class="btn btn--sm btn--ghost" data-act="pick-pos" title="Pick on a map">map</button></div></div>
          <div class="lib-field"><span>Metadata</span><div class="lib-row">
            <input class="input" data-k="meta-key" list="lib-key-list" placeholder="key">
            <input class="input" data-k="meta-value" placeholder="value (empty = remove)"></div></div>
          <datalist id="lib-key-list">${this.#keys.map((k) => `<option value="${esc(k)}">`).join('')}</datalist>
          <div class="lib-row"><button class="btn btn--sm" data-act="apply">Apply to ${d ? 'this recording' : what}</button></div>
          <p class="lib-hint${this.#result?.bad ? ' lib-warn' : ''}" data-k="result">${esc(this.#result?.text ?? '')}</p>`;
    }

    #datasetBlock(what: string): string {
        const fmt = (t: number) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}`;
        const active = this.#datasets.find((x) => x.id === this.#activeStatic);
        const members = this.#members.length ? `<div class="lib-tags">${this.#members.map((m) => `<span class="lib-tag" style="--pill:${safeColor(m.color) ?? 'var(--color-text-secondary)'}"
            title="${m.kind === 'filter' ? 'matches the filter of this dynamic dataset' : 'member of this static dataset'}">${m.kind === 'filter' ? '⚲' : '▤'} ${esc(m.name)}${m.ranges.length ? ` <span class="lib-hint">${m.ranges.map(([a, b]) => `${fmt(a)}–${fmt(b)}`).join(', ')}</span>` : ''}</span>`).join('')}</div>` : '';
        const controls = this.#datasets.length ? `
          <div class="lib-row"><select class="field-select" data-k="ds-target" aria-label="Static dataset">
            ${this.#datasets.map((x) => `<option value="${x.id}"${x.id === this.#lastTarget ? ' selected' : ''}>${esc(x.name)}</option>`).join('')}</select>
            <button class="btn btn--sm btn--ghost" data-act="ds-add" title="Add ${esc(what)} to the chosen static dataset">Add</button></div>
          ${active ? `<div class="lib-row"><button class="btn btn--sm btn--ghost" data-act="ds-remove" title="Take ${esc(what)} out of “${esc(active.name)}” (recordings stay in the library)">Remove from “${esc(active.name)}”</button></div>` : ''}`
            : '<p class="lib-hint">No static dataset yet: “+ New” on the left starts one.</p>';
        return `<h4>Datasets</h4>${members}${controls}<p class="lib-hint${this.#dsResult?.bad ? ' lib-warn' : ''}" data-k="ds-result">${esc(this.#dsResult?.text ?? '')}</p>`;
    }

    async #datasetAction(act: 'ds-add' | 'ds-remove') {
        const id = act === 'ds-add' ? Number(this.el.querySelector<HTMLSelectElement>('[data-k="ds-target"]')?.value) : this.#activeStatic;
        const d = this.#datasets.find((x) => x.id === id);
        if (!d) return;
        if (act === 'ds-add') this.#lastTarget = d.id;
        const sel = this.#sel, key = this.#key();
        try {
            const n = act === 'ds-add'
                ? await catalogApi.datasetAdd(this.#o.projectRoot, d.id, sel)
                : await catalogApi.datasetRemove(this.#o.projectRoot, d.id, sel);
            if (this.#key() !== key) { this.#o.onApplied(); return; }
            this.#dsResult = {
                text: act === 'ds-add' ? (n ? `${n.toLocaleString()} added to “${d.name}”.` : `Already in “${d.name}”.`) : `${n.toLocaleString()} removed from “${d.name}”.`,
                bad: false,
            };
        } catch (e) {
            if (this.#key() !== key) return;
            this.#dsResult = { text: `Error: ${e instanceof Error ? e.message : e}`, bad: true };
            this.#render();
            return;
        }
        // Counts and memberships change: the library reloads and shows this panel again.
        this.#o.onApplied();
    }

    #setResult(text: string, bad = false) {
        this.#result = { text, bad };
        const out = this.el.querySelector<HTMLElement>('[data-k="result"]');
        if (out) { out.textContent = text; out.classList.toggle('lib-warn', bad); }
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
        const pos = v('position').trim();
        if (pos) {
            if (/^(none|-|—)$/i.test(pos)) e.position = null;
            else {
                const c = parseCoords(pos);
                if (!c) throw new Error('Position: "latitude, longitude" in decimal degrees, or "none"');
                e.position = [c.lat, c.lon];
            }
        }
        const key = v('meta-key').trim();
        if (key) e.meta = [[key, v('meta-value').trim() || null]];
        return e;
    }

    async #onClick(ev: Event) {
        const act = (ev.target as HTMLElement | null)?.closest<HTMLElement>('[data-act]')?.dataset.act;
        if (act === 'pick-all') { this.el.dispatchEvent(new CustomEvent('lib-pick-all', { bubbles: true })); return; }
        if (act === 'pick-none') { this.el.dispatchEvent(new CustomEvent('lib-pick-none', { bubbles: true })); return; }
        if (act === 'pick-pos') {
            const inp = this.el.querySelector<HTMLInputElement>('[data-k="position"]')!;
            const cur = parseCoords(inp.value) ?? (this.#detail?.lat != null ? { lat: this.#detail.lat, lon: this.#detail.lon! } : null);
            const key = this.#key();
            void openMapModal({ ...(cur ? { lat: cur.lat, lon: cur.lon, zoom: 13 } : {}), onConfirm: ({ lat, lon }: { lat: number; lon: number }) => {
                if (this.#key() !== key) return;   // another selection meanwhile
                // The form may have been re-rendered while the map was open: write to the input shown now.
                const now = this.el.querySelector<HTMLInputElement>('[data-k="position"]');
                if (now) now.value = `${lat.toFixed(6)}, ${lon.toFixed(6)}`;
            } });
            return;
        }
        if (act === 'ds-add' || act === 'ds-remove') { await this.#datasetAction(act); return; }
        if (act !== 'apply') return;
        let edit: BulkEdit;
        try { edit = this.#readEdit(); } catch (e) { this.#setResult(String(e instanceof Error ? e.message : e), true); return; }
        const empty = edit.siteId === undefined && edit.deviceId === undefined && !edit.addTags?.length && !edit.removeTags?.length && !edit.meta && edit.position === undefined;
        if (empty) { this.#setResult('Nothing to change.'); return; }
        if (this.#count > 1 && !confirm(`Change ${this.#count.toLocaleString()} recordings?`)) return;
        // The selection this edit is for; feedback only while it is still the one shown.
        const sel = this.#sel, count = this.#count, key = this.#key();
        try {
            const r = await catalogApi.bulkEdit(this.#o.projectRoot, sel, edit);
            this.#o.onApplied();   // the catalog changed, whatever is selected now
            if (this.#key() !== key) return;
            // The selection stays (by id); refresh lists and detail.
            this.#result = { text: bulkReportText(r), bad: false };
            this.#renderedKey = '';   // start with an empty form
            await this.show(sel.ids ? sel : {}, sel.ids ? count : 0, { sites: this.#sites, devices: this.#devices });
        } catch (e) {
            if (this.#key() === key) this.#setResult(`Error: ${e instanceof Error ? e.message : e}`, true);
        }
    }
}
