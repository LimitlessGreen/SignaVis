// ═══════════════════════════════════════════════════════════════════════
// ui/panels/library/entities-dialog.ts — sites, recorders, deployments
//
// Edit what the import created from folder and file names: site details
// (coordinates, habitat, notes, photo), recorder details (model, serial),
// merge duplicates ("34" and "34_21"), delete unused ones, and derive
// deployments (recorder × site × stretch of time) with notes.
// Fields save when they lose focus.
// ═══════════════════════════════════════════════════════════════════════

import {
    parseCoords, type DeploymentInfo, type DeviceFields, type SiteFields,
} from '../../../domain/catalog/catalog-types.ts';
import { catalogApi } from '../../../infrastructure/tauri/catalogApi.ts';

const esc = (s: unknown) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));
const day = (ms: number | null) => (ms == null ? '' : new Date(ms).toISOString().slice(0, 10));

type Tab = 'site' | 'device' | 'deployment';
interface Entry<F> { id: number; recordings: number; fields: F }

export interface EntitiesDialogOptions {
    projectRoot: string;
    /** Something changed that the library list shows (names, merges). */
    onChanged: () => void;
    initialTab?: Tab;
}

export class EntitiesDialog {
    el: HTMLElement;
    #o: EntitiesDialogOptions;
    #tab: Tab;
    #sites: Entry<SiteFields>[] = [];
    #devices: Entry<DeviceFields>[] = [];
    #deployments: DeploymentInfo[] = [];

    constructor(o: EntitiesDialogOptions) {
        this.#o = o;
        this.#tab = o.initialTab ?? 'site';
        this.el = document.createElement('div');
        this.el.className = 'lib-entities';
        this.el.addEventListener('click', (e) => void this.#onClick(e));
        this.el.addEventListener('change', (e) => void this.#onChange(e));
        void this.load();
    }

    async load() {
        const root = this.#o.projectRoot;
        try {
            const [sites, devices, deployments] = await Promise.all([catalogApi.sites(root), catalogApi.devices(root), catalogApi.deployments(root)]);
            this.#sites = await Promise.all(sites.map(async (s) => ({ id: s.id, recordings: s.recordings, fields: await catalogApi.siteFields(root, s.id) })));
            this.#devices = await Promise.all(devices.map(async (d) => ({ id: d.id, recordings: d.recordings, fields: await catalogApi.deviceFields(root, d.id) })));
            this.#deployments = deployments;
        } catch (e) {
            this.el.innerHTML = `<p class="lib-warn">Error: ${esc(e)}</p>`;
            return;
        }
        this.#render();
    }

    #status(text: string, bad = false) {
        const s = this.el.querySelector<HTMLElement>('[data-k="status"]');
        if (s) { s.textContent = text; s.classList.toggle('lib-warn', bad); }
    }

    #render() {
        const tab = (t: Tab, label: string, n: number) =>
            `<button class="btn btn--sm${this.#tab === t ? '' : ' btn--ghost'}" data-act="tab" data-tab="${t}">${label} <span class="lib-hint">${n}</span></button>`;
        let body = '';
        if (this.#tab === 'site') body = this.#renderSites();
        else if (this.#tab === 'device') body = this.#renderDevices();
        else body = this.#renderDeployments();
        this.el.innerHTML = `<div class="lib-row lib-tabs">${tab('site', 'Sites', this.#sites.length)}${tab('device', 'Recorders', this.#devices.length)}
            ${tab('deployment', 'Deployments', this.#deployments.length)}<span class="lib-spacer"></span><span class="lib-hint" data-k="status"></span></div>
          <div class="lib-import-preview">${body}</div>`;
    }

    #mergeBar(kind: 'site' | 'device', list: Entry<SiteFields | DeviceFields>[]) {
        return `<div class="lib-row lib-merge-bar" hidden>
            <span data-k="merge-count"></span>
            <label>into <select class="field-select" data-k="merge-into">${list.map((e) => `<option value="${e.id}">${esc(e.fields.name)}</option>`).join('')}</select></label>
            <button class="btn btn--sm" data-act="merge" data-kind="${kind}">Merge</button>
            <span class="lib-hint">Recordings move to the target; empty fields of the target are filled from the others.</span></div>`;
    }

    #renderSites() {
        const row = (e: Entry<SiteFields>) => {
            const f = e.fields;
            const coords = f.lat != null && f.lon != null ? `${f.lat}, ${f.lon}` : '';
            return `<tr data-site="${e.id}">
              <td><input type="checkbox" data-k="pick" title="Select for merging"></td>
              <td><input class="input" data-f="name" value="${esc(f.name)}"></td>
              <td><input class="input lib-coords" data-f="coords" value="${esc(coords)}" placeholder="52.1234, 8.5678"
                title="Latitude, longitude in decimal degrees (paste from a map)">
                ${coords ? `<a class="lib-hint" href="https://www.openstreetmap.org/?mlat=${f.lat}&mlon=${f.lon}#map=15/${f.lat}/${f.lon}" target="_blank" rel="noopener" title="Show on OpenStreetMap">map</a>` : ''}</td>
              <td><input class="input lib-num" type="number" step="any" data-f="elevation" value="${f.elevation ?? ''}" placeholder="m"></td>
              <td><input class="input" data-f="habitat" value="${esc(f.habitat)}"></td>
              <td><input class="input" data-f="notes" value="${esc(f.notes)}"></td>
              <td><input class="input" data-f="photo" value="${esc(f.photo)}" placeholder="path to a photo"></td>
              <td class="num">${e.recordings.toLocaleString()}</td>
              <td>${e.recordings ? '' : '<button class="btn btn--sm btn--ghost" data-act="delete" title="Delete (not used by any recording)">✕</button>'}</td></tr>`;
        };
        return `${this.#mergeBar('site', this.#sites)}
          <table class="lib-table lib-table--compact lib-edit"><thead><tr><th></th><th>Name</th><th>Coordinates</th><th>Elevation</th><th>Habitat</th><th>Notes</th><th>Photo</th>
            <th class="num">Recordings</th><th></th></tr></thead>
          <tbody>${this.#sites.map(row).join('')}</tbody></table>
          <button class="btn btn--sm btn--ghost" data-act="add" data-kind="site">+ Site</button>`;
    }

    #renderDevices() {
        const row = (e: Entry<DeviceFields>) => {
            const f = e.fields;
            return `<tr data-device="${e.id}">
              <td><input type="checkbox" data-k="pick" title="Select for merging"></td>
              <td><input class="input" data-f="name" value="${esc(f.name)}"></td>
              <td><input class="input" data-f="model" value="${esc(f.model)}" placeholder="e.g. Song Meter Micro"></td>
              <td><input class="input" data-f="serial" value="${esc(f.serial)}"></td>
              <td><input class="input" data-f="notes" value="${esc(f.notes)}"></td>
              <td class="num">${e.recordings.toLocaleString()}</td>
              <td>${e.recordings ? '' : '<button class="btn btn--sm btn--ghost" data-act="delete" title="Delete (not used by any recording)">✕</button>'}</td></tr>`;
        };
        return `${this.#mergeBar('device', this.#devices)}
          <table class="lib-table lib-table--compact lib-edit"><thead><tr><th></th><th>Name</th><th>Model</th><th>Serial number</th><th>Notes</th>
            <th class="num">Recordings</th><th></th></tr></thead>
          <tbody>${this.#devices.map(row).join('')}</tbody></table>
          <button class="btn btn--sm btn--ghost" data-act="add" data-kind="device">+ Recorder</button>
          <p class="lib-hint">Merging recorders recomputes the times of the moved recordings with the target's clock.</p>`;
    }

    #renderDeployments() {
        const d = this.#deployments;
        return `<p class="lib-hint">A deployment is one recorder at one site for an uninterrupted stretch of time. They are derived from
            the recordings; a pause longer than the given number of days (rotation, removal) starts a new one. Deriving again keeps
            notes of deployments that still overlap.</p>
          <div class="lib-row"><label>New deployment after a pause of <input class="input lib-num" type="number" min="0" step="0.5" data-k="gap" value="3"> days</label>
            <button class="btn btn--sm" data-act="derive">${d.length ? 'Derive again' : 'Derive from recordings'}</button></div>
          ${d.length ? `<table class="lib-table lib-table--compact lib-edit"><thead><tr><th>Recorder</th><th>Site</th><th>From</th><th>To</th>
            <th class="num">Days</th><th class="num">Recordings</th><th>Notes</th></tr></thead><tbody>
            ${d.map((x) => `<tr data-deployment="${x.id}"><td>${esc(x.device ?? '—')}</td><td>${esc(x.site ?? '—')}</td>
              <td>${day(x.startMs)}</td><td>${day(x.endMs)}</td>
              <td class="num">${x.startMs != null && x.endMs != null ? Math.max(1, Math.round((x.endMs - x.startMs) / 86_400_000)) : ''}</td>
              <td class="num">${x.recordings.toLocaleString()}</td>
              <td><input class="input" data-f="notes" value="${esc(x.notes)}" placeholder="battery, card, damage…"></td></tr>`).join('')}
            </tbody></table>` : ''}`;
    }

    #updateMergeBar() {
        const picked = this.el.querySelectorAll<HTMLInputElement>('[data-k="pick"]:checked');
        const bar = this.el.querySelector<HTMLElement>('.lib-merge-bar');
        if (!bar) return;
        bar.hidden = picked.length < 2;
        bar.querySelector('[data-k="merge-count"]')!.textContent = `${picked.length} selected`;
        // Offer only the picked ones as target.
        const ids = new Set([...picked].map((c) => c.closest<HTMLElement>('tr')!.dataset.site ?? c.closest<HTMLElement>('tr')!.dataset.device));
        bar.querySelectorAll<HTMLOptionElement>('option').forEach((o) => { o.hidden = !ids.has(o.value); });
        const sel = bar.querySelector<HTMLSelectElement>('select')!;
        if (!ids.has(sel.value)) sel.value = [...ids][0] ?? '';
    }

    /** Saves per site/recorder run one after the other, each built from the fields saved before it. */
    #saving = new Map<string, Promise<void>>();

    async #onChange(e: Event) {
        const t = e.target as HTMLInputElement;
        if (t.dataset.k === 'pick') { this.#updateMergeBar(); return; }
        const f = t.dataset.f;
        if (!f) return;
        const tr = t.closest<HTMLElement>('tr')!;
        const key = `${tr.dataset.site ?? ''}|${tr.dataset.device ?? ''}|${tr.dataset.deployment ?? ''}`;
        const run = (this.#saving.get(key) ?? Promise.resolve()).then(() => this.#save(t, f, tr));
        this.#saving.set(key, run);
        await run;
        if (this.#saving.get(key) === run) this.#saving.delete(key);
    }

    async #save(t: HTMLInputElement, f: string, tr: HTMLElement) {
        const root = this.#o.projectRoot;
        try {
            if (tr.dataset.site) {
                const e = this.#sites.find((x) => x.id === Number(tr.dataset.site))!;
                const next = { ...e.fields };
                if (f === 'coords') {
                    if (!t.value.trim()) { next.lat = null; next.lon = null; } else {
                        const c = parseCoords(t.value);
                        if (!c) throw new Error('coordinates: "latitude, longitude" in decimal degrees');
                        next.lat = c.lat; next.lon = c.lon;
                    }
                } else if (f === 'elevation') next.elevation = t.value === '' ? null : Number(t.value);
                else (next as unknown as Record<string, string>)[f] = t.value;
                await catalogApi.saveSite(root, e.id, next);
                e.fields = await catalogApi.siteFields(root, e.id);
                if (f === 'coords') this.#render();
            } else if (tr.dataset.device) {
                const e = this.#devices.find((x) => x.id === Number(tr.dataset.device))!;
                const next = { ...e.fields, [f]: t.value };
                await catalogApi.saveDevice(root, e.id, next);
                e.fields = await catalogApi.deviceFields(root, e.id);
            } else if (tr.dataset.deployment) {
                const id = Number(tr.dataset.deployment);
                await catalogApi.setDeploymentNotes(root, id, t.value);
                const dep = this.#deployments.find((x) => x.id === id);
                if (dep) dep.notes = t.value;
            }
            t.classList.remove('is-invalid');
            this.#status('Saved');
            // Names show in the library; site coordinates give recordings without their own a position.
            if (f === 'name' || (f === 'coords' && tr.dataset.site)) this.#o.onChanged();
        } catch (err) {
            t.classList.add('is-invalid');
            this.#status(String(err instanceof Error ? err.message : err), true);
        }
    }

    async #onClick(e: Event) {
        const b = (e.target as HTMLElement).closest<HTMLElement>('[data-act]');
        if (!b) return;
        const root = this.#o.projectRoot;
        try {
            switch (b.dataset.act) {
                case 'tab': this.#tab = b.dataset.tab as Tab; this.#render(); return;
                case 'add': {
                    const kind = b.dataset.kind as 'site' | 'device';
                    const list = kind === 'site' ? this.#sites : this.#devices;
                    let name = kind === 'site' ? 'New site' : 'New recorder';
                    for (let i = 2; list.some((x) => x.fields.name === name); i++) name = `${kind === 'site' ? 'New site' : 'New recorder'} ${i}`;
                    if (kind === 'site') await catalogApi.saveSite(root, null, { name });
                    else await catalogApi.saveDevice(root, null, { name });
                    await this.load();
                    this.#o.onChanged();
                    return;
                }
                case 'delete': {
                    const tr = b.closest<HTMLElement>('tr')!;
                    const [table, id] = tr.dataset.site ? ['site', tr.dataset.site] as const : ['device', tr.dataset.device!] as const;
                    await catalogApi.deleteEntity(root, table, Number(id));
                    await this.load();
                    this.#o.onChanged();
                    return;
                }
                case 'merge': {
                    const kind = b.dataset.kind as 'site' | 'device';
                    const into = Number(this.el.querySelector<HTMLSelectElement>('[data-k="merge-into"]')!.value);
                    const from = [...this.el.querySelectorAll<HTMLInputElement>('[data-k="pick"]:checked')]
                        .map((c) => Number(c.closest<HTMLElement>('tr')!.dataset[kind])).filter((id) => id !== into);
                    const names = from.map((id) => (kind === 'site' ? this.#sites : this.#devices).find((x) => x.id === id)?.fields.name).join(', ');
                    const target = (kind === 'site' ? this.#sites : this.#devices).find((x) => x.id === into)?.fields.name;
                    if (!confirm(`Merge ${names} into ${target}? This cannot be undone.`)) return;
                    const moved = await catalogApi.merge(root, kind, from, into);
                    await this.load();
                    this.#status(`${moved.toLocaleString()} recordings moved to ${target}`);
                    this.#o.onChanged();
                    return;
                }
                case 'derive': {
                    const gap = Number(this.el.querySelector<HTMLInputElement>('[data-k="gap"]')!.value) || 0;
                    const r = await catalogApi.deriveDeployments(root, gap);
                    this.#deployments = await catalogApi.deployments(root);
                    this.#render();
                    this.#status(`${r.deployments} deployments with ${r.recordings.toLocaleString()} recordings${r.keptNotes ? `, notes of ${r.keptNotes} kept` : ''}`);
                    return;
                }
            }
        } catch (err) {
            this.#status(String(err instanceof Error ? err.message : err), true);
        }
    }
}
