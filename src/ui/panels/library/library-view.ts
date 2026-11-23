// ═══════════════════════════════════════════════════════════════════════
// ui/panels/library/library-view.ts — the project library (Lite)
//
// Full-window view over the project catalog: facets (sites, recorders),
// period and time of day, path search; a calendar heatmap; a virtual table
// that pages through the catalog (keyset) as you scroll. Double-click opens
// a recording in the editor. "Import folder…" opens the import dialog.
// ═══════════════════════════════════════════════════════════════════════

import {
    bboxLabel, copyName, safeColor, datasetCountText, fixedClockLabel, formatBytes, isEmptyFilter, localTime, normalizeFilter,
    periodsWithShift, pickRows, sameFilter, sameSunWindow, sunWindowLabel, SUN_EVENTS, SUN_PRESETS,
    type DatasetInfo, type SunEvent,
    type ClockPeriod, type ClockShift, type DeviceInfo,
    type CatalogCursor, type CatalogFilter, type CatalogRow, type CatalogSort, type Facets, type HashProgress, type HeatCell, type Integrity,
} from '../../../domain/catalog/catalog-types.ts';
import {
    clockDuration, gridWindow, heatLut, moveIndex, scrollToShow, thumbPixels,
    type Thumb, type ThumbSpec,
} from '../../../domain/catalog/thumb-grid.ts';
import { catalogApi } from '../../../infrastructure/tauri/catalogApi.ts';
import { prefs } from '../../../infrastructure/storage/prefs.ts';
import { ImportDialog, timeZones } from './import-dialog.ts';
import { EntitiesDialog } from './entities-dialog.ts';
import { SelectionPanel } from './selection-panel.ts';
import { StatsDialog } from './stats-dialog.ts';
import { MapDialog } from './map-dialog.ts';
import { ExpandedView } from './expanded-view.ts';
import { DatasetDialog } from './dataset-dialog.ts';

const esc = (s: unknown) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));
const ROW_H = 26;
const PAGE = 500;
/** Tile grid: thumbnail sizes (drawn 1:1, also the card width), gap and caption height (px). */
/** Zoom steps of the grid (thumbnail = card width; each step has its own cached previews). */
const TILE_SIZES = [{ w: 120, h: 64 }, { w: 152, h: 80 }, { w: 184, h: 96 }, { w: 232, h: 120 }, { w: 300, h: 156 }] as const;
const TILE_GAP = 10;
/** Everything is drawn over the spectrogram; no caption below. */
const TILE_CAPTION = 0;
/** Distinct, readable on dark and light backgrounds; a field value always gets the same colour. */
const PALETTE = ['#ee8c3b', '#4cb5e8', '#9b7bf0', '#5cc98a', '#e8618c', '#d9c23f', '#3fc9c0', '#f07a5f', '#7f9cf5', '#b5d64a'];
export function valueColor(field: string, value: string | null): string {
    if (!value) return 'var(--color-text-secondary)';
    let h = 2166136261;
    for (const ch of `${field}:${value}`) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
    return PALETTE[(h >>> 0) % PALETTE.length];
}
const TILE_HZ = [4_000, 12_000, 24_000];
const TILE_KEY = 'signavis.library.tiles';
const THUMB_BATCH = 6;
/** Decoded thumbnails kept in memory (about 18 kB each at the default size → ~36 MB). */
const THUMB_CACHE = 2000;
const VIEW_KEY = 'signavis.library.view';

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
    /** Overlay only: the user closed the library. */
    onClose?: () => void;
    /** Placed in a panel (Lite spaces) instead of covering the window: no close button, Esc does not close. */
    embedded?: boolean;
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
    /** The page request in flight and the query generation it belongs to. */
    #page: { gen: number; p: Promise<void> } | null = null;
    #disposed = false;
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
    /** Table or tile grid (spectrogram thumbnails). */
    #view: 'table' | 'grid' = prefs.get(VIEW_KEY) === 'grid' ? 'grid' : 'table';
    #cols = 1;
    /** Thumbnails by recording id; a string = the error why there is none. */
    #thumbs = new Map<number, Thumb | string>();
    /** Ids the visible tiles still need, in screen order; one batch is fetched at a time. */
    #thumbWanted: number[] = [];
    #thumbBusy = false;
    #lut = heatLut();
    #tile: { zoom: number; maxHz: number; show: { site: boolean; device: boolean } } = (() => {
        const d = { zoom: 2, maxHz: 12_000, show: { site: true, device: true } };
        try {
            const t = prefs.json<any>(TILE_KEY, {});
            return {
                zoom: Number.isInteger(t.zoom) && t.zoom >= 0 && t.zoom < TILE_SIZES.length ? t.zoom : d.zoom,
                maxHz: TILE_HZ.includes(t.maxHz) ? t.maxHz : d.maxHz,
                show: { ...d.show, ...(t.show ?? {}) },
            };
        } catch { return d; }
    })();
    #expand: ExpandedView;
    #datasets: DatasetInfo[] = [];
    /** Open dataset: static → filter.datasetId; dynamic → its saved filter loaded into the controls. */
    #activeDs: number | null = null;
    #confirmDelete = false;
    /** Dataset counts are reloaded only after changes (a dynamic dataset over a big catalog can take a second). */
    #dsStale = true;
    #reloadOnClose = false;

    get #spec(): ThumbSpec { return { ...TILE_SIZES[this.#tile.zoom], maxHz: this.#tile.maxHz }; }
    get #tileW() { return TILE_SIZES[this.#tile.zoom].w + TILE_GAP; }
    get #tileH() { return TILE_SIZES[this.#tile.zoom].h + TILE_CAPTION + TILE_GAP; }

    constructor(o: LibraryViewOptions) {
        this.#o = o;
        this.el = document.createElement('div');
        this.el.className = o.embedded ? 'lib-overlay lib-embedded' : 'lib-overlay';
        this.el.tabIndex = -1;
        this.el.innerHTML = `
          <header class="lib-head">
            <h2>Library</h2>
            <span class="lib-stats"></span>
            <span class="lib-spacer"></span>
            <span class="lib-integrity"></span>
            <span class="lib-viewswitch" role="group" aria-label="View">
              <button data-act="view-table" title="Table (one recording per line)">☰ Table</button>
              <button data-act="view-grid" title="Tiles with a spectrogram of each whole recording">▦ Tiles</button>
            </span>
            <button class="btn btn--sm btn--ghost" data-act="open-entities" title="Sites, recorders and deployments: names, coordinates, habitat, model, merge duplicates">Sites &amp; recorders…</button>
            <button class="btn btn--sm btn--ghost" data-act="open-map" title="Sites, recordings with their own position (mobile, GPS), GPS tracks; filter by area">Map…</button>
            <button class="btn btn--sm btn--ghost" data-act="open-stats" title="Coverage per site and week, recorder gaps, files, labels, detections">Statistics…</button>
            <button class="btn btn--sm" data-act="open-import">Import folder…</button>
            ${o.embedded ? '' : '<button class="btn btn--sm btn--ghost" data-act="close" title="Close (Esc)">✕</button>'}
          </header>
          <div class="lib-body">
            <aside class="lib-facets"></aside>
            <main class="lib-main">
              <canvas class="lib-heat" height="110" title="Recordings per day (columns) and hour (rows, local time)"></canvas>
              <div class="lib-tilebar">
                <div class="lib-viewbar" title="Active filters — × removes one"></div>
                <span class="lib-seg" role="group" aria-label="Frequency range of the spectrograms"
                  title="Frequency range of the spectrograms (bottom to top). 0–4 kHz enlarges low calls such as owls; 0–24 kHz shows bats and insects.">
                  <span class="lib-seg-label">Spectrogram</span>
                  ${TILE_HZ.map((hz) => `<button data-act="tile-hz" data-v="${hz}">0–${hz / 1000} kHz</button>`).join('')}
                </span>
                <label class="lib-zoom" title="Tile size"><span aria-hidden="true">▪</span>
                  <input type="range" min="0" max="${TILE_SIZES.length - 1}" step="1" data-k="tile-zoom"><span aria-hidden="true">■</span></label>
              </div>
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
        this.#expand = new ExpandedView({
            projectRoot: o.projectRoot,
            rowAt: async (i) => {
                const gen = this.#gen;
                while (i >= this.#rows.length && this.#next && gen === this.#gen) {
                    const before = this.#rows.length;
                    await this.#loadMore(gen);
                    if (this.#rows.length === before) break;   // no progress (error or end)
                }
                return gen === this.#gen ? this.#rows[i] ?? null : null;
            },
            total: () => this.#facets?.total ?? this.#rows.length,
            open: (i) => void this.#open(i),
            onIndex: (i) => {
                if (i == null) {
                    this.el.focus();
                    // Members changed while the large view was open: counts and the open dataset follow now.
                    if (this.#reloadOnClose) { this.#reloadOnClose = false; void this.reload({ keepPicks: true }); }
                    return;
                }
                this.#select(i, { keepPicks: true });
                this.#reveal(i);
            },
            maxHz: () => this.#tile.maxHz,
            color: valueColor,
            datasets: () => this.#datasets.filter((d) => d.kind === 'static'),
            onDatasetsChanged: () => { this.#dsStale = true; this.#reloadOnClose = true; },
        });
        this.el.appendChild(this.#expand.el);
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
            if (p.error) this.el.querySelector('.lib-stats')!.textContent = `Analysing files stopped: ${p.error} (start it again to continue)`;
            if (p.finished) void this.#loadIntegrity(); else this.#renderIntegrity();
        }).then((u) => { if (this.#disposed) u(); else this.#unlisten = u; }).catch(() => {});
        this.#applyView();
        void this.reload();
        void this.#loadIntegrity();
    }

    #applyView() {
        this.el.classList.toggle('lib--tiles', this.#view === 'grid');
        this.el.querySelectorAll<HTMLElement>('.lib-viewswitch [data-act]').forEach((b) =>
            b.setAttribute('aria-pressed', String(b.dataset.act === `view-${this.#view}`)));
        this.el.querySelectorAll<HTMLElement>('.lib-tilebar [data-act="tile-hz"]').forEach((b) =>
            b.setAttribute('aria-pressed', String(Number(b.dataset.v) === this.#tile.maxHz)));
        this.el.querySelector<HTMLInputElement>('[data-k="tile-zoom"]')!.value = String(this.#tile.zoom);
    }

    #setTile(change: Partial<{ zoom: number; maxHz: number; show: { site: boolean; device: boolean } }>) {
        const keep = this.#selected;
        this.#tile = { ...this.#tile, ...change };
        prefs.setJson(TILE_KEY, this.#tile);
        if (change.zoom !== undefined || change.maxHz !== undefined) this.#thumbs.clear();
        this.#applyView();
        this.#renderFacets();
        this.#renderRows();
        if (keep >= 0) this.#reveal(keep);
    }

    #setView(v: 'table' | 'grid') {
        if (v === this.#view) return;
        this.#view = v;
        prefs.set(VIEW_KEY, v);
        this.#applyView();
        const grid = this.el.querySelector<HTMLElement>('.lib-grid')!;
        grid.scrollTop = 0;
        this.#renderRows();
        if (this.#selected >= 0) this.#reveal(this.#selected);
    }

    /** Top and height (px) of item i in the current view. */
    #itemBox(i: number): [number, number] {
        return this.#view === 'grid' ? [Math.floor(i / this.#cols) * this.#tileH, this.#tileH] : [i * ROW_H, ROW_H];
    }

    #reveal(i: number) {
        const grid = this.el.querySelector<HTMLElement>('.lib-grid')!;
        const [y, h] = this.#itemBox(i);
        const top = scrollToShow(y, h, grid.scrollTop, grid.clientHeight);
        if (top != null) grid.scrollTop = top;
        this.#renderRows();
    }

    dispose() { this.#disposed = true; this.#unlisten?.(); this.#unlisten = null; }

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
        let clocksChanged = false;
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
                const msg = await this.#applyPeriods(Number(tr.dataset.device), this.#readPeriods(tr));
                clocksChanged = true;
                tr.querySelector('[data-k="clock-result"]')!.textContent = msg;
            } else if (act === 'shift-apply' || act === 'shifts-apply-all') {
                const list = act === 'shift-apply' ? [this.#shifts[Number(t.closest<HTMLElement>('[data-shift]')!.dataset.shift)]] : this.#shifts;
                // Several shifts of one recorder build on each other; each recorder is written once.
                const byDevice = new Map<number, ClockPeriod[]>();
                for (const x of list) {
                    const cur = byDevice.get(x.deviceId) ?? this.#devices.find((v) => v.id === x.deviceId)?.periods ?? [];
                    byDevice.set(x.deviceId, periodsWithShift(cur, x));
                }
                for (const [deviceId, periods] of byDevice) {
                    await this.#applyPeriods(deviceId, periods);
                    clocksChanged = true;
                }
                await this.#showClocks();
            }
        } catch (e) {
            const out = t.closest('tr')?.querySelector('[data-k="clock-result"]');
            if (out) out.textContent = `Error: ${e}`; else this.el.querySelector('.lib-stats')!.textContent = `Error: ${e}`;
        } finally {
            // Also after a partial failure: times written so far changed rows and dataset counts.
            if (clocksChanged) { this.#dsStale = true; void this.reload(); }
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
        this.el.dataset.loading = '1';   // tests and styles: a reload is under way
        try { await this.#reload(gen, opts); } finally { if (gen === this.#gen) delete this.el.dataset.loading; }
    }

    async #reload(gen: number, opts: { keepPicks?: boolean }) {
        this.#rows = [];
        this.#next = null;
        this.#selected = -1;
        if (!opts.keepPicks) { this.#picked.clear(); this.#pickAll = false; this.#anchor = null; }
        try {
            const [facets, heat, datasets] = await Promise.all([
                catalogApi.facets(this.#o.projectRoot, this.#filter),
                catalogApi.heatmap(this.#o.projectRoot, this.#filter),
                this.#dsStale || opts.keepPicks
                    ? catalogApi.datasets(this.#o.projectRoot).catch(() => this.#datasets)
                    : Promise.resolve(this.#datasets),
            ]);
            if (gen !== this.#gen) return;
            this.#facets = facets;
            this.#heat = heat;
            this.#datasets = datasets;
            this.#dsStale = false;
            if (this.#activeDs != null && !datasets.some((d) => d.id === this.#activeDs)) this.#activeDs = null;
        } catch (e) {
            if (gen !== this.#gen) return;   // a newer reload owns the view
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
        const active = this.#active;
        const lists = {
            sites: f?.sites ?? [], devices: f?.devices ?? [],
            datasets: this.#datasets.filter((d) => d.kind === 'static'),
            activeStatic: active?.kind === 'static' ? active.id : null,
        };
        // A copy: later filter edits must not widen a bulk edit that shows this count.
        if (this.#pickAll) void this.#side.show({ filter: structuredClone(this.#filter) }, f?.total ?? 0, lists);
        else void this.#side.show(this.#picked.size ? { ids: [...this.#picked] } : {}, this.#picked.size, lists);
    }

    /**
     * Next page of the current query. Requests of one generation run one after the other
     * (a caller joins the one in flight); a request of an older generation does not block
     * the current one, its rows are dropped.
     */
    async #loadMore(gen = this.#gen): Promise<void> {
        while (this.#page) {
            if (this.#page.gen === gen) return this.#page.p;
            await this.#page.p.catch(() => {});
            if (gen !== this.#gen) return;
        }
        if (gen !== this.#gen || (this.#rows.length && !this.#next)) return;
        const entry = { gen, p: Promise.resolve() };
        this.#page = entry;
        entry.p = (async () => {
            try {
                const page = await catalogApi.list(this.#o.projectRoot, this.#filter, this.#sort, this.#next, PAGE);
                if (gen !== this.#gen) return;
                this.#rows.push(...page.rows);
                this.#next = page.next;
                this.#renderRows();
            } finally {
                if (this.#page === entry) this.#page = null;
            }
        })();
        return entry.p;
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
        const max = (vals: Facets['sites']) => Math.max(1, ...vals.map((v) => v.count));
        const list = (kind: 'site' | 'device' | 'tag', title: string, vals: Facets['sites'], sel: number[] = []) => vals.length ? `
          <section><h4>${kind !== 'tag' ? `<button class="lib-eye${this.#tile.show[kind] ? ' is-on' : ''}" data-act="field-show" data-f="${kind}"
              title="${this.#tile.show[kind] ? 'Hide' : 'Show'} on the tiles"></button>` : ''}${title}${sel.length ? ` <button class="btn btn--sm btn--ghost" data-act="clear-${kind}">all</button>` : ''}</h4>
          ${vals.map((v) => `<label class="lib-facet${sel.includes(v.id) ? ' is-on' : ''}" style="--pill:${valueColor(kind, v.name)};--share:${(v.count / max(vals)) * 100}%"><input type="checkbox" data-facet="${kind}" value="${v.id}"${sel.includes(v.id) ? ' checked' : ''}>
            <span>${esc(v.name)}</span><span class="num">${v.count.toLocaleString()}</span></label>`).join('')}</section>` : '';
        const tf = this.#filter;
        const preset = TIME_PRESETS.findIndex((p) => p.from === (tf.hourFrom ?? null) && p.to === (tf.hourTo ?? null));
        host.innerHTML = `
          ${this.#datasetSection()}
          ${tf.status ? `<section><h4>Status: ${esc(tf.status)} <button class="btn btn--sm btn--ghost" data-act="clear-status">all</button></h4></section>` : ''}
          <section><h4>Search</h4><input class="input" data-k="path" placeholder="Path contains…" value="${esc(tf.pathContains ?? '')}"></section>
          <section><h4>Time of day (local)</h4>
            <select class="field-select" data-k="tod">${TIME_PRESETS.map((p, i) => `<option value="${i}"${i === preset ? ' selected' : ''}>${p.label}</option>`).join('')}
              ${preset < 0 ? `<option selected>${tf.hourFrom}–${tf.hourTo}</option>` : ''}</select>
            ${this.#sunControls()}</section>
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
        this.#renderViewbar();
    }

    #chipText = '';
    get #active(): DatasetInfo | null { return this.#datasets.find((d) => d.id === this.#activeDs) ?? null; }

    /** Open dynamic dataset whose filter was changed in the controls (not saved yet). */
    get #dirty(): boolean {
        const a = this.#active;
        return a?.kind === 'filter' && !sameFilter(this.#filter, a.filter ?? {});
    }

    #datasetSection(): string {
        const a = this.#active;
        const item = (d: DatasetInfo) => `
          <button class="lib-ds${d.id === this.#activeDs ? ' is-on' : ''}${d.error ? ' is-bad' : ''}" data-act="ds-open" data-id="${d.id}" style="--pill:${safeColor(d.color) ?? 'var(--color-text-secondary)'}"
            title="${esc(d.description ?? '')}${d.description ? '\n' : ''}${d.kind === 'filter' ? 'Dynamic: saved filter, follows the catalog' : 'Static: fixed list'}${d.error ? `\n${esc(d.error)}` : ''}">
            <span class="lib-ds-icon" aria-hidden="true">${d.kind === 'filter' ? '⚲' : '▤'}</span><span class="lib-ds-name">${esc(d.name)}</span>
            <span class="num">${d.error ? '!' : d.recordings.toLocaleString()}</span></button>`;
        const actions = a ? `
          <div class="lib-ds-actions">
            ${this.#dirty ? `<button class="btn btn--sm" data-act="ds-save-filter" title="Store the current filters in “${esc(a.name)}”">Save filter</button>
              <button class="btn btn--sm btn--ghost" data-act="ds-revert" title="Back to the saved filter">Revert</button>` : ''}
            <button class="btn btn--sm btn--ghost" data-act="ds-edit" title="Name, description, colour">Edit…</button>
            <button class="btn btn--sm btn--ghost" data-act="ds-dup" title="${a.kind === 'filter' ? 'Copy with the same filter' : 'Copy with the same members'}">Copy</button>
            ${a.kind === 'filter' ? '<button class="btn btn--sm btn--ghost" data-act="ds-freeze" title="Static copy of the recordings it matches now. Later imports and edits do not change it — a fixed set to report on.">Freeze</button>' : ''}
            <button class="btn btn--sm btn--ghost${this.#confirmDelete ? ' lib-warn' : ''}" data-act="ds-del" title="Deletes the dataset only, never recordings">${this.#confirmDelete ? 'Really delete?' : 'Delete'}</button>
          </div>
          <p class="lib-hint">${esc(datasetCountText(a))}${a.description ? ` · ${esc(a.description)}` : ''}</p>` : '';
        return `<section class="lib-ds-section"><h4>Datasets <button class="btn btn--sm btn--ghost" data-act="ds-new" title="Save the current filter as a dataset, or start a fixed list">+ New</button></h4>
          <button class="lib-ds${this.#activeDs == null && this.#filter.datasetId == null ? ' is-on' : ''}" data-act="ds-all"><span class="lib-ds-icon" aria-hidden="true">◇</span><span class="lib-ds-name">All recordings</span></button>
          ${this.#datasets.map(item).join('')}
          ${this.#datasets.length ? '' : '<p class="lib-hint">A dataset is a named selection: a saved filter (dynamic) or a fixed list (static). A recording can be in several.</p>'}
          ${actions}</section>`;
    }

    #sunControls(): string {
        const w = this.#filter.sun ?? null;
        const preset = w ? SUN_PRESETS.findIndex((p) => sameSunWindow(p.w, w)) : -1;
        const ref = (side: 'from' | 'to') => `
          <span class="lib-row lib-sun-ref"><span>${side}</span>
            <select class="field-select" data-k="sun-${side}-ev">${SUN_EVENTS.map((e) => `<option value="${e.v}"${w?.[side].event === e.v ? ' selected' : ''}>${e.label}</option>`).join('')}</select>
            <input class="input" type="number" step="15" data-k="sun-${side}-off" value="${w?.[side].offsetMin ?? 0}" title="Minutes after (negative: before)"><span>min</span></span>`;
        return `<h4 title="Start time relative to the sun at the recording's own position or its site's coordinates. Recordings without a position are left out.">Sun</h4>
          <select class="field-select" data-k="sun">
            <option value=""${!w ? ' selected' : ''}>any</option>
            ${SUN_PRESETS.map((p, i) => `<option value="${i}"${i === preset ? ' selected' : ''}>${p.label}</option>`).join('')}
            <option value="custom"${w && preset < 0 ? ' selected' : ''}>custom…</option></select>
          ${w ? ref('from') + ref('to') : ''}`;
    }

    async #onDatasetAction(act: string, btn: HTMLElement) {
        const root = this.#o.projectRoot;
        const a = this.#active;
        if (act !== 'ds-del') this.#confirmDelete = false;
        const fail = (e: unknown) => { this.el.querySelector('.lib-stats')!.textContent = `Dataset: ${e}`; };
        try {
            if (act === 'ds-all') { this.#activeDs = null; this.#filter = {}; }
            else if (act === 'ds-open') {
                const d = this.#datasets.find((x) => x.id === Number(btn.dataset.id));
                if (!d) return;
                this.#activeDs = d.id;
                this.#filter = d.kind === 'filter' ? structuredClone(d.filter ?? {}) : { datasetId: d.id };
            }
            else if (act === 'ds-new') {
                const static_ = this.#active?.kind === 'static' && isEmptyFilter({ ...this.#filter, datasetId: null });
                this.#showHost('New dataset', new DatasetDialog({
                    projectRoot: root, filter: { ...this.#filter }, filterText: this.#chipText, shown: this.#facets?.total ?? 0,
                    kind: static_ || isEmptyFilter(this.#filter) ? 'static' : 'filter',
                    onDone: (id) => { this.#hideImport(); void this.#openDataset(id); },
                }).el);
                return;
            }
            else if (act === 'ds-edit' && a) {
                this.#showHost(`Dataset “${a.name}”`, new DatasetDialog({
                    projectRoot: root, dataset: a, filter: this.#filter, filterText: this.#chipText, shown: this.#facets?.total ?? 0,
                    onDone: () => { this.#hideImport(); this.#dsStale = true; void this.reload({ keepPicks: true }); },
                }).el);
                return;
            }
            else if (act === 'ds-save-filter' && a) await catalogApi.updateDataset(root, a.id, { filter: normalizeFilter(this.#filter) });
            else if (act === 'ds-revert' && a) this.#filter = structuredClone(a.filter ?? {});
            else if ((act === 'ds-dup' || act === 'ds-freeze') && a) {
                const freeze = act === 'ds-freeze';
                const id = await catalogApi.duplicateDataset(root, a.id, copyName(a.name, this.#datasets.map((d) => d.name), freeze), freeze);
                await this.#openDataset(id);
                return;
            }
            else if (act === 'ds-del' && a) {
                if (!this.#confirmDelete) { this.#confirmDelete = true; this.#renderFacets(); return; }
                this.#confirmDelete = false;
                await catalogApi.deleteDataset(root, a.id);
                this.#activeDs = null;
                this.#filter = {};
            }
            else return;
        } catch (e) { fail(e); return; }
        if (act !== 'ds-open' && act !== 'ds-all' && act !== 'ds-revert') this.#dsStale = true;
        await this.reload();
    }

    async #openDataset(id: number) {
        this.#dsStale = true;
        this.#datasets = await catalogApi.datasets(this.#o.projectRoot).catch(() => this.#datasets);
        const d = this.#datasets.find((x) => x.id === id);
        this.#activeDs = d ? id : null;
        if (d) this.#filter = d.kind === 'filter' ? structuredClone(d.filter ?? {}) : { datasetId: d.id };
        await this.reload();
    }

    /** Active filters as removable chips (above the grid). */
    #renderViewbar() {
        const tf = this.#filter, f = this.#facets;
        const named = (ids: number[] | undefined, vals: Facets['sites'] | undefined) =>
            (ids ?? []).map((id) => ({ id, name: vals?.find((v) => v.id === id)?.name ?? `#${id}` }));
        const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);
        /** [kind, label, colour, id of the facet value (sites, recorders, tags)] */
        const chips: [string, string, string?, number?][] = [];
        if (tf.datasetId != null) {
            const d = this.#datasets.find((x) => x.id === tf.datasetId);
            chips.push(['dataset', `in ${d?.name ?? `dataset ${tf.datasetId}`}`, safeColor(d?.color) ?? undefined]);
        }
        for (const v of named(tf.siteIds, f?.sites)) chips.push(['site', v.name, valueColor('site', v.name), v.id]);
        for (const v of named(tf.deviceIds, f?.devices)) chips.push(['device', v.name, valueColor('device', v.name), v.id]);
        for (const v of named(tf.tagIds, f?.tags)) chips.push(['tag', `#${v.name}`, undefined, v.id]);
        if (tf.pathContains) chips.push(['path', `“${tf.pathContains}”`]);
        if (tf.hourFrom != null) chips.push(['tod', `${String(tf.hourFrom).padStart(2, '0')}–${String(tf.hourTo).padStart(2, '0')} h`]);
        if (tf.fromMs != null || tf.toMs != null) chips.push(['period', `${tf.fromMs != null ? day(tf.fromMs) : '…'} – ${tf.toMs != null ? day(tf.toMs - 86_400_000) : '…'}`]);
        if (tf.localDayFrom || tf.localDayTo) chips.push(['localdays', `${tf.localDayFrom ?? '…'} – ${tf.localDayTo ?? '…'} (local)`]);
        if (tf.noSite) chips.push(['nosite', 'without site']);
        if (tf.hasLabels != null) chips.push(['labels', tf.hasLabels ? 'with labels' : 'without labels']);
        if (tf.hasPosition != null) chips.push(['pos', tf.hasPosition ? 'with position' : 'without position']);
        if (tf.bbox) chips.push(['bbox', `area ${bboxLabel(tf.bbox)}`]);
        if (tf.status) chips.push(['status', tf.status]);
        if (tf.unassigned) chips.push(['unassigned', 'without site/recorder']);
        if (tf.sun) chips.push(['sun', `☀ ${sunWindowLabel(tf.sun)}`]);
        this.#chipText = chips.map((c) => c[1]).join(' · ');
        const host = this.el.querySelector<HTMLElement>('.lib-viewbar')!;
        host.innerHTML = chips.length
            ? chips.map(([k, label, color, id]) => `<span class="lib-chip" data-k="${k}"${id != null ? ` data-id="${id}"` : ''}${color ? ` style="--pill:${color}"` : ''}>${esc(label)}<button data-act="chip-clear" title="Remove this filter">×</button></span>`).join('')
              + (chips.length > 1 ? '<button class="lib-chip lib-chip--reset" data-act="chip-clear" data-k="all">Reset</button>' : '')
            : `<span class="lib-muted">${(f?.total ?? 0).toLocaleString()} recordings · no filter</span>`;
    }

    #clearChip(k: string, id: number | null) {
        const tf = this.#filter;
        const drop = (ids: number[] | undefined) => (ids ?? []).filter((x) => x !== id);
        if (k === 'all') { this.#filter = {}; this.#activeDs = null; }
        else if (k === 'dataset') { tf.datasetId = null; if (this.#active?.kind === 'static') this.#activeDs = null; }
        else if (k === 'sun') tf.sun = null;
        else if (k === 'site') tf.siteIds = drop(tf.siteIds);
        else if (k === 'device') tf.deviceIds = drop(tf.deviceIds);
        else if (k === 'tag') tf.tagIds = drop(tf.tagIds);
        else if (k === 'path') tf.pathContains = null;
        else if (k === 'tod') { tf.hourFrom = null; tf.hourTo = null; }
        else if (k === 'period') { tf.fromMs = null; tf.toMs = null; }
        else if (k === 'localdays') { tf.localDayFrom = null; tf.localDayTo = null; }
        else if (k === 'nosite') tf.noSite = false;
        else if (k === 'labels') tf.hasLabels = null;
        else if (k === 'pos') tf.hasPosition = null;
        else if (k === 'bbox') tf.bbox = null;
        else if (k === 'status') tf.status = null;
        else if (k === 'unassigned') tf.unassigned = false;
        void this.reload();
    }

    #renderRows() {
        if (this.#view === 'grid') { this.#renderTiles(); return; }
        this.#cols = 1;
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
    #select(i: number, mods: { ctrl?: boolean; shift?: boolean; keepPicks?: boolean } = {}) {
        this.#selected = i;
        const before = [...this.#picked].join();
        if (mods.keepPicks) {
            this.#anchor = i;
        } else {
            const r = pickRows(this.#rows.map((x) => x.id), this.#picked, this.#anchor, i, mods);
            this.#picked = r.picked;
            this.#anchor = r.anchor;
            this.#pickAll = false;
        }
        this.el.querySelectorAll<HTMLElement>('.lib-r').forEach((el) => {
            const k = Number(el.dataset.i);
            el.classList.toggle('is-sel', this.#picked.has(this.#rows[k]?.id));
            el.classList.toggle('is-cur', k === i);
        });
        if ([...this.#picked].join() !== before) this.#updateSide();
    }

    #renderTiles() {
        const grid = this.el.querySelector<HTMLElement>('.lib-grid')!;
        const spacer = this.el.querySelector<HTMLElement>('.lib-grid-spacer')!;
        const host = this.el.querySelector<HTMLElement>('.lib-grid-rows')!;
        const total = this.#facets?.total ?? this.#rows.length;
        const { w, h } = TILE_SIZES[this.#tile.zoom];
        const tw = this.#tileW, th = this.#tileH;
        const win = gridWindow(grid.clientWidth - 2 * TILE_GAP, total, grid.scrollTop, grid.clientHeight, tw, th);
        this.#cols = win.cols;
        spacer.style.height = `${win.height + TILE_GAP}px`;
        if (win.last > this.#rows.length && this.#next) void this.#loadMore();
        host.style.transform = `translateY(${(win.first / win.cols) * th}px)`;
        host.style.gridTemplateColumns = `repeat(${win.cols}, minmax(${w}px, 1fr))`;
        host.style.setProperty('--thumb-h', `${h}px`);
        host.style.gridAutoRows = `${th - TILE_GAP}px`;
        host.style.gap = `${TILE_GAP}px`;
        let html = '';
        const wanted: number[] = [];
        for (let i = win.first; i < Math.min(win.last, this.#rows.length); i++) {
            const r = this.#rows[i];
            const gone = r.status === 'missing';
            const thumb = this.#thumbs.get(r.id);
            if (thumb === undefined && !gone) wanted.push(r.id);
            const [date, time] = localTime(r).split(' ');
            const sel = this.#picked.has(r.id) || this.#pickAll;
            const pills = [
                this.#tile.show.site && r.site ? `<span class="lib-pill" style="--pill:${valueColor('site', r.site)}">${esc(r.site)}</span>` : '',
                this.#tile.show.device && r.device ? `<span class="lib-pill" style="--pill:${valueColor('device', r.device)}">${esc(r.device)}</span>` : '',
            ].join('') || `<span class="lib-pill lib-pill--file">${esc((r.path ?? '').split('/').pop())}</span>`;
            html += `<div class="lib-r lib-tile${sel ? ' is-sel' : ''}${i === this.#selected ? ' is-cur' : ''}${gone ? ' is-missing' : ''}" data-i="${i}"
                title="${esc(r.path)}${gone ? ' — not found at the last import' : typeof thumb === 'string' ? ` — no preview: ${esc(thumb)}` : ''}">
              <div class="lib-tile-img">
                <canvas width="${w}" height="${h}" data-id="${r.id}"></canvas>
                <div class="lib-tile-top"><span class="lib-tile-check" data-act="tile-check" title="Select (Ctrl+click, Shift+click for a range)"></span>${pills}
                  ${r.labels ? `<span class="lib-tile-lab" title="${r.labels} labels">◆ ${r.labels}</span>` : ''}</div>
                <div class="lib-tile-bottom"><b>${esc(time ?? '')}</b><span>${esc(date ?? '')}</span>
                  ${gone ? '<em>missing</em>' : ''}<span class="lib-spacer"></span>${r.durationS != null ? `<span>${esc(clockDuration(r.durationS))}</span>` : ''}</div>
              </div></div>`;
        }
        host.innerHTML = html;
        host.querySelectorAll<HTMLCanvasElement>('canvas[data-id]').forEach((c) => this.#drawThumb(c));
        this.#thumbWanted = wanted;
        void this.#pumpThumbs();
    }

    #drawThumb(c: HTMLCanvasElement) {
        const th = this.#thumbs.get(Number(c.dataset.id));
        const g = c.getContext('2d');
        if (!g) return;
        if (th && typeof th !== 'string') {
            g.putImageData(new ImageData(thumbPixels(th, this.#lut), th.w, th.h), 0, 0);
            c.classList.remove('is-empty');
        } else {
            c.classList.add('is-empty');
            c.classList.toggle('is-failed', typeof th === 'string');
        }
    }

    /**
     * Keep at most THUMB_CACHE decoded thumbnails (Map order = insertion order, oldest first);
     * visible tiles stay. Evicted ones come back from the catalog's disk cache when scrolled to again.
     */
    #trimThumbs() {
        if (this.#thumbs.size <= THUMB_CACHE) return;
        const keep = new Set(this.#thumbWanted);
        for (const id of this.#thumbs.keys()) {
            if (this.#thumbs.size <= THUMB_CACHE) break;
            if (!keep.has(id)) this.#thumbs.delete(id);
        }
    }

    /** Fetch thumbnails for the visible tiles, one batch at a time (scrolling replaces the wish list). */
    async #pumpThumbs() {
        if (this.#thumbBusy) return;
        this.#thumbBusy = true;
        try {
            for (;;) {
                const batch = this.#thumbWanted.filter((id) => !this.#thumbs.has(id)).slice(0, THUMB_BATCH);
                if (!batch.length) break;
                let res;
                const spec = this.#spec;
                const stale = () => spec.w !== this.#spec.w || spec.maxHz !== this.#spec.maxHz;   // size/range changed meanwhile
                try {
                    res = await catalogApi.thumbs(this.#o.projectRoot, batch, spec);
                    if (stale()) continue;
                } catch (err) {
                    if (!stale()) for (const id of batch) this.#thumbs.set(id, String(err));
                    continue;
                }
                for (const r of res) {
                    this.#thumbs.set(r.recordingId, r.thumb ?? r.error ?? 'no preview');
                    this.#trimThumbs();
                    const c = this.el.querySelector<HTMLCanvasElement>(`.lib-tile canvas[data-id="${r.recordingId}"]`);
                    if (c) {
                        this.#drawThumb(c);
                        if (r.error) c.closest<HTMLElement>('.lib-tile')!.title += ` — no preview: ${r.error}`;
                    }
                }
            }
        } finally {
            this.#thumbBusy = false;
        }
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
            const i = Number(row.dataset.i);
            if (this.#view === 'grid' && t.closest('[data-act="tile-check"]')) this.#select(i, { ctrl: !me.shiftKey, shift: me.shiftKey });
            else if (this.#view === 'grid' && !me.ctrlKey && !me.metaKey && !me.shiftKey) { this.#select(i, { ctrl: false, shift: false, keepPicks: true }); void this.#expand.show(i); }
            else this.#select(i, { ctrl: me.ctrlKey || me.metaKey, shift: me.shiftKey });
            return;
        }
        const act = t.closest<HTMLElement>('[data-act]')?.dataset.act;
        if (act === 'close') this.#o.onClose?.();
        else if (act === 'tile-hz') this.#setTile({ maxHz: Number(t.closest<HTMLElement>('[data-v]')!.dataset.v) });
        else if (act === 'field-show') {
            const f = t.closest<HTMLElement>('[data-f]')!.dataset.f as 'site' | 'device';
            this.#setTile({ show: { ...this.#tile.show, [f]: !this.#tile.show[f] } });
        }
        else if (act === 'chip-clear') {
            const chip = t.closest<HTMLElement>('[data-k]')!;
            this.#clearChip(chip.dataset.k!, chip.dataset.id != null ? Number(chip.dataset.id) : null);
        }
        else if (act === 'view-table' || act === 'view-grid') this.#setView(act === 'view-grid' ? 'grid' : 'table');
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
        else if (act?.startsWith('ds-')) void this.#onDatasetAction(act, t.closest<HTMLElement>('[data-act]')!);
    }

    #onChange(e: Event) {
        const t = e.target as HTMLInputElement;
        if (t.closest('.lib-import-host')) return;
        if (t.dataset.k === 'tile-zoom') { this.#setTile({ zoom: Number(t.value) }); return; }
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
        } else if (t.dataset.k === 'sun') {
            f.sun = t.value === '' ? null : t.value === 'custom' ? (f.sun ?? SUN_PRESETS[0].w) : SUN_PRESETS[Number(t.value)]?.w ?? null;
            if (f.sun) f.sun = structuredClone(f.sun);
        } else if (t.dataset.k?.startsWith('sun-') && f.sun) {
            const [, side, part] = t.dataset.k.split('-') as [string, 'from' | 'to', 'ev' | 'off'];
            if (part === 'ev') f.sun[side].event = t.value as SunEvent;
            else f.sun[side].offsetMin = Math.round(Number(t.value) || 0);
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
        if (this.#expand.onKey(e)) return;
        if (e.key === 'Escape') {
            if (!this.el.querySelector<HTMLElement>('.lib-import-host')!.hidden) this.#hideImport(); else this.#o.onClose?.();
        } else if (e.key.startsWith('Arrow')) {
            const j = moveIndex(this.#selected, e.key, this.#cols, this.#rows.length);
            if (j < 0) return;
            e.preventDefault();
            this.#selected = j;
            this.#reveal(j);
        } else if (e.key === 'Enter' && this.#selected >= 0) {
            void this.#open(this.#selected);
        } else if (e.key === ' ' && this.#selected >= 0) {
            e.preventDefault();
            void this.#expand.show(this.#selected);   // large view also from the table
        }
    }

    #showImport() {
        const host = this.el.querySelector<HTMLElement>('.lib-import-host')!;
        this.#importDialog = new ImportDialog({
            projectRoot: this.#o.projectRoot,
            onImported: () => {
                this.#dsStale = true;
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
        this.#mapDialog?.dispose();   // replaced by another dialog: stop its map and observer
        this.#mapDialog = null;
        host.innerHTML = `<div class="lib-import-head"><h3>${esc(title)}</h3><span class="lib-spacer"></span>
          <button class="btn btn--sm btn--ghost" data-act="import-close" title="Close (Esc)">✕</button></div>`;
        host.appendChild(content);
        host.hidden = false;
    }

    #showEntities() {
        this.#showHost('Sites & recorders', new EntitiesDialog({ projectRoot: this.#o.projectRoot, onChanged: () => void this.reload({ keepPicks: true }) }).el);
    }

    #showMap() {
        const dlg = new MapDialog({
            projectRoot: this.#o.projectRoot, filter: { ...this.#filter, bbox: null }, devices: this.#facets?.devices ?? [],
            onArea: (bbox) => { this.#filter = { ...this.#filter, bbox }; this.#hideImport(); void this.reload(); },
            onSite: (id) => { this.#filter = { ...this.#filter, siteIds: [id], bbox: null }; this.#hideImport(); void this.reload(); },
            onWithoutPosition: () => { this.#filter = { ...this.#filter, hasPosition: false, bbox: null }; this.#hideImport(); void this.reload(); },
            onChanged: () => void this.reload({ keepPicks: true }),
        });
        this.#showHost('Map', dlg.el);   // disposes a map shown before
        this.#mapDialog = dlg;
    }

    #showStats() {
        const tf = this.#filter;
        const filtered = Object.values(tf).some((v) => v != null && v !== false && !(Array.isArray(v) && !v.length));
        this.#showHost('Statistics', new StatsDialog({
            projectRoot: this.#o.projectRoot, filter: { ...tf }, filtered,
            onPickWeek: (siteId, week) => {
                // The same recordings the cell counts: its local Monday–Sunday, and "(no site)" really without one.
                const sunday = new Date(Date.parse(`${week}T00:00:00Z`) + 6 * 86_400_000).toISOString().slice(0, 10);
                this.#filter = {
                    ...this.#filter, siteIds: siteId == null ? [] : [siteId], noSite: siteId == null,
                    fromMs: null, toMs: null, localDayFrom: week, localDayTo: sunday,
                };
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
