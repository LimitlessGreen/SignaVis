// ═══════════════════════════════════════════════════════════════════════
// ui/panels/library/map-dialog.ts — map of the (filtered) library
//
// Sites with coordinates (circle size = recordings), recordings with their
// own position (mobile recorders, GPS in the file, phone apps) binned on a
// grid that follows the zoom, GPS tracks as lines. A dragged rectangle
// filters the library to that area. GPX tracks are imported here and give
// recordings in their time span a position.
// ═══════════════════════════════════════════════════════════════════════

import {
    cellDegForZoom, matchReportText, type CatalogFilter, type FacetValue, type MapData, type TrackInfo,
} from '../../../domain/catalog/catalog-types.ts';
import { catalogApi, pickFile } from '../../../infrastructure/tauri/catalogApi.ts';
import { loadLeaflet } from '../../components/geo-map-modal/geo-map-modal.ts';

const esc = (s: unknown) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));
const day = (ms: number | null) => (ms == null ? '' : new Date(ms).toISOString().slice(0, 10));
const TRACK_COLORS = ['#e4572e', '#29335c', '#f3a712', '#669bbc', '#a8c686', '#8338ec'];

export interface MapDialogOptions {
    projectRoot: string;
    filter: CatalogFilter;
    devices: FacetValue[];
    /** Filter the library to an area, or to a site. */
    onArea: (bbox: [number, number, number, number]) => void;
    onSite: (siteId: number) => void;
    onWithoutPosition: () => void;
    /** Positions changed (track import/delete). */
    onChanged: () => void;
}

export class MapDialog {
    el: HTMLElement;
    #o: MapDialogOptions;
    #map: any = null;
    #layers: { sites: any; cells: any; tracks: any } | null = null;
    #data: MapData | null = null;
    #tracks: TrackInfo[] = [];
    #fitted = false;
    #gen = 0;

    constructor(o: MapDialogOptions) {
        this.#o = o;
        this.el = document.createElement('div');
        this.el.className = 'lib-map';
        this.el.innerHTML = `
          <div class="lib-map-canvas"></div>
          <aside class="lib-map-side">
            <p class="lib-hint" data-k="summary">Loading…</p>
            <div class="lib-row"><button class="btn btn--sm" data-act="area" title="Then drag a rectangle on the map">Filter by area</button>
              <button class="btn btn--sm btn--ghost" data-act="no-pos" hidden>Show those without position</button></div>
            <h4>GPS tracks</h4>
            <p class="lib-hint">A track (GPX, e.g. from a phone app or a GPS logger) gives recordings in its time span the position
              where they were made. Positions from the recorder itself or set by hand are kept.</p>
            <label class="lib-field"><span>Recordings of</span><select class="field-select" data-k="device">
              <option value="">all recorders (filtered)</option>${o.devices.map((d) => `<option value="${d.id}">${esc(d.name)}</option>`).join('')}</select></label>
            <label class="lib-field"><span>Max. time to the nearest track point</span>
              <div class="lib-row"><input class="input lib-num" type="number" min="1" step="1" data-k="gap" value="120"><span>s</span></div></label>
            <button class="btn btn--sm" data-act="import-track">Import GPX track…</button>
            <p class="lib-hint" data-k="track-result"></p>
            <div data-k="tracks"></div>
          </aside>`;
        this.el.addEventListener('click', (e) => void this.#onClick(e));
        void this.#init();
    }

    #disposed = false;
    #resize: ResizeObserver | null = null;
    #trackGen = 0;
    #areaActive = false;

    async #init() {
        try { await loadLeaflet(); } catch (e) {
            if (!this.#disposed) this.el.querySelector('[data-k="summary"]')!.textContent = `Map could not be loaded: ${e}`;
            return;
        }
        if (this.#disposed) return;   // closed while Leaflet was loading
        const L = (window as any).L;
        const canvas = this.el.querySelector<HTMLElement>('.lib-map-canvas')!;
        this.#map = L.map(canvas, { zoomControl: true, preferCanvas: true }).setView([51, 10], 5);
        L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
            maxZoom: 19, attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
        }).addTo(this.#map);
        this.#layers = { tracks: L.layerGroup().addTo(this.#map), cells: L.layerGroup().addTo(this.#map), sites: L.layerGroup().addTo(this.#map) };
        this.#map.on('zoomend', () => void this.#loadPoints());
        // The dialog may get its size after the map was created.
        this.#resize = new ResizeObserver(() => this.#map?.invalidateSize());
        this.#resize.observe(canvas);
        await Promise.all([this.#loadPoints(), this.#loadTracks()]);
    }

    async #loadPoints() {
        const gen = ++this.#gen;
        const zoom = this.#map?.getZoom() ?? 5;
        let d: MapData;
        try { d = await catalogApi.map(this.#o.projectRoot, this.#o.filter, cellDegForZoom(zoom)); } catch (e) {
            if (gen === this.#gen) this.el.querySelector('[data-k="summary"]')!.textContent = `Error: ${e}`;
            return;
        }
        if (gen !== this.#gen) return;
        this.#data = d;
        this.#drawPoints();
    }

    #drawPoints() {
        const L = (window as any).L, d = this.#data, lay = this.#layers;
        if (!L || !d || !lay) return;
        lay.sites.clearLayers();
        lay.cells.clearLayers();
        const css = getComputedStyle(this.el);
        const accent = css.getPropertyValue('--color-accent').trim() || '#38bdf8';
        const atSites = d.sites.reduce((a, s) => a + s.recordings, 0);
        for (const s of d.sites) {
            const m = L.circleMarker([s.lat, s.lon], {
                radius: 6 + 3 * Math.log10(1 + s.recordings), color: '#fff', weight: 2, fillColor: accent, fillOpacity: 0.85,
            }).addTo(lay.sites);
            m.bindTooltip(`${esc(s.name)} · ${s.recordings.toLocaleString()}`);
            m.bindPopup(`<b>${esc(s.name)}</b><br>${s.recordings.toLocaleString()} recordings<br>
              <button class="btn btn--sm" data-act="site" data-site="${s.id}">Show in library</button>`);
        }
        const max = Math.max(1, ...d.cells.map((c) => c.recordings));
        for (const c of d.cells) {
            L.circleMarker([c.lat, c.lon], {
                radius: 3 + 5 * Math.sqrt(c.recordings / max), stroke: false, fillColor: '#e4572e', fillOpacity: 0.75,
            }).addTo(lay.cells).bindTooltip(`${c.recordings.toLocaleString()} recording${c.recordings === 1 ? '' : 's'}`
                + (c.firstMs != null ? ` · ${day(c.firstMs)}${c.lastMs !== c.firstMs ? ` – ${day(c.lastMs)}` : ''}` : ''));
        }
        this.el.querySelector('[data-k="summary"]')!.innerHTML =
            `<span class="lib-dot" style="background:${accent}"></span> ${atSites.toLocaleString()} at ${d.sites.length} site${d.sites.length === 1 ? '' : 's'} ·
             <span class="lib-dot" style="background:#e4572e"></span> ${d.withOwnPosition.toLocaleString()} with own position ·
             ${d.withoutPosition.toLocaleString()} without position`;
        this.el.querySelector<HTMLElement>('[data-act="no-pos"]')!.hidden = !d.withoutPosition;
        if (!this.#fitted) {
            const pts: [number, number][] = [...d.sites.map((s) => [s.lat, s.lon] as [number, number]), ...d.cells.map((c) => [c.lat, c.lon] as [number, number])];
            if (pts.length) {
                this.#fitted = true;
                this.#map.fitBounds(L.latLngBounds(pts).pad(0.15), { maxZoom: 15 });
            }
        }
    }

    async #loadTracks() {
        const L = (window as any).L;
        const gen = ++this.#trackGen;
        let tracks: TrackInfo[];
        try { tracks = await catalogApi.tracks(this.#o.projectRoot); } catch { tracks = []; }
        if (gen !== this.#trackGen) return;   // a newer refresh (e.g. after a delete) owns the list
        this.#tracks = tracks;
        this.#layers?.tracks.clearLayers();
        const host = this.el.querySelector<HTMLElement>('[data-k="tracks"]')!;
        host.innerHTML = this.#tracks.length ? `<table class="lib-table lib-table--compact"><tbody>${this.#tracks.map((t, i) => `
            <tr data-track="${t.id}"><td><span class="lib-dot" style="background:${TRACK_COLORS[i % TRACK_COLORS.length]}"></span></td>
              <td><b>${esc(t.name)}</b><div class="lib-hint">${day(t.startMs)} · ${t.nPoints.toLocaleString()} points · ${t.recordings.toLocaleString()} recordings${t.device ? ` · ${esc(t.device)}` : ''}</div></td>
              <td><button class="btn btn--sm btn--ghost" data-act="track-zoom" title="Show on the map">⌖</button>
                <button class="btn btn--sm btn--ghost" data-act="track-delete" title="Delete the track and the positions it gave">✕</button></td></tr>`).join('')}
          </tbody></table>` : '';
        if (!L || !this.#layers) return;
        await Promise.all(this.#tracks.map(async (t, i) => {
            const line = await catalogApi.trackLine(this.#o.projectRoot, t.id).catch(() => []);
            if (gen !== this.#trackGen || !this.#layers) return;
            if (line.length) L.polyline(line, { color: TRACK_COLORS[i % TRACK_COLORS.length], weight: 3, opacity: 0.8 }).addTo(this.#layers!.tracks).bindTooltip(esc(t.name));
        }));
    }

    #startArea() {
        const L = (window as any).L, map = this.#map;
        if (!map || this.#areaActive) return;   // one rectangle gesture at a time
        this.#areaActive = true;
        const btn = this.el.querySelector<HTMLElement>('[data-act="area"]')!;
        btn.textContent = 'Drag a rectangle…';
        map.dragging.disable();
        map.getContainer().style.cursor = 'crosshair';
        let start: any = null, rect: any = null;
        const down = (e: any) => { start = e.latlng; rect = L.rectangle([start, start], { color: '#e4572e', weight: 2 }).addTo(map); };
        const move = (e: any) => { if (start && rect) rect.setBounds([start, e.latlng]); };
        const up = (e: any) => {
            map.off('mousedown', down).off('mousemove', move).off('mouseup', up);
            this.#areaActive = false;
            map.dragging.enable();
            map.getContainer().style.cursor = '';
            btn.textContent = 'Filter by area';
            if (!start) return;
            const b = L.latLngBounds(start, e.latlng);
            rect?.remove();
            if (b.getNorth() - b.getSouth() < 1e-6 || b.getEast() - b.getWest() < 1e-6) return;
            this.#o.onArea([b.getSouth(), b.getWest(), b.getNorth(), b.getEast()]);
        };
        map.on('mousedown', down).on('mousemove', move).on('mouseup', up);
    }

    async #onClick(e: Event) {
        const b = (e.target as HTMLElement).closest<HTMLElement>('[data-act]');
        if (!b) return;
        const out = this.el.querySelector<HTMLElement>('[data-k="track-result"]')!;
        try {
            switch (b.dataset.act) {
                case 'area': this.#startArea(); return;
                case 'site': this.#o.onSite(Number(b.dataset.site)); return;
                case 'no-pos': this.#o.onWithoutPosition(); return;
                case 'import-track': {
                    const path = await pickFile('GPS track', ['gpx']);
                    if (!path) return;
                    const dev = this.el.querySelector<HTMLSelectElement>('[data-k="device"]')!.value;
                    const gap = Number(this.el.querySelector<HTMLInputElement>('[data-k="gap"]')!.value) || 120;
                    const filter = dev ? { ...this.#o.filter, deviceIds: [Number(dev)] } : this.#o.filter;
                    out.classList.remove('lib-warn');
                    out.textContent = 'Reading track…';
                    const r = await catalogApi.importTrack(this.#o.projectRoot, path, dev ? Number(dev) : null, { filter }, gap);
                    out.textContent = `${r.points.toLocaleString()} points${r.untimed ? ` (${r.untimed} without time ignored)` : ''}. ${matchReportText(r.match)}`;
                    this.#fitted = false;
                    await Promise.all([this.#loadTracks(), this.#loadPoints()]);
                    const last = this.#tracks.find((t) => t.id === r.trackId);
                    if (last) this.#zoomTrack(last.id);
                    this.#o.onChanged();
                    return;
                }
                case 'track-zoom': this.#zoomTrack(Number(b.closest<HTMLElement>('[data-track]')!.dataset.track)); return;
                case 'track-delete': {
                    const id = Number(b.closest<HTMLElement>('[data-track]')!.dataset.track);
                    const t = this.#tracks.find((x) => x.id === id);
                    if (!confirm(`Delete track "${t?.name}"? ${t?.recordings ? `${t.recordings} recordings lose the position it gave them.` : ''}`)) return;
                    await catalogApi.deleteTrack(this.#o.projectRoot, id);
                    await Promise.all([this.#loadTracks(), this.#loadPoints()]);
                    this.#o.onChanged();
                    return;
                }
            }
        } catch (err) {
            out.textContent = `Error: ${err instanceof Error ? err.message : err}`;
            out.classList.add('lib-warn');
        }
    }

    async #zoomTrack(id: number) {
        const L = (window as any).L, map = this.#map;
        const line = await catalogApi.trackLine(this.#o.projectRoot, id).catch(() => []);
        if (L && line.length && map && map === this.#map) map.fitBounds(L.latLngBounds(line).pad(0.1));   // not after close
    }

    dispose() {
        this.#disposed = true;
        this.#resize?.disconnect();
        this.#resize = null;
        this.#map?.remove();
        this.#map = null;
    }
}
