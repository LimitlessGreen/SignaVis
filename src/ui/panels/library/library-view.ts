// ═══════════════════════════════════════════════════════════════════════
// ui/panels/library/library-view.ts — the project library (Lite)
//
// Full-window view over the project catalog: facets (sites, recorders),
// period and time of day, path search; a calendar heatmap; a virtual table
// that pages through the catalog (keyset) as you scroll. Double-click opens
// a recording in the editor. "Import folder…" opens the import dialog.
// ═══════════════════════════════════════════════════════════════════════

import {
    bboxLabel, fixedClockLabel, formatBytes, localTime,
    periodsWithShift, pickRows,
    type ClockPeriod, type ClockShift, type DeviceInfo,
    type CatalogCursor, type CatalogFilter, type CatalogRow, type CatalogSort, type Facets, type HashProgress, type HeatCell, type Integrity,
} from '../../../domain/catalog/catalog-types.ts';
import { catalogApi } from '../../../infrastructure/tauri/catalogApi.ts';
import { ImportDialog, timeZones } from './import-dialog.ts';
import { EntitiesDialog } from './entities-dialog.ts';
import { SelectionPanel } from './selection-panel.ts';
import { StatsDialog } from './stats-dialog.ts';
import { MapDialog } from './map-dialog.ts';

const esc = (s: unknown) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));
const ROW_H = 26;
const PAGE = 500;

const TIME_PRESETS: { label: string; from: number | null; to: number | null }[] = [
    { label: 'All day', from: null, to: null },
    { label: 'Night 18–07', from: 18, to: 7 },
    { label: 'Dusk 17–22', from: 17, to: 22 },
    { label: 'Dawn 04–09', from: 4, to: 9 },
    { label: 'Day 07–18', from: 7, to: 18 },
];

export interface LibraryViewOptions {
    projectRoot: string;
    /** Open a recording (absolute path) in the editor. */
    openRecording: (path: string, row: CatalogRow) => Promise<void> | void;
    onClose: () => void;
}

export class LibraryView {
    el: HTMLElement;
    #o: LibraryViewOptions;
    #filter: CatalogFilter = {};
    #sort: CatalogSort = 'start';
    #facets: Facets | null = null;
    #heat: HeatCell[] = [];
    #rows: CatalogRow[] = [];
    #next: CatalogCursor | null = null;
    #loading = false;
    #gen = 0;
    #selected = -1;
    #importDialog: ImportDialog | null = null;
    #searchTimer: ReturnType<typeof setTimeout> | null = null;
    #integrity: Integrity | null = null;
    #devices: DeviceInfo[] = [];
    #shifts: ClockShift[] = [];
    #hash: HashProgress | null = null;
    #unlisten: (() => void) | null = null;
    /** Picked recording ids (multi-select) and the anchor row for Shift+click. */
    #picked = new Set<number>();
    #anchor: number | null = null;
    /** Bulk edit applies to everything the filter shows. */
    #pickAll = false;
    #side: SelectionPanel;
    #mapDialog: MapDialog | null = null;

    constructor(o: LibraryViewOptions) {
        this.#o = o;
        this.el = document.createElement('div');
        this.el.className = 'lib-overlay';
        this.el.tabIndex = -1;
        this.el.innerHTML = `
          <header class="lib-head">
            <h2>Library</h2>
            <span class="lib-stats"></span>
            <span class="lib-spacer"></span>
            <span class="lib-integrity"></span>
            <button class="btn btn--sm btn--ghost" data-act="open-entities" title="Sites, recorders and deployments: names, coordinates, habitat, model, merge duplicates">Sites &amp; recorders…</button>
            <button class="btn btn--sm btn--ghost" data-act="open-map" title="Sites, recordings with their own position (mobile, GPS), GPS tracks; filter by area">Map…</button>
            <button class="btn btn--sm btn--ghost" data-act="open-stats" title="Coverage per site and week, recorder gaps, files, labels, detections">Statistics…</button>
            <button class="btn btn--sm" data-act="open-import">Import folder…</button>
            <button class="btn btn--sm btn--ghost" data-act="close" title="Close (Esc)">✕</button>
          </header>
          <div class="lib-body">
            <aside class="lib-facets"></aside>
            <main class="lib-main">
              <canvas class="lib-heat" height="110" title="Recordings per day (columns) and hour (rows, local time)"></canvas>
              <div class="lib-grid-head">
                <span class="c-path" data-sort="path">Path</span><span class="c-time" data-sort="start">Start (local)</span>
                <span class="c-site">Site</span><span class="c-dev">Recorder</span><span class="c-size">Size</span><span class="c-lab">Labels</span>
              </div>
              <div class="lib-grid"><div class="lib-grid-spacer"></div><div class="lib-grid-rows"></div></div>
            </main>
          </div>
          <div class="lib-import-host" hidden></div>`;
        this.#side = new SelectionPanel({ projectRoot: o.projectRoot, onApplied: () => void this.reload({ keepPicks: true }) });
        this.el.querySelector('.lib-body')!.appendChild(this.#side.el);
        this.el.addEventListener('lib-pick-all', () => { this.#picked.clear(); this.#pickAll = true; this.#renderRows(); this.#updateSide(); });
        this.el.addEventListener('lib-pick-none', () => { this.#picked.clear(); this.#pickAll = false; this.#renderRows(); this.#updateSide(); });
        this.el.addEventListener('click', (e) => this.#onClick(e));
        this.el.addEventListener('change', (e) => this.#onChange(e));
        this.el.addEventListener('input', (e) => this.#onSearch(e));
        this.el.addEventListener('keydown', (e) => this.#onKey(e));
        this.el.querySelector('.lib-grid')!.addEventListener('scroll', () => this.#renderRows(), { passive: true });
        this.el.querySelector('.lib-grid')!.addEventListener('dblclick', (e) => {
            const r = (e.target as HTMLElement).closest<HTMLElement>('[data-i]');
            if (r) void this.#open(Number(r.dataset.i));
        });
        new ResizeObserver(() => { this.#renderRows(); this.#drawHeat(); }).observe(this.el);
        void catalogApi.onHashProgress((p) => {
            if (p.projectRoot !== this.#o.projectRoot) return;
            this.#hash = p.finished ? null : p;
            if (p.finished) void this.#loadIntegrity(); else this.#renderIntegrity();
        }).then((u) => { this.#unlisten = u; }).catch(() => {});
        void this.reload();
        void this.#loadIntegrity();
    }

    dispose() { this.#unlisten?.(); }

    async #loadIntegrity() {
        try { this.#integrity = await catalogApi.integrity(this.#o.projectRoot); } catch { this.#integrity = null; }
        if (this.#integrity && !this.#integrity.hashing) this.#hash = null;
        this.#renderIntegrity();
    }

    #renderIntegrity() {
        const host = this.el.querySelector<HTMLElement>('.lib-integrity')!;
        const it = this.#integrity;
        const parts: string[] = [];
        if (this.#hash) {
            const what = { header: 'Reading headers', quick: 'Fingerprints', full: 'SHA-256 checksums' }[this.#hash.kind];
            parts.push(`<span>${what} ${this.#hash.done.toLocaleString()} / ${this.#hash.total.toLocaleString()}</span>
              <button class="btn btn--sm btn--ghost" data-act="hash-stop" title="Stop; finished files are kept and the rest continues next time">Stop</button>`);
        } else if (it && (it.unhashed > 0 || it.noHeader > 0)) {
            parts.push(`<button class="btn btn--sm btn--ghost" data-act="hash-start" title="Reads duration, sample rate and embedded metadata, and a fingerprint (start and end of each file) that recognises renamed or moved files and identical copies. About 2–3 min per 10 000 files on a USB disk.">Analyse ${Math.max(it.unhashed, it.noHeader).toLocaleString()} files</button>`);
        } else if (it && it.fullUnhashed > 0) {
            // ~120 MB/s on a USB hard disk.
            const min = Math.max(1, Math.round(it.bytesWithoutChecksum / 120e6 / 60));
            parts.push(`<button class="btn btn--sm btn--ghost" data-act="hash-full" title="SHA-256 over every byte: proves that files are unchanged and copies identical; checksum lists for archiving and publication. Reads ${formatBytes(it.bytesWithoutChecksum)} (about ${min} min on a USB hard disk).">Checksums for ${it.fullUnhashed.toLocaleString()} files</button>`);
        } else if (it && it.fullHashed > 0) {
            parts.push('<span title="All present files have a SHA-256 checksum">✓ checksums</span>');
        }
        if (it?.missing) parts.push(`<button class="btn btn--sm btn--ghost lib-warn" data-act="show-missing" title="Files the catalog knows but that were not found at the last import of their source">${it.missing.toLocaleString()} missing</button>`);
        if (it?.duplicateGroups) parts.push(`<button class="btn btn--sm btn--ghost lib-warn" data-act="show-dups">${it.duplicateGroups.toLocaleString()} identical copies</button>`);
        host.innerHTML = parts.join('');
    }

    async #showClocks() {
        const [devices, shifts] = await Promise.all([catalogApi.devices(this.#o.projectRoot), catalogApi.clockShifts(this.#o.projectRoot)]);
        this.#devices = devices;
        this.#shifts = shifts;
        const host = this.el.querySelector<HTMLElement>('.lib-import-host')!;
        const fmt = (t: string | null) => (t ? t.replace('T', ' ') : 'start');
        const periodRow = (p: ClockPeriod, i: number) => `<div class="lib-row lib-period" data-i="${i}">
            <input class="input" type="datetime-local" step="1" data-k="from" value="${esc(p.from ?? '')}" title="Recorder time from which this clock applies; empty = from the first recording">
            <input class="input" data-k="clock" list="lib-clock-list" value="${esc(p.clock)}">
            ${i > 0 ? `<input class="input lib-from-path" data-k="fromPath" value="${esc(p.fromPath ?? '')}" placeholder="first file: automatic"
              title="Only matters when the clock was set back while recording (times repeat): the first file after the change. Empty = decided by file order.">` : ''}
            <button class="btn btn--sm btn--ghost" data-act="period-del" title="Remove">✕</button></div>`;
        const devRow = (d: DeviceInfo) => `<tr data-device="${d.id}"><td>${esc(d.name)}<div class="lib-hint">${esc(d.sites.join(', '))}</div></td>
            <td class="num">${d.recordings.toLocaleString()}</td>
            <td><div class="lib-periods">${(d.periods.length ? d.periods : [{ from: null, clock: '' }]).map(periodRow).join('')}</div>
              <button class="btn btn--sm btn--ghost" data-act="period-add">+ change</button></td>
            <td><button class="btn btn--sm" data-act="device-clock-apply">Apply</button> <span class="lib-hint" data-k="clock-result"></span></td></tr>`;
        host.innerHTML = `<div class="lib-import-head"><h3>Recorder clocks</h3><span class="lib-spacer"></span>
            <button class="btn btn--sm btn--ghost" data-act="import-close" title="Close">✕</button></div>
          <div class="lib-import-preview">
            <p class="lib-hint">File names carry the recorder's own clock. Most recorders do not switch to daylight saving by themselves,
              but people sometimes set them by hand at a visit. Give each recorder its clock, with a change from a given recorder time
              if it was reset. Wall times stay, absolute times are recomputed. If the clock was set back while recording, the same
              times occur twice: file order (folder, name) decides which side a file is on, or name the first file after the change.
              An offset written into the file by the recorder (GUANO, AudioMoth) always wins.</p>
            ${shifts.length ? `<h4>Detected changes <button class="btn btn--sm" data-act="shifts-apply-all">Apply all</button></h4>
              <table class="lib-table lib-table--compact"><thead><tr><th>Recorder</th><th>From (recorder time)</th><th>Clock</th><th>Why</th><th></th></tr></thead><tbody>
              ${shifts.map((x, i) => `<tr data-shift="${i}"><td>${esc(x.device)}</td><td>${esc(fmt(x.kind === 'like-others' ? null : x.from))}</td>
                <td>${esc(x.clockBefore)} → ${esc(x.clockAfter)}</td>
                <td class="lib-hint">${x.kind === 'jump' ? `recording window moves by ${x.shiftMin > 0 ? '+' : ''}${x.shiftMin / 60} h from this night on`
                  : x.kind === 'set-back' ? `set back while recording: ${x.duplicates} files share a start time; file order decides before/after${x.unhashed ? ' (not fingerprinted yet: copies cannot be excluded)' : ''}`
                  : 'started after the others were changed and uses their new window'}</td>
                <td><button class="btn btn--sm btn--ghost" data-act="shift-apply">Apply</button></td></tr>`).join('')}</tbody></table>` : ''}
            <datalist id="lib-clock-list">${[-60, 0, 60, 120].map((m) => `<option value="${fixedClockLabel(m)}">`).join('')}
              ${timeZones().map((z) => `<option value="${esc(z)}">`).join('')}</datalist>
            <h4>Recorders</h4>
            <table class="lib-table lib-table--compact"><thead><tr><th>Recorder</th><th class="num">Recordings</th><th>Clock (from recorder time)</th><th></th></tr></thead>
            <tbody>${devices.map(devRow).join('')}</tbody></table></div>`;
        host.hidden = false;
    }

    #readPeriods(tr: HTMLElement): ClockPeriod[] {
        return [...tr.querySelectorAll<HTMLElement>('.lib-period')].map((r) => ({
            from: r.querySelector<HTMLInputElement>('[data-k="from"]')!.value || null,
            fromPath: r.querySelector<HTMLInputElement>('[data-k="fromPath"]')?.value.trim() || null,
            clock: r.querySelector<HTMLInputElement>('[data-k="clock"]')!.value.trim(),
        })).filter((p) => p.clock);
    }

    async #applyPeriods(deviceId: number, periods: ClockPeriod[]): Promise<string> {
        const r = await catalogApi.setDeviceClocks(this.#o.projectRoot, deviceId, periods);
        return `${r.updated.toLocaleString()} updated`
            + (r.gap ? `, ${r.gap} in the spring-forward gap (+1 h)` : '')
            + (r.ambiguous ? `, ${r.ambiguous} in a repeated hour (decided by file order)` : '')
            + (r.fromHeader ? `, ${r.fromHeader} use the offset written by the recorder` : '');
    }

    async #onClockAction(act: string, t: HTMLElement) {
        try {
            if (act === 'period-add') {
                const box = t.closest('td')!.querySelector('.lib-periods')!;
                const i = box.children.length;
                box.insertAdjacentHTML('beforeend', `<div class="lib-row lib-period" data-i="${i}">
                  <input class="input" type="datetime-local" step="1" data-k="from"><input class="input" data-k="clock" list="lib-clock-list" placeholder="UTC+02:00">
                  <button class="btn btn--sm btn--ghost" data-act="period-del" title="Remove">✕</button></div>`);
            } else if (act === 'period-del') {
                t.closest('.lib-period')!.remove();
            } else if (act === 'device-clock-apply') {
                const tr = t.closest<HTMLElement>('tr[data-device]')!;
                tr.querySelector('[data-k="clock-result"]')!.textContent = await this.#applyPeriods(Number(tr.dataset.device), this.#readPeriods(tr));
                void this.reload();
            } else if (act === 'shift-apply' || act === 'shifts-apply-all') {
                const list = act === 'shift-apply' ? [this.#shifts[Number(t.closest<HTMLElement>('[data-shift]')!.dataset.shift)]] : this.#shifts;
                for (const x of list) {
                    const d = this.#devices.find((v) => v.id === x.deviceId);
                    await this.#applyPeriods(x.deviceId, periodsWithShift(d?.periods ?? [], x));
                }
                await this.#showClocks();
                void this.reload();
            }
        } catch (e) {
            const out = t.closest('tr')?.querySelector('[data-k="clock-result"]');
            if (out) out.textContent = `Error: ${e}`; else this.el.querySelector('.lib-stats')!.textContent = `Error: ${e}`;
        }
    }

    #showDuplicates() {
        const it = this.#integrity;
        if (!it) return;
        const host = this.el.querySelector<HTMLElement>('.lib-import-host')!;
        host.innerHTML = `<div class="lib-import-head"><h3>Identical copies</h3>
            <span class="lib-stats">${it.duplicateGroups.toLocaleString()} groups of files with the same content${it.duplicateGroups > it.duplicates.length ? ` (first ${it.duplicates.length} shown)` : ''}</span>
            <span class="lib-spacer"></span><button class="btn btn--sm btn--ghost" data-act="import-close" title="Close">✕</button></div>
          <div class="lib-import-preview"><table class="lib-table lib-table--compact"><thead><tr><th>Files</th><th class="num">Size</th><th>Checked</th></tr></thead><tbody>
          ${it.duplicates.map((g) => `<tr><td>${g.paths.map((p) => `<div><code>${esc(p)}</code></div>`).join('')}</td><td class="num">${formatBytes(g.size)}</td>
            <td title="${g.verified ? 'Same SHA-256: byte-identical' : 'Same fingerprint (size, start, end); compute checksums to confirm'}">${g.verified ? 'SHA-256 ✓' : 'fingerprint'}</td></tr>`).join('')}
          </tbody></table></div>`;
        host.hidden = false;
    }

    focus() { this.el.focus(); }

    async reload(opts: { keepPicks?: boolean } = {}) {
        const gen = ++this.#gen;
        this.#rows = [];
        this.#next = null;
        this.#selected = -1;
        if (!opts.keepPicks) { this.#picked.clear(); this.#pickAll = false; this.#anchor = null; }
        try {
            const [facets, heat] = await Promise.all([
                catalogApi.facets(this.#o.projectRoot, this.#filter),
                catalogApi.heatmap(this.#o.projectRoot, this.#filter),
            ]);
            if (gen !== this.#gen) return;
            this.#facets = facets;
            this.#heat = heat;
        } catch (e) {
            this.#facets = null;
            this.el.querySelector('.lib-stats')!.textContent = `Catalog error: ${e}`;
            return;
        }
        this.#renderFacets();
        this.#renderStats();
        this.#drawHeat();
        this.#updateSide();
        await this.#loadMore(gen);
    }

    #updateSide() {
        const f = this.#facets;
        const lists = { sites: f?.sites ?? [], devices: f?.devices ?? [] };
        if (this.#pickAll) void this.#side.show({ filter: this.#filter }, f?.total ?? 0, lists);
        else void this.#side.show(this.#picked.size ? { ids: [...this.#picked] } : {}, this.#picked.size, lists);
    }

    async #loadMore(gen = this.#gen) {
        if (this.#loading || (this.#rows.length && !this.#next)) return;
        this.#loading = true;
        try {
            const page = await catalogApi.list(this.#o.projectRoot, this.#filter, this.#sort, this.#next, PAGE);
            if (gen !== this.#gen) return;
            this.#rows.push(...page.rows);
            this.#next = page.next;
        } finally {
            this.#loading = false;
        }
        this.#renderRows();
    }

    #renderStats() {
        const f = this.#facets;
        if (!f) return;
        const hours = f.seconds ? `${formatDuration(f.seconds)} · ` : '';
        const span = f.firstMs != null && f.lastMs != null
            ? ` · ${new Date(f.firstMs).toISOString().slice(0, 10)} – ${new Date(f.lastMs).toISOString().slice(0, 10)}` : '';
        this.el.querySelector('.lib-stats')!.textContent =
            `${f.total.toLocaleString()} recordings · ${hours}${formatBytes(f.bytes)}${span}${f.noStart ? ` · ${f.noStart} without start time` : ''}`;
    }

    #renderFacets() {
        const f = this.#facets;
        const host = this.el.querySelector('.lib-facets')!;
        if (!f) { host.innerHTML = ''; return; }
        const list = (kind: 'site' | 'device' | 'tag', title: string, vals: Facets['sites'], sel: number[] = []) => vals.length ? `
          <section><h4>${title}${sel.length ? ` <button class="btn btn--sm btn--ghost" data-act="clear-${kind}">all</button>` : ''}</h4>
          ${vals.map((v) => `<label class="lib-facet"><input type="checkbox" data-facet="${kind}" value="${v.id}"${sel.includes(v.id) ? ' checked' : ''}>
            <span>${esc(v.name)}</span><span class="num">${v.count.toLocaleString()}</span></label>`).join('')}</section>` : '';
        const tf = this.#filter;
        const preset = TIME_PRESETS.findIndex((p) => p.from === (tf.hourFrom ?? null) && p.to === (tf.hourTo ?? null));
        host.innerHTML = `
          ${tf.status ? `<section><h4>Status: ${esc(tf.status)} <button class="btn btn--sm btn--ghost" data-act="clear-status">all</button></h4></section>` : ''}
          <section><h4>Search</h4><input class="input" data-k="path" placeholder="Path contains…" value="${esc(tf.pathContains ?? '')}"></section>
          <section><h4>Time of day (local)</h4>
            <select class="field-select" data-k="tod">${TIME_PRESETS.map((p, i) => `<option value="${i}"${i === preset ? ' selected' : ''}>${p.label}</option>`).join('')}
              ${preset < 0 ? `<option selected>${tf.hourFrom}–${tf.hourTo}</option>` : ''}</select></section>
          <section><h4>Period</h4>
            <label class="lib-row"><span>from</span><input class="input" type="date" data-k="from" value="${tf.fromMs != null ? new Date(tf.fromMs).toISOString().slice(0, 10) : ''}"></label>
            <label class="lib-row"><span>to</span><input class="input" type="date" data-k="to" value="${tf.toMs != null ? new Date(tf.toMs - 86_400_000).toISOString().slice(0, 10) : ''}"></label></section>
          <section><h4>Labels</h4><select class="field-select" data-k="labels">
            <option value=""${tf.hasLabels == null ? ' selected' : ''}>any</option>
            <option value="1"${tf.hasLabels === true ? ' selected' : ''}>with labels</option>
            <option value="0"${tf.hasLabels === false ? ' selected' : ''}>without labels</option></select></section>
          ${list('site', 'Sites', f.sites, tf.siteIds)}
          ${list('device', 'Recorders <button class="btn btn--sm btn--ghost" data-act="clocks" title="Recorder clocks: offset, daylight saving, changes made by hand">clocks…</button>', f.devices, tf.deviceIds)}
          ${list('tag', 'Tags', f.tags ?? [], tf.tagIds)}
          <section><h4>Position${tf.bbox ? ' <button class="btn btn--sm btn--ghost" data-act="clear-area">all</button>' : ''}</h4>
            ${tf.bbox ? `<p class="lib-hint" title="Area drawn on the map">Area: ${esc(bboxLabel(tf.bbox))}</p>` : ''}
            <select class="field-select" data-k="pos" title="Own position (mobile, GPS) or the site's coordinates">
              <option value=""${tf.hasPosition == null ? ' selected' : ''}>any</option>
              <option value="1"${tf.hasPosition === true ? ' selected' : ''}>with position</option>
              <option value="0"${tf.hasPosition === false ? ' selected' : ''}>without position</option></select></section>
          <section><label class="lib-facet" title="Recordings that have no site or no recorder (path pattern did not give one)">
            <input type="checkbox" data-k="unassigned"${tf.unassigned ? ' checked' : ''}><span>Only without site or recorder</span></label></section>`;
    }

    #renderRows() {
        const grid = this.el.querySelector<HTMLElement>('.lib-grid')!;
        const spacer = this.el.querySelector<HTMLElement>('.lib-grid-spacer')!;
        const host = this.el.querySelector<HTMLElement>('.lib-grid-rows')!;
        const total = this.#facets?.total ?? this.#rows.length;
        spacer.style.height = `${total * ROW_H}px`;
        const first = Math.max(0, Math.floor(grid.scrollTop / ROW_H) - 5);
        const last = Math.min(total, Math.ceil((grid.scrollTop + grid.clientHeight) / ROW_H) + 5);
        if (last > this.#rows.length && this.#next) void this.#loadMore();
        host.style.transform = `translateY(${first * ROW_H}px)`;
        let html = '';
        for (let i = first; i < Math.min(last, this.#rows.length); i++) {
            const r = this.#rows[i];
            const gone = r.status === 'missing';
            html += `<div class="lib-r${this.#picked.has(r.id) || this.#pickAll ? ' is-sel' : ''}${i === this.#selected ? ' is-cur' : ''}${gone ? ' is-missing' : ''}" data-i="${i}" title="${esc(r.path)}${gone ? ' — not found at the last import' : ''}">
              <span class="c-path">${esc(r.path ?? '')}</span><span class="c-time">${esc(localTime(r))}</span>
              <span class="c-site">${esc(r.site ?? '')}</span><span class="c-dev">${esc(r.device ?? '')}</span>
              <span class="c-size">${r.size != null ? formatBytes(r.size) : ''}</span><span class="c-lab">${r.labels || ''}</span></div>`;
        }
        host.innerHTML = html;
        this.el.querySelectorAll<HTMLElement>('.lib-grid-head [data-sort]').forEach((h) =>
            h.classList.toggle('is-sorted', h.dataset.sort === this.#sort));
    }

    #drawHeat() {
        const c = this.el.querySelector<HTMLCanvasElement>('.lib-heat');
        if (!c) return;
        const W = c.clientWidth || 600, H = 110, PLOT = 96, LEFT = 24;
        const dpr = window.devicePixelRatio || 1;
        c.width = Math.round(W * dpr);
        c.height = Math.round(H * dpr);
        const g = c.getContext('2d')!;
        g.scale(dpr, dpr);
        g.clearRect(0, 0, W, H);
        const days = continuousDays(this.#heat.map((h) => h.day));
        if (!days.length) return;
        const css = getComputedStyle(this.el);
        const accent = css.getPropertyValue('--color-accent').trim() || '#38bdf8';
        const muted = css.getPropertyValue('--color-text-secondary').trim() || '#888';
        const max = Math.max(...this.#heat.map((h) => h.count));
        const cw = (W - LEFT) / days.length;
        const ch = PLOT / 24;
        const idx = new Map(days.map((d, i) => [d, i]));
        g.fillStyle = accent;
        for (const h of this.#heat) {
            g.globalAlpha = 0.15 + 0.85 * (h.count / max);
            g.fillRect(LEFT + idx.get(h.day)! * cw, h.hour * ch, Math.max(1, cw - 0.5), ch - 0.5);
        }
        g.globalAlpha = 1;
        g.fillStyle = muted;
        g.font = '10px sans-serif';
        g.textBaseline = 'middle';
        for (const hr of [0, 6, 12, 18]) g.fillText(String(hr).padStart(2, '0'), 2, hr * ch + ch / 2);
        // Date ticks: about every 80 px, on day boundaries.
        g.textBaseline = 'alphabetic';
        const every = Math.max(1, Math.ceil(80 / cw));
        for (let i = 0; i < days.length; i += every) g.fillText(days[i].slice(5), LEFT + i * cw, H - 2);
    }

    /** Mark the selected row without re-rendering (a re-render between the clicks would break double-click). */
    #select(i: number, mods: { ctrl?: boolean; shift?: boolean } = {}) {
        this.#selected = i;
        const before = [...this.#picked].join();
        const r = pickRows(this.#rows.map((x) => x.id), this.#picked, this.#anchor, i, mods);
        this.#picked = r.picked;
        this.#anchor = r.anchor;
        this.#pickAll = false;
        this.el.querySelectorAll<HTMLElement>('.lib-r').forEach((el) => {
            const k = Number(el.dataset.i);
            el.classList.toggle('is-sel', this.#picked.has(this.#rows[k]?.id));
            el.classList.toggle('is-cur', k === i);
        });
        if ([...this.#picked].join() !== before) this.#updateSide();
    }

    async #open(i: number) {
        const row = this.#rows[i];
        if (!row) return;
        this.#select(i);
        const path = await catalogApi.recordingPath(this.#o.projectRoot, row.id);
        if (!path) {
            this.el.querySelector('.lib-stats')!.textContent = 'This recording\'s source folder is not located on this computer.';
            return;
        }
        await this.#o.openRecording(path, row);
    }

    #onClick(e: Event) {
        const t = e.target as HTMLElement;
        const sortBy = t.closest<HTMLElement>('[data-sort]')?.dataset.sort as CatalogSort | undefined;
        if (sortBy && sortBy !== this.#sort) { this.#sort = sortBy; void this.reload(); return; }
        const row = t.closest<HTMLElement>('.lib-r');
        if (row) {
            const me = e as MouseEvent;
            this.#select(Number(row.dataset.i), { ctrl: me.ctrlKey || me.metaKey, shift: me.shiftKey });
            return;
        }
        const act = t.closest<HTMLElement>('[data-act]')?.dataset.act;
        if (act === 'close') this.#o.onClose();
        else if (act === 'open-import') this.#showImport();
        else if (act === 'open-entities') this.#showEntities();
        else if (act === 'open-stats') this.#showStats();
        else if (act === 'open-map') this.#showMap();
        else if (act === 'clear-area') { this.#filter.bbox = null; void this.reload(); }
        else if (act === 'hash-start' || act === 'hash-full') {
            const full = act === 'hash-full';
            this.#hash = {
                projectRoot: this.#o.projectRoot, kind: full && !this.#integrity?.unhashed ? 'full' : this.#integrity?.noHeader ? 'header' : 'quick',
                done: 0, total: (full ? this.#integrity?.fullUnhashed : this.#integrity?.unhashed) ?? 0, finished: false, failed: 0,
            };
            this.#renderIntegrity();
            void catalogApi.hashStart(this.#o.projectRoot, full)
                .catch((err) => { this.#hash = null; this.el.querySelector('.lib-stats')!.textContent = String(err); })
                .finally(() => void this.#loadIntegrity());
        }
        else if (act === 'hash-stop') void catalogApi.hashCancel();
        else if (act === 'show-dups') this.#showDuplicates();
        else if (act === 'clocks') void this.#showClocks();
        else if (act && ['period-add', 'period-del', 'device-clock-apply', 'shift-apply', 'shifts-apply-all'].includes(act)) {
            void this.#onClockAction(act, t.closest<HTMLElement>('[data-act]')!);
        }
        else if (act === 'show-missing') { this.#filter = { status: 'missing' }; void this.reload(); }
        else if (act === 'import-close') this.#hideImport();
        else if (act === 'clear-status') { this.#filter.status = null; void this.reload(); }
        else if (act === 'clear-site') { this.#filter.siteIds = []; void this.reload(); }
        else if (act === 'clear-device') { this.#filter.deviceIds = []; void this.reload(); }
        else if (act === 'clear-tag') { this.#filter.tagIds = []; void this.reload(); }
    }

    #onChange(e: Event) {
        const t = e.target as HTMLInputElement;
        if (t.closest('.lib-import-host')) return;
        const f = this.#filter;
        if (t.dataset.k === 'unassigned') {
            f.unassigned = t.checked;
        } else if (t.dataset.k === 'pos') {
            f.hasPosition = t.value === '' ? null : t.value === '1';
        } else if (t.dataset.facet) {
            const key = ({ site: 'siteIds', device: 'deviceIds', tag: 'tagIds' } as const)[t.dataset.facet as 'site' | 'device' | 'tag'];
            const set = new Set(f[key] ?? []);
            if (t.checked) set.add(Number(t.value)); else set.delete(Number(t.value));
            f[key] = [...set];
        } else if (t.dataset.k === 'tod') {
            const p = TIME_PRESETS[Number(t.value)];
            if (!p) return;
            f.hourFrom = p.from;
            f.hourTo = p.to;
        } else if (t.dataset.k === 'from') {
            f.fromMs = t.value ? Date.parse(`${t.value}T00:00:00Z`) : null;
        } else if (t.dataset.k === 'to') {
            f.toMs = t.value ? Date.parse(`${t.value}T00:00:00Z`) + 86_400_000 : null;
        } else if (t.dataset.k === 'labels') {
            f.hasLabels = t.value === '' ? null : t.value === '1';
        } else return;
        void this.reload();
    }

    #onSearch(e: Event) {
        const t = e.target as HTMLInputElement;
        if (t.dataset.k !== 'path') return;
        if (this.#searchTimer) clearTimeout(this.#searchTimer);
        this.#searchTimer = setTimeout(() => {
            this.#filter.pathContains = t.value.trim() || null;
            void this.reload().then(() => {
                const inp = this.el.querySelector<HTMLInputElement>('[data-k="path"]');
                if (inp) { inp.focus(); inp.setSelectionRange(inp.value.length, inp.value.length); }
            });
        }, 300);
    }

    #onKey(e: KeyboardEvent) {
        if ((e.target as HTMLElement).closest('input, textarea, select')) return;
        if (e.key === 'Escape') {
            if (!this.el.querySelector<HTMLElement>('.lib-import-host')!.hidden) this.#hideImport(); else this.#o.onClose();
        } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            e.preventDefault();
            this.#selected = Math.max(0, Math.min(this.#rows.length - 1, this.#selected + (e.key === 'ArrowDown' ? 1 : -1)));
            const grid = this.el.querySelector<HTMLElement>('.lib-grid')!;
            const y = this.#selected * ROW_H;
            if (y < grid.scrollTop) grid.scrollTop = y;
            else if (y + ROW_H > grid.scrollTop + grid.clientHeight) grid.scrollTop = y + ROW_H - grid.clientHeight;
            this.#renderRows();
        } else if (e.key === 'Enter' && this.#selected >= 0) {
            void this.#open(this.#selected);
        }
    }

    #showImport() {
        const host = this.el.querySelector<HTMLElement>('.lib-import-host')!;
        this.#importDialog = new ImportDialog({
            projectRoot: this.#o.projectRoot,
            onImported: () => {
                void this.reload();
                // Headers + fingerprints of new files in the background (renames are recognised on the next import).
                void catalogApi.hashStart(this.#o.projectRoot).catch(() => {}).finally(() => void this.#loadIntegrity());
            },
        });
        host.innerHTML = `<div class="lib-import-head"><h3>Import folder</h3><span class="lib-spacer"></span>
          <button class="btn btn--sm btn--ghost" data-act="import-close" title="Close">✕</button></div>`;
        host.appendChild(this.#importDialog.el);
        host.hidden = false;
    }

    #showHost(title: string, content: HTMLElement) {
        const host = this.el.querySelector<HTMLElement>('.lib-import-host')!;
        this.#importDialog = null;
        host.innerHTML = `<div class="lib-import-head"><h3>${esc(title)}</h3><span class="lib-spacer"></span>
          <button class="btn btn--sm btn--ghost" data-act="import-close" title="Close (Esc)">✕</button></div>`;
        host.appendChild(content);
        host.hidden = false;
    }

    #showEntities() {
        this.#showHost('Sites & recorders', new EntitiesDialog({ projectRoot: this.#o.projectRoot, onChanged: () => void this.reload({ keepPicks: true }) }).el);
    }

    #showMap() {
        this.#showHost('Map', (this.#mapDialog = new MapDialog({
            projectRoot: this.#o.projectRoot, filter: { ...this.#filter, bbox: null }, devices: this.#facets?.devices ?? [],
            onArea: (bbox) => { this.#filter = { ...this.#filter, bbox }; this.#hideImport(); void this.reload(); },
            onSite: (id) => { this.#filter = { ...this.#filter, siteIds: [id], bbox: null }; this.#hideImport(); void this.reload(); },
            onWithoutPosition: () => { this.#filter = { ...this.#filter, hasPosition: false, bbox: null }; this.#hideImport(); void this.reload(); },
            onChanged: () => void this.reload({ keepPicks: true }),
        })).el);
    }

    #showStats() {
        const tf = this.#filter;
        const filtered = Object.values(tf).some((v) => v != null && v !== false && !(Array.isArray(v) && !v.length));
        this.#showHost('Statistics', new StatsDialog({
            projectRoot: this.#o.projectRoot, filter: { ...tf }, filtered,
            onPickWeek: (siteId, week) => {
                const from = Date.parse(`${week}T00:00:00Z`);
                this.#filter = { ...this.#filter, siteIds: siteId == null ? [] : [siteId], fromMs: from, toMs: from + 7 * 86_400_000 };
                this.#hideImport();
                void this.reload();
            },
        }).el);
    }

    #hideImport() {
        this.#mapDialog?.dispose();
        this.#mapDialog = null;
        const host = this.el.querySelector<HTMLElement>('.lib-import-host')!;
        host.hidden = true;
        host.innerHTML = '';
        this.#importDialog = null;
        this.el.focus();
    }
}

/** Every day from the first to the last given day (ISO dates), so gaps stay visible. */
export function continuousDays(days: string[]): string[] {
    if (!days.length) return [];
    const sorted = [...days].sort();
    const out: string[] = [];
    const end = Date.parse(`${sorted[sorted.length - 1]}T00:00:00Z`);
    for (let t = Date.parse(`${sorted[0]}T00:00:00Z`); t <= end && out.length < 20_000; t += 86_400_000) {
        out.push(new Date(t).toISOString().slice(0, 10));
    }
    return out;
}

/** 12 min · 3.4 h · 1,710 h */
export function formatDuration(seconds: number): string {
    if (seconds < 3600) return `${Math.round(seconds / 60)} min`;
    const h = seconds / 3600;
    return `${h < 10 ? h.toFixed(1) : Math.round(h).toLocaleString()} h`;
}
