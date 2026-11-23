// ═══════════════════════════════════════════════════════════════════════
// ui/panels/embedding-map.ts — full-window 2-D map of the project's Perch-2
// windows (SignaVis Lite). Data from embed_map (src-tauri-lite/src/embed_map.rs).
//
// Wheel: zoom · drag: pan · hover: tooltip · click: play · double-click: open
// Shift+drag: lasso → label the selection for the current agile class.
// Colour by folder / recording / HDBSCAN cluster / class labels / classifier
// score / time of day / date; cluster cards (size, make-up, typical windows),
// optional assignment of unclustered windows to their nearest cluster, and a
// label check (embed_clusters, agile_scores, agile_suspects). Filters: hours,
// dates (from AudioMoth-style file names) and a minimum RMS level.
// See plans/lite-embedding-map-plan.md.
// ═══════════════════════════════════════════════════════════════════════

import { contextFromFilename } from '../../app/recording-context.ts';

export interface MapData {
    stamp: number; window: number; layoutPoints: number;
    files: string[]; file: number[]; start: number[]; x: number[]; y: number[];
    /** Window level (RMS, dBFS); empty when the store predates levels. */
    level?: number[];
    /** New windows placed onto the existing layout since it was computed (0 = fresh layout). */
    placedNew?: number;
}
export interface MapWindow { path: string; start: number; end: number; score: number }
type Label = 'pos' | 'neg' | 'unsure';
type ColorBy = 'folder' | 'file' | 'cluster' | 'label' | 'score' | 'time' | 'date';
export interface ClusterInfo { id: number; size: number; exemplars: number[] }
export interface Clusters {
    stamp: number; minClusterSize: number; labels: number[]; strength: number[]; clusters: ClusterInfo[]; noise: number;
    /** Nearest cluster of every point, also for unclustered ones (−1: none reachable). */
    nearest?: number[];
}
export interface Suspect { path: string; start: number; label: Label; otherFrac: number; neighbours: number; score: number | null }

export interface EmbeddingMapOptions {
    load: (force: boolean) => Promise<MapData>;
    /** Current agile class ('' = none) and its label for a window. */
    getClass: () => string;
    labelOf: (path: string, start: number) => Label | null;
    setLabels: (items: { path: string; start: number }[], label: Label | null) => Promise<void>;
    openHit: (hit: MapWindow, play: boolean) => Promise<void> | void;
    /** HDBSCAN clusters (minSize null = automatic). */
    loadClusters: (minSize: number | null) => Promise<Clusters>;
    /** Classifier scores of the current class, one per map point. */
    loadScores: () => Promise<number[]>;
    /** Labelled windows of the current class that look mislabelled. */
    loadSuspects: () => Promise<Suspect[]>;
}

// Categorical palette (readable on light and dark backgrounds), cycled for many groups.
const PALETTE = ['#4e9af1', '#f1a34e', '#5cc98a', '#e5615f', '#a77ee8', '#d9c94a', '#4cc6c9', '#e07bc0', '#9aa857', '#c98a5c'];
const LABEL_COLOR: Record<Label, string> = { pos: '#5cc98a', neg: '#e5615f', unsure: '#d9c94a' };
const UNLABELED = 'rgba(128,136,150,0.4)';
const NOISE = 'rgba(128,136,150,0.3)';
const SUSPECT = '#ff4d4f';

/** Classifier score → colour: blue (0) – grey (0.5) – yellow (1). */
export function scoreColor(v: number): string {
    const stops: [number, number, number][] = [[78, 121, 216], [150, 150, 150], [241, 196, 15]];
    const t = Math.min(1, Math.max(0, v)) * 2;
    const k = Math.min(1, Math.floor(t));
    const f = t - k;
    const [a, b] = [stops[k], stops[k + 1]];
    return `rgb(${a.map((c, i) => Math.round(c + (b[i] - c) * f)).join(',')})`;
}

/** Hour of day (0–24) → colour: night blue – dawn orange – noon yellow – dusk magenta (cyclic). */
export function timeColor(hour: number): string {
    const stops: [number, [number, number, number]][] = [[0, [40, 50, 110]], [6, [235, 130, 50]], [12, [240, 200, 40]], [18, [200, 70, 140]], [24, [40, 50, 110]]];
    const h = ((hour % 24) + 24) % 24;
    let k = 0;
    while (k < stops.length - 2 && h >= stops[k + 1][0]) k++;
    const [[h0, a], [h1, b]] = [stops[k], stops[k + 1]];
    const f = (h - h0) / (h1 - h0);
    return `rgb(${a.map((c, i) => Math.round(c + (b[i] - c) * f)).join(',')})`;
}

/** 0..1 → sequential colour (viridis-like), for dates. */
export function seqColor(t: number): string {
    const stops: [number, number, number][] = [[68, 1, 84], [59, 82, 139], [33, 145, 140], [94, 201, 98], [253, 231, 37]];
    const x = Math.min(1, Math.max(0, t)) * (stops.length - 1);
    const k = Math.min(stops.length - 2, Math.floor(x));
    const f = x - k;
    return `rgb(${stops[k].map((c, i) => Math.round(c + (stops[k + 1][i] - c) * f)).join(',')})`;
}

/**
 * Time of day (minutes, 0..1440) and day number (days since 1970) of every window, from the
 * recording start in its file name (AudioMoth "20240512_053000", "…_dt20230322_065001_…").
 * NaN where the name carries no date and time.
 */
export function windowTimes(files: string[], file: number[], start: number[]): { minute: Float64Array; day: Float64Array; known: number } {
    const fileStart = files.map((f) => {
        const ctx = contextFromFilename(f.split('/').pop() || f);
        if (!ctx.date || !ctx.time) return null;
        const [y, m, d] = ctx.date.split('-').map(Number);
        const [hh, mm] = ctx.time.split(':').map(Number);
        return { day: Date.UTC(y, m - 1, d) / 86_400_000, minute: hh * 60 + mm };
    });
    const n = file.length;
    const minute = new Float64Array(n).fill(NaN), day = new Float64Array(n).fill(NaN);
    let known = 0;
    for (let i = 0; i < n; i++) {
        const fs = fileStart[file[i]];
        if (!fs) continue;
        const t = fs.minute + start[i] / 60;
        day[i] = fs.day + Math.floor(t / 1440);
        minute[i] = t - Math.floor(t / 1440) * 1440;
        known++;
    }
    return { minute, day, known };
}

/** Is `hour` (0..24) inside [h0, h1)? Wraps past midnight when h0 > h1 (e.g. 20–6). */
export function inHours(hour: number, h0: number, h1: number): boolean {
    if (h0 === h1 || (h0 === 0 && h1 === 24)) return true;
    return h0 < h1 ? hour >= h0 && hour < h1 : hour >= h0 || hour < h1;
}

const dayToIso = (d: number) => new Date(d * 86_400_000).toISOString().slice(0, 10);
const isoToDay = (s: string) => (s ? Date.parse(`${s}T00:00:00Z`) / 86_400_000 : NaN);

/** '#rrggbb' → rgba with the given alpha. */
const withAlpha = (hex: string, a: number) => `rgba(${[1, 3, 5].map((k) => parseInt(hex.slice(k, k + 2), 16)).join(',')},${a})`;

/** Make-up of a group: the most frequent keys with their share. */
export function topShares(keys: string[], max = 2): { key: string; share: number }[] {
    const cnt = new Map<string, number>();
    keys.forEach((k) => cnt.set(k, (cnt.get(k) || 0) + 1));
    return [...cnt.entries()].sort((a, b) => b[1] - a[1]).slice(0, max)
        .map(([key, c]) => ({ key, share: c / Math.max(1, keys.length) }));
}
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));
const fmtTime = (s: number) => {
    const m = Math.floor(s / 60);
    return `${m}:${(s - m * 60).toFixed(1).padStart(4, '0')}`;
};
const dirOf = (p: string) => p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '.';
/** Short name of a folder key from dirOf ('.' = files directly in the project folder). */
const folderLabel = (k: string) => (k === '.' ? '(project folder)' : k.split('/').pop() || k);

/** Point-in-polygon (even-odd rule). */
export function inPolygon(px: number, py: number, poly: [number, number][]): boolean {
    let inside = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
        const [xi, yi] = poly[i], [xj, yj] = poly[j];
        if ((yi > py) !== (yj > py) && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
}

export class EmbeddingMap {
    el: HTMLElement;
    #opts: EmbeddingMapOptions;
    #canvas: HTMLCanvasElement;
    #tip: HTMLElement;
    #data: MapData | null = null;
    #colorBy: ColorBy = 'folder';
    #groupOf: number[] = [];      // file index → colour group
    #groupNames: string[] = [];
    // view: screen = (p - c) * scale + centre
    #cx = 0.5; #cy = 0.5; #scale = 1; #fitScale = 1;
    /** View still shows the whole map (not zoomed/panned) → refit when the stage resizes. */
    #fitted = false;
    #grid = new Map<number, number[]>();
    #hover = -1;
    #sel = new Set<number>();
    #lasso: [number, number][] | null = null;
    #drag: { x: number; y: number; cx: number; cy: number; moved: boolean } | null = null;
    #clusters: Clusters | null = null;
    #minSize: number | null = null;
    #scores: number[] | null = null;
    #scoresClass = '';
    #suspects: Suspect[] | null = null;
    #suspectPts = new Set<number>();
    #indexOf = new Map<string, number>();
    /** Paint layers: background first; one colour per layer, so a layer is one fill. */
    #layers: { color: string; big: boolean; pts: Int32Array }[] = [];
    #onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') this.close(); };
    /** Unclustered windows take the colour (lighter) and membership of their nearest cluster. */
    #assign = false;
    #times: { minute: Float64Array; day: Float64Array; known: number } | null = null;
    #dayRange: [number, number] = [0, 0];
    #levelRange: [number, number] = [0, 0];
    #filter = { h0: 0, h1: 24, d0: '', d1: '', minLevel: -Infinity };
    /** 1 = filtered out (not drawn, not pickable, not selectable). */
    #hidden = new Uint8Array(0);

    constructor(opts: EmbeddingMapOptions) {
        this.#opts = opts;
        this.el = document.createElement('div');
        this.el.className = 'emap-overlay';
        this.el.innerHTML = `
            <div class="emap-bar">
                <strong>Embedding map</strong>
                <label>Colour <select class="field-select emap-color">
                    <option value="folder">Folder</option><option value="file">Recording</option><option value="cluster">Cluster</option>
                    <option value="label">Class labels</option><option value="score">Classifier score</option>
                    <option value="time">Time of day</option><option value="date">Date</option>
                </select></label>
                <button class="sidebar-action-btn secondary" data-act="suspects" type="button" title="Find labels of the current class that disagree with their neighbours or the classifier">Check labels</button>
                <span class="emap-sel"></span>
                <span class="emap-status field-hint"></span>
                <span class="emap-spacer"></span>
                <button class="sidebar-action-btn secondary" data-act="recompute" type="button" title="Recompute the layout">Recompute</button>
                <button class="sidebar-action-btn secondary" data-act="close" type="button">Close</button>
            </div>
            <div class="emap-filter" hidden></div>
            <div class="emap-body"><div class="emap-side" hidden></div>
                <div class="emap-stage"><canvas></canvas><div class="emap-tip" hidden></div><div class="emap-legend"></div>
                <p class="emap-help">Scroll: zoom · drag: pan · click: play · double-click: open · Shift+drag: select</p></div></div>`;
        this.#canvas = this.el.querySelector('canvas')!;
        this.#tip = this.el.querySelector('.emap-tip')!;
        this.el.querySelector('.emap-color')!.addEventListener('change', (e) => {
            this.#setColor((e.target as HTMLSelectElement).value as ColorBy);
        });
        this.el.addEventListener('change', (e) => {
            const t = e.target as HTMLSelectElement;
            if (t.classList.contains('emap-assign')) {
                this.#assign = (t as unknown as HTMLInputElement).checked;
                this.#buildLayers();
                this.#renderLegend();
                this.#renderSide();
                this.#draw();
                return;
            }
            if (t.closest('.emap-filter')) {
                this.#readFilter();
                return;
            }
            if (t.classList.contains('emap-minsize')) {
                this.#minSize = t.value ? Number(t.value) : null;
                this.#clusters = null;
                this.#setColor('cluster');
            }
        });
        this.el.addEventListener('input', (e) => {
            if ((e.target as HTMLElement).classList.contains('emap-level')) this.#readFilter();
        });
        this.el.addEventListener('click', (e) => this.#onButton(e));
        this.#bindPointer();
        new ResizeObserver(() => {
            if (this.#fitted && this.#data) this.#fit();
            this.#draw();
        }).observe(this.el.querySelector('.emap-stage')!);
    }

    async open(force = false) {
        if (!this.el.isConnected) document.body.appendChild(this.el);
        document.addEventListener('keydown', this.#onKey);
        this.#setStatus('Computing map…');
        try {
            this.#data = await this.#opts.load(force);
            this.#sel.clear();
            this.#renderSel();
            this.#clusters = null;
            this.#scores = null;
            this.#suspects = null;
            this.#suspectPts.clear();
            const d0 = this.#data;
            this.#indexOf = new Map(d0.file.map((f, i) => [`${f}@${d0.start[i].toFixed(3)}`, i]));
            this.#prepareFilters();
            this.#fit();
            this.#buildGrid();
            if (this.#colorBy === 'cluster' || this.#colorBy === 'score') await this.#ensure(this.#colorBy);
            this.#regroup();
            this.#renderSide();   // new data: cluster cards and label check from the previous map are stale
            const d = this.#data;
            const n = d.x.length;
            this.#setStatus(`${n.toLocaleString()} windows${d.layoutPoints < n ? ` (layout on ${d.layoutPoints.toLocaleString()}, rest placed by neighbours)` : ''}`
                + (d.placedNew ? ` · ${d.placedNew.toLocaleString()} new placed on the existing layout (Recompute for a fresh one)` : ''));
        } catch (e) {
            this.#setStatus(`Error: ${(e as Error)?.message || e}`);
        }
        this.#draw();
    }

    /** Called by the host with progress events while computing. */
    progress(phase: string, frac: number) {
        const names: Record<string, string> = { pca: 'PCA', knn: 'neighbours', layout: 'layout', place: 'placing remaining windows' };
        if (names[phase]) this.#setStatus(`Computing map: ${names[phase]}${phase === 'layout' ? ` ${Math.round(frac * 100)} %` : '…'}`);
    }

    close() {
        document.removeEventListener('keydown', this.#onKey);
        this.el.remove();
    }

    /** Labels or class changed elsewhere (panel) → repaint. */
    refresh() {
        if (!this.el.isConnected) return;
        if (this.#colorBy === 'score' && this.#scoresClass !== this.#opts.getClass()) {
            this.#setColor('score');
            return;
        }
        this.#renderSel();
        this.#regroup();
        this.#renderSide();
        this.#draw();
    }

    /** Switch colouring; loads clusters / scores on demand. */
    async #setColor(c: ColorBy) {
        const sel = this.el.querySelector<HTMLSelectElement>('.emap-color')!;
        try {
            await this.#ensure(c);
            this.#colorBy = c;
        } catch (e) {
            this.#setStatus(`${(e as Error)?.message || e}`);
            this.#colorBy = this.#colorBy === c ? 'folder' : this.#colorBy;
        }
        sel.value = this.#colorBy;
        this.#regroup();
        this.#renderSide();
        this.#draw();
    }

    async #ensure(c: ColorBy) {
        if (!this.#data) return;
        if ((c === 'time' || c === 'date') && !this.#times?.known) {
            throw new Error('No recording times: file names carry no date and time (e.g. 20240512_053000).');
        }
        if (c === 'cluster' && !this.#clusters) {
            this.#setStatus('Clustering…');
            this.#clusters = await this.#opts.loadClusters(this.#minSize);
            const k = this.#clusters;
            this.#setStatus(`${k.clusters.length} clusters (min size ${k.minClusterSize}), ${k.noise.toLocaleString()} windows unassigned`);
        }
        if (c === 'score') {
            const cls = this.#opts.getClass();
            if (!cls) throw new Error('Choose and train a class in the Similar panel first.');
            if (!this.#scores || this.#scoresClass !== cls) {
                this.#setStatus('Scoring…');
                this.#scores = await this.#opts.loadScores();
                this.#scoresClass = cls;
                this.#setStatus(`Classifier scores for “${cls}”`);
            }
        }
    }

    #setStatus(s: string) {
        this.el.querySelector('.emap-status')!.textContent = s;
    }

    // ── Filters ───────────────────────────────────────────────────────

    /** Cluster of a point; unclustered points get their nearest cluster when assignment is on. */
    #clusterOf(i: number): number {
        const k = this.#clusters;
        if (!k) return -1;
        const own = k.labels[i] ?? -1;
        return own >= 0 || !this.#assign ? own : k.nearest?.[i] ?? -1;
    }

    /** New data: recording times, ranges, reset filters. */
    #prepareFilters() {
        const d = this.#data!;
        this.#times = windowTimes(d.files, d.file, d.start);
        let [d0, d1] = [Infinity, -Infinity];
        for (const v of this.#times.day) if (Number.isFinite(v)) { d0 = Math.min(d0, v); d1 = Math.max(d1, v); }
        this.#dayRange = [d0, d1];
        const lv = d.level?.length === d.x.length ? d.level : null;
        let [l0, l1] = [Infinity, -Infinity];
        if (lv) for (const v of lv) if (v > -120) { l0 = Math.min(l0, v); l1 = Math.max(l1, v); }
        this.#levelRange = [Math.floor(l0), Math.ceil(l1)];
        this.#filter = { h0: 0, h1: 24, d0: '', d1: '', minLevel: -Infinity };
        if (!this.#times.known && (this.#colorBy === 'time' || this.#colorBy === 'date')) this.#colorBy = 'folder';
        this.#renderFilter();
        this.#recomputeHidden();
    }

    #renderFilter() {
        const box = this.el.querySelector<HTMLElement>('.emap-filter')!;
        const d = this.#data!;
        const parts: string[] = [];
        const t = this.#times;
        if (t?.known) {
            const hours = (sel: number, from: number) => Array.from({ length: 24 }, (_, k) => k + from)
                .map((h) => `<option value="${h}"${h === sel ? ' selected' : ''}>${String(h).padStart(2, '0')}:00</option>`).join('');
            parts.push(`<label title="Only windows recorded between these hours (wraps past midnight, e.g. 20:00–06:00)">Hours
                <select class="field-select emap-h0">${hours(this.#filter.h0, 0)}</select>–<select class="field-select emap-h1">${hours(this.#filter.h1, 1)}</select></label>`);
            const [lo, hi] = this.#dayRange.map(dayToIso);
            parts.push(`<label title="Only windows recorded on these days">Dates
                <input type="date" class="field-input emap-d0" min="${lo}" max="${hi}" value="${this.#filter.d0 || lo}">–<input type="date" class="field-input emap-d1" min="${lo}" max="${hi}" value="${this.#filter.d1 || hi}"></label>`);
        }
        if (d.level?.length === d.x.length && this.#levelRange[1] > this.#levelRange[0]) {
            const [l0, l1] = this.#levelRange;
            const v = Number.isFinite(this.#filter.minLevel) ? this.#filter.minLevel : l0;
            parts.push(`<label title="Hide windows whose overall level (RMS) is below this value. It does not tell calls from wind, rain or insects: in dense soundscapes quiet windows hold calls as often as loud ones.">Min. level
                <input type="range" class="emap-level" min="${l0}" max="${l1}" step="1" value="${v}"><span class="emap-level-val">${v} dBFS</span></label>`);
        }
        if (!parts.length) {
            box.hidden = true;
            box.innerHTML = '';
            return;
        }
        box.hidden = false;
        box.innerHTML = parts.join('') + '<span class="emap-spacer"></span><span class="emap-shown field-hint"></span>'
            + '<button class="sidebar-action-btn secondary" data-act="filter-reset" type="button">Show all</button>';
    }

    /** Filter controls → #filter → hidden mask, redraw. */
    #readFilter() {
        const q = <T extends HTMLElement>(c: string) => this.el.querySelector<T>(`.emap-filter .${c}`);
        const f = this.#filter;
        f.h0 = Number(q<HTMLSelectElement>('emap-h0')?.value ?? 0);
        f.h1 = Number(q<HTMLSelectElement>('emap-h1')?.value ?? 24);
        f.d0 = q<HTMLInputElement>('emap-d0')?.value ?? '';
        f.d1 = q<HTMLInputElement>('emap-d1')?.value ?? '';
        const lv = q<HTMLInputElement>('emap-level');
        f.minLevel = lv && Number(lv.value) > this.#levelRange[0] ? Number(lv.value) : -Infinity;
        const val = q<HTMLElement>('emap-level-val');
        if (val && lv) val.textContent = `${lv.value} dBFS`;
        this.#recomputeHidden();
        this.#renderSide();
        this.#draw();
    }

    #recomputeHidden() {
        const d = this.#data!;
        const n = d.x.length, f = this.#filter, t = this.#times;
        const hidden = new Uint8Array(n);
        const byHours = !(f.h0 === 0 && f.h1 === 24) && f.h0 !== f.h1;
        const [lo, hi] = [isoToDay(f.d0), isoToDay(f.d1)];
        const byDate = t?.known && ((Number.isFinite(lo) && lo > this.#dayRange[0]) || (Number.isFinite(hi) && hi < this.#dayRange[1]));
        const lv = d.level?.length === n && Number.isFinite(f.minLevel) ? d.level : null;
        let shown = 0;
        for (let i = 0; i < n; i++) {
            let h = 0;
            if (t && (byHours || byDate)) {
                const m = t.minute[i], day = t.day[i];
                if (!Number.isFinite(m)) h = 1;   // no time → cannot satisfy a time filter
                else if (byHours && !inHours(m / 60, f.h0, f.h1)) h = 1;
                else if (byDate && ((Number.isFinite(lo) && day < lo) || (Number.isFinite(hi) && day > hi))) h = 1;
            }
            if (!h && lv && lv[i] < f.minLevel) h = 1;
            hidden[i] = h;
            if (!h) shown++;
        }
        this.#hidden = hidden;
        for (const i of [...this.#sel]) if (hidden[i]) this.#sel.delete(i);
        this.#renderSel();
        const lab = this.el.querySelector('.emap-shown');
        if (lab) lab.textContent = shown === n ? `${n.toLocaleString()} windows` : `${shown.toLocaleString()} of ${n.toLocaleString()} shown`;
    }

    // ── Data helpers ──────────────────────────────────────────────────

    #win(i: number): MapWindow {
        const d = this.#data!;
        return { path: d.files[d.file[i]], start: d.start[i], end: d.start[i] + d.window, score: 0 };
    }

    #regroup() {
        const d = this.#data;
        if (!d) return;
        if (this.#colorBy === 'file') {
            this.#groupNames = d.files;
            this.#groupOf = d.files.map((_, i) => i);
        } else {
            const dirs = new Map<string, number>();
            this.#groupOf = d.files.map((f) => {
                const k = dirOf(f);
                if (!dirs.has(k)) dirs.set(k, dirs.size);
                return dirs.get(k)!;
            });
            this.#groupNames = [...dirs.keys()];
        }
        this.#buildLayers();
        this.#renderLegend();
    }

    /**
     * Group points by colour into paint layers, background (noise, unlabelled, low scores) first.
     * Continuous scales are quantised, so a map of 100 k windows needs only ~100 fills per frame.
     */
    #buildLayers() {
        const d = this.#data!;
        const n = d.x.length;
        const cls = this.#opts.getClass();
        const rank = (i: number): number => {
            switch (this.#colorBy) {
                case 'cluster': return (this.#clusters?.labels[i] ?? -1) >= 0 ? 2 : this.#clusterOf(i) >= 0 ? 1 : 0;
                case 'label': return cls && this.#opts.labelOf(d.files[d.file[i]], d.start[i]) ? 1 : 0;
                case 'score': return Math.round((this.#scores?.[i] ?? 0) * 32);
                default: return 0;
            }
        };
        const groups = new Map<string, { rank: number; color: string; pts: number[] }>();
        for (let i = 0; i < n; i++) {
            const rk = rank(i), color = this.#colorOf(i), key = `${rk}|${color}`;
            let gr = groups.get(key);
            if (!gr) groups.set(key, gr = { rank: rk, color, pts: [] });
            gr.pts.push(i);
        }
        const byLabel = this.#colorBy === 'label';
        this.#layers = [...groups.values()].sort((a, b) => a.rank - b.rank)
            .map((gr) => ({ color: gr.color, big: byLabel && gr.color !== UNLABELED, pts: Int32Array.from(gr.pts) }));
    }

    #colorOf(i: number): string {
        const d = this.#data!;
        switch (this.#colorBy) {
            case 'cluster': {
                const own = this.#clusters?.labels[i] ?? -1;
                if (own >= 0) return PALETTE[own % PALETTE.length];
                const c = this.#clusterOf(i);
                return c < 0 ? NOISE : withAlpha(PALETTE[c % PALETTE.length], 0.4);
            }
            case 'time': {   // quarter hours
                const m = this.#times?.minute[i] ?? NaN;
                return Number.isFinite(m) ? timeColor(Math.round(m / 15) / 4) : NOISE;
            }
            case 'date': {   // 48 steps
                const day = this.#times?.day[i] ?? NaN;
                const [d0, d1] = this.#dayRange;
                return Number.isFinite(day) ? seqColor(d1 > d0 ? Math.round(((day - d0) / (d1 - d0)) * 48) / 48 : 0.5) : NOISE;
            }
            case 'label': {
                const cls = this.#opts.getClass();
                const l = cls ? this.#opts.labelOf(d.files[d.file[i]], d.start[i]) : null;
                return l ? LABEL_COLOR[l] : UNLABELED;
            }
            case 'score': return this.#scores ? scoreColor(Math.round(this.#scores[i] * 32) / 32) : UNLABELED;
            default: return PALETTE[this.#groupOf[d.file[i]] % PALETTE.length];
        }
    }

    #renderLegend() {
        const leg = this.el.querySelector('.emap-legend')!;
        if (this.#colorBy === 'score') {
            leg.innerHTML = `<b>${esc(this.#scoresClass)}</b> score<div class="emap-grad" style="background:linear-gradient(90deg,${scoreColor(0)},${scoreColor(0.5)},${scoreColor(1)})"></div>`
                + '<div class="emap-grad-scale"><span>0</span><span>0.5</span><span>1</span></div>';
            return;
        }
        if (this.#colorBy === 'cluster') {
            const k = this.#clusters;
            const left = k ? k.labels.reduce((a, l, i) => a + (l < 0 && this.#clusterOf(i) < 0 ? 1 : 0), 0) : 0;
            leg.innerHTML = k ? `${k.clusters.length} clusters${left ? `<div><i style="background:${NOISE}"></i>unassigned</div>` : ''}` : '';
            return;
        }
        if (this.#colorBy === 'time') {
            const g = Array.from({ length: 9 }, (_, k) => timeColor(k * 3)).join(',');
            leg.innerHTML = `<b>Time of day</b><div class="emap-grad" style="background:linear-gradient(90deg,${g})"></div>`
                + '<div class="emap-grad-scale"><span>0</span><span>6</span><span>12</span><span>18</span><span>24 h</span></div>';
            return;
        }
        if (this.#colorBy === 'date') {
            const g = Array.from({ length: 5 }, (_, k) => seqColor(k / 4)).join(',');
            leg.innerHTML = `<b>Date</b><div class="emap-grad" style="background:linear-gradient(90deg,${g})"></div>`
                + `<div class="emap-grad-scale"><span>${dayToIso(this.#dayRange[0])}</span><span>${dayToIso(this.#dayRange[1])}</span></div>`;
            return;
        }
        if (this.#colorBy === 'label') {
            const cls = this.#opts.getClass();
            leg.innerHTML = cls
                ? `<b>${esc(cls)}</b>${(['pos', 'neg', 'unsure'] as Label[]).map((l) => `<div><i style="background:${LABEL_COLOR[l]}"></i>${l}</div>`).join('')}`
                : 'No class selected in the Similar panel.';
            return;
        }
        const names = this.#groupNames;
        const shown = names.slice(0, 12).map((nm, i) =>
            `<div title="${esc(nm)}"><i style="background:${PALETTE[i % PALETTE.length]}"></i>${esc(this.#colorBy === 'folder' ? folderLabel(nm) : nm.split('/').pop() || nm)}</div>`).join('');
        leg.innerHTML = shown + (names.length > 12 ? `<div class="field-hint">+${names.length - 12} more (colours repeat)</div>` : '');
    }

    #buildGrid() {
        const d = this.#data!;
        this.#grid.clear();
        for (let i = 0; i < d.x.length; i++) {
            const key = Math.floor(d.x[i] * 100) * 1000 + Math.floor(d.y[i] * 100);
            let cell = this.#grid.get(key);
            if (!cell) this.#grid.set(key, cell = []);
            cell.push(i);
        }
    }

    /** Centre the data and zoom so its bounding box fills the canvas. */
    #fit() {
        const d = this.#data!;
        this.#cx = this.#cy = 0.5;
        this.#scale = this.#fitScale = 1;
        if (!d.x.length) return;
        this.#fitTo(d.x.map((_, i) => i));
        this.#fitScale = this.#scale;
        this.#fitted = true;
    }

    /** Zoom to the given points (with some margin; a single point gets a close-up). */
    #fitTo(pts: number[]) {
        const d = this.#data!;
        if (!pts.length) return;
        let [x0, x1, y0, y1] = [Infinity, -Infinity, Infinity, -Infinity];
        for (const i of pts) {
            x0 = Math.min(x0, d.x[i]); x1 = Math.max(x1, d.x[i]);
            y0 = Math.min(y0, d.y[i]); y1 = Math.max(y1, d.y[i]);
        }
        const { w, h, s } = this.#size();
        if (!w || !h) return;
        const minSpan = 0.03;
        this.#fitted = false;
        this.#cx = (x0 + x1) / 2;
        this.#cy = (y0 + y1) / 2;
        this.#scale = 0.9 * Math.min(w / Math.max(minSpan, x1 - x0), h / Math.max(minSpan, y1 - y0)) / s;
    }

    // ── View transform ────────────────────────────────────────────────

    #size() {
        const r = this.#canvas.getBoundingClientRect();
        return { w: r.width, h: r.height, s: Math.min(r.width, r.height) * 0.92 };
    }
    #toScreen(x: number, y: number): [number, number] {
        const { w, h, s } = this.#size();
        return [(x - this.#cx) * s * this.#scale + w / 2, (y - this.#cy) * s * this.#scale + h / 2];
    }
    #toData(sx: number, sy: number): [number, number] {
        const { w, h, s } = this.#size();
        return [(sx - w / 2) / (s * this.#scale) + this.#cx, (sy - h / 2) / (s * this.#scale) + this.#cy];
    }

    /** Nearest point within `px` screen pixels, or -1. */
    #pick(sx: number, sy: number, px = 8): number {
        const d = this.#data;
        if (!d) return -1;
        const [x, y] = this.#toData(sx, sy);
        const r = px / (this.#size().s * this.#scale);
        let best = -1, bestD = r * r;
        for (let gx = Math.floor((x - r) * 100); gx <= Math.floor((x + r) * 100); gx++) {
            for (let gy = Math.floor((y - r) * 100); gy <= Math.floor((y + r) * 100); gy++) {
                for (const i of this.#grid.get(gx * 1000 + gy) || []) {
                    const dd = (d.x[i] - x) ** 2 + (d.y[i] - y) ** 2;
                    if (dd < bestD && !this.#hidden[i]) { bestD = dd; best = i; }
                }
            }
        }
        return best;
    }

    // ── Drawing ───────────────────────────────────────────────────────

    #draw() {
        const c = this.#canvas;
        const { w, h } = this.#size();
        if (!w || !h) return;
        const dpr = window.devicePixelRatio || 1;
        if (c.width !== Math.round(w * dpr) || c.height !== Math.round(h * dpr)) {
            c.width = Math.round(w * dpr);
            c.height = Math.round(h * dpr);
        }
        const g = c.getContext('2d')!;
        g.setTransform(dpr, 0, 0, dpr, 0, 0);
        g.clearRect(0, 0, w, h);
        const d = this.#data;
        if (!d) return;
        const n = d.x.length;
        const base = Math.max(1.5, 7 - 1.2 * Math.log10(Math.max(10, n)));   // 160 → ~4.4, 100 k → ~1.5
        const r = Math.min(8, base * Math.sqrt(Math.max(1, this.#scale / this.#fitScale)));
        g.globalAlpha = this.#colorBy === 'label' || this.#colorBy === 'score' ? 1 : 0.8;
        const hidden = this.#hidden.length === n ? this.#hidden : null;
        // screen = data * k + o (same as #toScreen, without a layout query per point)
        const k = this.#size().s * this.#scale, ox = w / 2 - this.#cx * k, oy = h / 2 - this.#cy * k;
        for (const L of this.#layers) {
            const rr = L.big ? r * 1.6 : r, hr = rr / 2;
            g.fillStyle = L.color;
            g.beginPath();
            for (const i of L.pts) {
                if (hidden?.[i]) continue;
                const sx = d.x[i] * k + ox, sy = d.y[i] * k + oy;
                if (sx < -5 || sy < -5 || sx > w + 5 || sy > h + 5) continue;
                g.rect(sx - hr, sy - hr, rr, rr);
            }
            g.fill();
        }
        g.globalAlpha = 1;
        g.strokeStyle = SUSPECT;
        g.lineWidth = 2;
        for (const i of this.#suspectPts) {
            const [sx, sy] = this.#toScreen(d.x[i], d.y[i]);
            g.beginPath();
            g.arc(sx, sy, r + 3, 0, Math.PI * 2);
            g.stroke();
        }
        // Selection, hover and lasso in the text colour, so they show on both themes.
        g.strokeStyle = getComputedStyle(this.el).color || '#888';
        g.lineWidth = 1;
        g.beginPath();
        for (const i of this.#sel) g.rect(d.x[i] * k + ox - r, d.y[i] * k + oy - r, r * 2, r * 2);
        g.stroke();
        if (this.#hover >= 0) {
            const [sx, sy] = this.#toScreen(d.x[this.#hover], d.y[this.#hover]);
            g.beginPath();
            g.arc(sx, sy, r + 4, 0, Math.PI * 2);
            g.stroke();
        }
        if (this.#lasso && this.#lasso.length > 1) {
            g.setLineDash([4, 3]);
            g.beginPath();
            this.#lasso.forEach(([x, y], k) => (k ? g.lineTo(x, y) : g.moveTo(x, y)));
            g.closePath();
            g.stroke();
            g.setLineDash([]);
        }
    }

    // ── Interaction ───────────────────────────────────────────────────

    #local(e: MouseEvent): [number, number] {
        const r = this.#canvas.getBoundingClientRect();
        return [e.clientX - r.left, e.clientY - r.top];
    }

    #bindPointer() {
        const c = this.#canvas;
        c.addEventListener('wheel', (e) => {
            e.preventDefault();
            const [sx, sy] = this.#local(e);
            const [x, y] = this.#toData(sx, sy);
            this.#scale = Math.min(200, Math.max(0.5, this.#scale * Math.exp(-e.deltaY * 0.0015)));
            const [x2, y2] = this.#toData(sx, sy);
            this.#cx += x - x2;
            this.#cy += y - y2;
            this.#fitted = false;
            this.#draw();
        }, { passive: false });
        c.addEventListener('pointerdown', (e) => {
            c.setPointerCapture(e.pointerId);
            const [sx, sy] = this.#local(e);
            if (e.shiftKey) this.#lasso = [[sx, sy]];
            else this.#drag = { x: sx, y: sy, cx: this.#cx, cy: this.#cy, moved: false };
        });
        c.addEventListener('pointermove', (e) => {
            const [sx, sy] = this.#local(e);
            if (this.#lasso) {
                this.#lasso.push([sx, sy]);
                this.#draw();
                return;
            }
            if (this.#drag) {
                const dx = sx - this.#drag.x, dy = sy - this.#drag.y;
                if (Math.abs(dx) + Math.abs(dy) > 3) this.#drag.moved = true;
                if (this.#drag.moved) {
                    const s = this.#size().s * this.#scale;
                    this.#cx = this.#drag.cx - dx / s;
                    this.#cy = this.#drag.cy - dy / s;
                    this.#fitted = false;
                    this.#draw();
                    return;
                }
            }
            const i = this.#pick(sx, sy);
            if (i !== this.#hover) {
                this.#hover = i;
                this.#draw();
            }
            this.#showTip(i, sx, sy);
        });
        c.addEventListener('pointerup', (e) => {
            const [sx, sy] = this.#local(e);
            if (this.#lasso) {
                this.#finishLasso(e.altKey);
                return;
            }
            const drag = this.#drag;
            this.#drag = null;
            if (drag && !drag.moved) {
                const i = this.#pick(sx, sy);
                if (i >= 0) Promise.resolve(this.#opts.openHit(this.#win(i), true)).catch((err) => this.#setStatus(`${err}`));
            }
        });
        c.addEventListener('dblclick', (e) => {
            const i = this.#pick(...this.#local(e));
            if (i < 0) return;
            this.close();
            Promise.resolve(this.#opts.openHit(this.#win(i), false)).catch(() => {});
        });
        c.addEventListener('pointerleave', () => {
            this.#hover = -1;
            this.#tip.hidden = true;
            this.#draw();
        });
    }

    #showTip(i: number, sx: number, sy: number) {
        if (i < 0) {
            this.#tip.hidden = true;
            return;
        }
        const w = this.#win(i);
        const cls = this.#opts.getClass();
        const l = cls ? this.#opts.labelOf(w.path, w.start) : null;
        const c = this.#clusters?.labels[i];
        const sc = this.#scores && this.#scoresClass === cls ? this.#scores[i] : null;
        this.#tip.innerHTML = `${esc(w.path)}<br>${fmtTime(w.start)}–${fmtTime(w.end)}`
            + (c != null ? `<br>${c >= 0 ? `cluster #${c}` : this.#clusterOf(i) >= 0 ? `no cluster (nearest #${this.#clusterOf(i)})` : 'no cluster'}` : '')
            + (l ? `<br>${esc(cls)}: ${l}` : '')
            + (sc != null ? `<br>score ${sc.toFixed(2)}` : '')
            + (this.#times && Number.isFinite(this.#times.minute[i])
                ? `<br>${dayToIso(this.#times.day[i])} ${String(Math.floor(this.#times.minute[i] / 60)).padStart(2, '0')}:${String(Math.floor(this.#times.minute[i] % 60)).padStart(2, '0')}` : '')
            + (this.#data?.level?.length ? `<br>${this.#data.level[i].toFixed(1)} dBFS` : '');
        this.#tip.hidden = false;
        const { w: cw, h: ch } = this.#size();
        const tw = this.#tip.offsetWidth, th = this.#tip.offsetHeight;
        this.#tip.style.left = `${sx + 14 + tw > cw ? Math.max(0, sx - 14 - tw) : sx + 14}px`;
        this.#tip.style.top = `${sy + 14 + th > ch ? Math.max(0, sy - 14 - th) : sy + 14}px`;
    }

    /** Lasso done: replace the selection (Alt: add to it). */
    #finishLasso(add: boolean) {
        const poly = this.#lasso!;
        this.#lasso = null;
        const d = this.#data;
        if (d && poly.length > 2) {
            if (!add) this.#sel.clear();
            const { w, h, s } = this.#size();
            const k = s * this.#scale, ox = w / 2 - this.#cx * k, oy = h / 2 - this.#cy * k;
            for (let i = 0; i < d.x.length; i++) {
                if (!this.#hidden[i] && inPolygon(d.x[i] * k + ox, d.y[i] * k + oy, poly)) this.#sel.add(i);
            }
        }
        this.#renderSel();
        this.#draw();
    }

    #renderSel() {
        const box = this.el.querySelector('.emap-sel')!;
        const n = this.#sel.size;
        if (!n) {
            box.innerHTML = '';
            return;
        }
        const cls = this.#opts.getClass();
        box.innerHTML = `${n.toLocaleString()} selected`
            + (cls ? ` · label as “${esc(cls)}”: <button class="sim-lbl pos" data-act="sel-label" data-l="pos" type="button" title="Positive">✓</button>`
                + '<button class="sim-lbl neg" data-act="sel-label" data-l="neg" type="button" title="Negative">✗</button>'
                + '<button class="sim-lbl unsure" data-act="sel-label" data-l="unsure" type="button" title="Unsure">?</button>'
                + '<button class="sim-icon-btn" data-act="sel-label" data-l="" type="button" title="Remove labels">⌫</button>'
                : ' (choose a class in the Similar panel to label them)')
            + ' <button class="sim-icon-btn" data-act="sel-clear" type="button" title="Clear selection">×</button>';
    }

    async #onButton(e: MouseEvent) {
        const btn = (e.target as Element).closest<HTMLElement>('[data-act]');
        if (!btn) return;
        switch (btn.dataset.act) {
            case 'close': this.close(); break;
            case 'recompute': this.open(true); break;
            case 'sel-clear': this.#sel.clear(); this.#renderSel(); this.#draw(); break;
            case 'filter-reset':
                this.#filter = { h0: 0, h1: 24, d0: '', d1: '', minLevel: -Infinity };
                this.#renderFilter();
                this.#recomputeHidden();
                this.#renderSide();
                this.#draw();
                break;
            case 'play': {
                const i = Number(btn.dataset.i);
                Promise.resolve(this.#opts.openHit(this.#win(i), true)).catch((err) => this.#setStatus(`${err}`));
                break;
            }
            case 'cl-select':
            case 'cl-zoom': {
                const c = Number(btn.dataset.c);
                const own = this.#clusters?.labels || [];
                // c = −1 selects the unassigned windows; with assignment on, clusters include their assigned ones.
                const pts = own.flatMap((l, i) => ((c < 0 ? l < 0 && this.#clusterOf(i) < 0 : this.#clusterOf(i) === c) && !this.#hidden[i] ? [i] : []));
                if (btn.dataset.act === 'cl-select') {
                    this.#sel = new Set(pts);
                    this.#renderSel();
                } else this.#fitTo(pts);
                this.#draw();
                break;
            }
            case 'suspects': this.#checkLabels(); break;
            case 'show': {
                const i = Number(btn.dataset.i);
                this.#fitTo([i]);
                this.#sel = new Set([i]);
                this.#renderSel();
                this.#draw();
                break;
            }
            case 'side-close': this.#suspects = null; this.#suspectPts.clear(); this.#renderSide(); this.#draw(); break;
            case 'sel-label': {
                const items = [...this.#sel].map((i) => this.#win(i));
                const label = (btn.dataset.l || null) as Label | null;
                try {
                    await this.#opts.setLabels(items.map(({ path, start }) => ({ path, start })), label);
                    this.#setStatus(`${label ? `Labelled ${items.length} windows “${label}”` : `Removed labels from ${items.length} windows`}`);
                } catch (err) {
                    this.#setStatus(`Error: ${(err as Error)?.message || err}`);
                }
                this.#draw();
                break;
            }
        }
    }

    // ── Side panel: cluster cards and label check ─────────────────────

    async #checkLabels() {
        if (!this.#opts.getClass()) {
            this.#setStatus('Choose a class in the Similar panel first.');
            return;
        }
        this.#setStatus('Checking labels…');
        try {
            this.#suspects = await this.#opts.loadSuspects();
            this.#suspectPts = new Set(this.#suspects.map((x) => this.#pointOf(x.path, x.start)).filter((i) => i >= 0));
            this.#setStatus(`${this.#suspects.length} label${this.#suspects.length === 1 ? '' : 's'} to double-check`);
        } catch (e) {
            this.#setStatus(`${(e as Error)?.message || e}`);
        }
        this.#renderSide();
        this.#draw();
    }

    #pointOf(path: string, start: number): number {
        const d = this.#data;
        if (!d) return -1;
        const f = d.files.indexOf(path);
        return f < 0 ? -1 : this.#indexOf.get(`${f}@${start.toFixed(3)}`) ?? -1;
    }

    #renderSide() {
        const side = this.el.querySelector<HTMLElement>('.emap-side')!;
        const parts: string[] = [];
        if (this.#suspects) parts.push(this.#renderSuspects());
        if (this.#colorBy === 'cluster' && this.#clusters) parts.push(this.#renderClusters());
        side.hidden = !parts.length;
        const scroll = side.scrollTop;
        side.innerHTML = parts.join('');
        side.scrollTop = scroll;
    }

    #renderClusters(): string {
        const d = this.#data!, k = this.#clusters!;
        const cls = this.#opts.getClass();
        const sizes = [null, 5, 10, 20, 50, 100];
        const opts = sizes.map((v) => `<option value="${v ?? ''}"${v === this.#minSize ? ' selected' : ''}>${v == null ? `Auto (${k.minClusterSize})` : v}</option>`).join('');
        const members = new Map<number, number[]>();
        k.labels.forEach((_, i) => {
            const l = this.#clusterOf(i);
            if (l >= 0) (members.get(l) || members.set(l, []).get(l)!).push(i);
        });
        const oneFolder = new Set(d.files.map(dirOf)).size <= 1;
        const nAssigned = this.#assign ? k.labels.filter((l, i) => l < 0 && this.#clusterOf(i) >= 0).length : 0;
        const cards = k.clusters.map((c) => {
            const pts = members.get(c.id) || [];
            // Make-up by folder; meaningless when the project has only one folder.
            const make = oneFolder ? '' : topShares(pts.map((i) => dirOf(d.files[d.file[i]])))
                .map((x) => `${esc(folderLabel(x.key))} ${Math.round(x.share * 100)} %`).join(', ');
            let lab = '';
            if (cls) {
                let pos = 0, neg = 0;
                for (const i of pts) {
                    const l = this.#opts.labelOf(d.files[d.file[i]], d.start[i]);
                    if (l === 'pos') pos++; else if (l === 'neg') neg++;
                }
                if (pos || neg) lab = `<div class="field-hint">${esc(cls)}: ${pos} ✓ · ${neg} ✗</div>`;
            }
            const ex = c.exemplars.map((i, n) => `<button class="sim-play" data-act="play" data-i="${i}" type="button" title="Typical window ${n + 1}: ${esc(d.files[d.file[i]])} @ ${fmtTime(d.start[i])}">▶</button>`).join('');
            return `<div class="emap-card">
                <div class="emap-card-head"><i style="background:${PALETTE[c.id % PALETTE.length]}"></i><b>#${c.id}</b>
                    <span>${c.size.toLocaleString()} windows${this.#assign && pts.length > c.size ? ` <span class="field-hint">+ ${(pts.length - c.size).toLocaleString()} assigned</span>` : ''}</span><span class="emap-spacer"></span>
                    <button class="sim-icon-btn" data-act="cl-zoom" data-c="${c.id}" type="button" title="Zoom to cluster">⌖</button>
                    <button class="sim-icon-btn" data-act="cl-select" data-c="${c.id}" type="button" title="Select (then label in the top bar)">☐</button></div>
                <div class="field-hint">${make}</div>${lab}
                <div class="emap-ex">${ex}</div></div>`;
        }).join('');
        return `<div class="emap-side-sec"><div class="emap-card-head"><b>Clusters</b><span class="emap-spacer"></span>
                <label class="field-hint">min size <select class="field-select emap-minsize">${opts}</select></label></div>
            <p class="field-hint">${k.clusters.length} clusters · ${(k.noise - nAssigned).toLocaleString()} windows unassigned
                ${k.noise - nAssigned ? '<button class="sim-icon-btn" data-act="cl-select" data-c="-1" type="button" title="Select unassigned windows">☐</button>' : ''}</p>
            ${k.noise && k.nearest ? `<label class="field-hint emap-assign-row" title="Give every unassigned window the cluster whose centre is most similar (shown lighter)">
                <input type="checkbox" class="emap-assign"${this.#assign ? ' checked' : ''}> Assign unassigned windows to their nearest cluster</label>` : ''}
            ${cards}</div>`;
    }

    #renderSuspects(): string {
        const list = this.#suspects!;
        const rows = list.slice(0, 200).map((x) => {
            const i = this.#pointOf(x.path, x.start);
            const why = [x.neighbours >= 3 && x.otherFrac >= 0.6 ? `${Math.round(x.otherFrac * 100)} % of neighbours ${x.label === 'pos' ? '✗' : '✓'}` : '',
                x.score != null ? `score ${x.score.toFixed(2)}` : ''].filter(Boolean).join(' · ');
            return `<li class="sim-hit">
                ${i >= 0 ? `<button class="sim-play" data-act="play" data-i="${i}" type="button" title="Play">▶</button>` : ''}
                <button class="sim-open" ${i >= 0 ? `data-act="show" data-i="${i}"` : 'disabled'} type="button" title="${esc(x.path)} — show on the map">
                    <span class="sim-file">${esc(x.path.split('/').pop() || x.path)}</span><span class="sim-time">${fmtTime(x.start)}</span></button>
                <span class="sim-lbl ${x.label} on">${x.label === 'pos' ? '✓' : '✗'}</span>
                <div class="field-hint emap-why">${why}</div></li>`;
        }).join('');
        return `<div class="emap-side-sec"><div class="emap-card-head"><b>Label check “${esc(this.#opts.getClass())}”</b><span class="emap-spacer"></span>
                <button class="sim-icon-btn" data-act="side-close" type="button" title="Hide">×</button></div>
            <p class="field-hint">${list.length ? 'Labelled windows whose nearest labelled neighbours mostly carry the other label, or that the classifier scores very differently. Select one and relabel in the top bar.' : 'No conflicting labels found.'}</p>
            <ol class="sim-list">${rows}</ol></div>`;
    }
}
