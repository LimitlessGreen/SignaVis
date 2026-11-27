// ═══════════════════════════════════════════════════════════════════════
// ui/panels/similar-panel.ts — Perch-2 embeddings, "find similar" and
// agile modelling (label windows → linear classifier → review → export).
// SignaVis Lite only.
//
// Talks to src-tauri-lite/src/embeddings.rs:
//   embed_model_status / embed_model_download   (event lite-embed-model)
//   embed_info / embed_start / embed_cancel     (event lite-embed-progress)
//   embed_similar                               (top-k windows)
//   embed_map / embed_clusters                  (2-D map + HDBSCAN, event lite-map-progress)
// and src-tauri-lite/src/agile.rs:
//   agile_labels / agile_class_add / agile_class_remove / agile_label_set(_many)
//   agile_train / agile_classifier_info / agile_rank / agile_export
//   agile_scores / agile_suspects               (map colouring, label check)
// The host page supplies the project root, the query (selection/playhead)
// and how to open + play a hit.
// ═══════════════════════════════════════════════════════════════════════

import { appConfirm, appPrompt } from '../components/modal/dialogs.ts';
import { showContextMenu } from '../components/context-menu/context-menu.ts';
import { formatMinSecTenths } from '../../shared/utils.ts';
import { clickTile } from '../../app/similar-marks.ts';
import { heatLut, thumbPixels } from '../../domain/catalog/thumb-grid.ts';
import { EmbeddingMap, type EmbeddingMapHost, type Clusters, type MapData, type Suspect } from './embedding-map.ts';

type Invoke = <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>;

interface ModelStatus { present: boolean; path: string; size: number }
interface StoreInfo { exists: boolean; hopS: number; files: number; windows: number; failed: Record<string, string>; running: boolean }
interface JobProgress {
    root: string; phase: string; done: number; total: number; current: string | null;
    windows: number; audioSeconds: number; device: string; error: string | null; failed: number;
}
export interface SimilarHit { path: string; start: number; end: number; score: number; label?: string | null }
export interface SimilarQuery { path: string; start: number; end: number }
type Label = 'pos' | 'neg' | 'unsure';
interface AgileClass { name: string; examples: { path: string; start: number; label: Label }[] }
interface LabelsFile { version: number; classes: AgileClass[] }
interface TrainResult {
    positives: number; negatives: number; background: number; missing: number;
    cvAccuracy: number | null; cvPrecision: number | null; cvRecall: number | null;
}
interface ClassifierInfo { trained: boolean; positives: number; negatives: number; background: number; trainedAt: string | null }
interface RankResult { hits: SimilarHit[]; above: number; total: number }

export interface SimilarPanelOptions {
    /** Absolute project folder, or null when no folder project is open. */
    getRoot: () => string | null;
    /** Query window: current selection, else playhead, in the active recording. */
    getQuery: () => SimilarQuery | null;
    /** Open the hit's recording (if needed) and play / show the window. */
    openHit: (hit: SimilarHit, play: boolean) => Promise<void> | void;
    /** Project-side context of a recording (manual place, XC metadata) for the map's site colouring. */
    contextOf?: (path: string) => { manual?: unknown; xc?: unknown } | null;
    /** Lite spaces: the map opens in its panel instead of covering the window. */
    mapHost?: EmbeddingMapHost;
    /** The store was (re)read: e.g. offer the Embeddings space once there are windows. */
    onInfo?: (info: { windows: number } | null) => void;
    /** Keep the picked hits as labels (template species, time only); returns a status line. */
    markHits?: (hits: SimilarHit[], polarity: 'present' | 'absent') => Promise<string> | string;
    /** Own label already on a hit window (shown on the tile). */
    markOf?: (hit: SimilarHit) => { name: string; absent: boolean } | null;
    /** Make the hits' recordings the view (Browse/Annotate); returns a status line. */
    hitsToView?: (paths: string[]) => Promise<string> | string;
}

interface Tile { w: number; h: number; maxHz: number; data: number[]; error: string | null }
/** Tile spectrogram size (drawn scaled to the tile width). */
const TILE_SPEC = { w: 160, h: 54, maxHz: 12_000 };
const tileKey = (h: { path: string; start: number }) => `${h.path}@${h.start.toFixed(3)}`;

const WINDOW_S = 5;
const LABEL_ICON: Record<Label, string> = { pos: '✓', neg: '✗', unsure: '?' };
const LABEL_TITLE: Record<Label, string> = { pos: 'Positive', neg: 'Negative', unsure: 'Unsure (ignored in training)' };
const fmtTime = formatMinSecTenths;
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));

/** Right-click menu for a result row. `current` is the hit's label in the selected class (null: none / no class). */
export function similarHitMenuItems(h: SimilarHit, current: Label | null | undefined, act: {
    play: () => void; open: () => void; label: (l: Label) => void; copy: (text: string) => void; query: () => void;
}, hasClass = current !== undefined) {
    const file = h.path.split('/').pop() || h.path;
    const items: { label?: string; action?: () => void; separator?: boolean }[] = [
        { label: 'Play', action: act.play },
        { label: 'Open in spectrogram', action: act.open },
        { label: 'Find similar to this', action: act.query },
    ];
    if (hasClass) {
        items.push({ separator: true });
        for (const l of ['pos', 'neg', 'unsure'] as Label[]) {
            items.push({ label: `${current === l ? 'Clear' : 'Mark'} ${LABEL_TITLE[l].split(' ')[0].toLowerCase()}`, action: () => act.label(l) });
        }
    }
    items.push({ separator: true },
        { label: `Copy “${file} @ ${fmtTime(h.start)}”`, action: () => act.copy(`${h.path}\t${h.start.toFixed(2)}\t${h.end.toFixed(2)}`) },
        { label: 'Copy file path', action: () => act.copy(h.path) });
    return items;
}
const errText = (e: unknown) => `${(e as Error)?.message || e}`;

export class SimilarPanel {
    el: HTMLElement;
    #opts: SimilarPanelOptions;
    #invoke: Promise<Invoke>;
    #model: ModelStatus | null = null;
    #info: StoreInfo | null = null;
    #job: JobProgress | null = null;
    #downloading: { bytes: number; total: number } | null = null;
    #hits: SimilarHit[] = [];
    #query: SimilarQuery | null = null;
    #listKind: 'similar' | 'rank' = 'similar';
    #status = '';
    /** Result of the last ✓ / ✕ / → View, shown in the action bar. */
    #barMsg = '';
    #busy = '';
    #listening = false;
    // agile modelling
    #labels: LabelsFile = { version: 1, classes: [] };
    #cls = '';
    #clfInfo: ClassifierInfo | null = null;
    #train: TrainResult | null = null;
    #rank: RankResult | null = null;
    #rankMode = 'top';
    #threshold = 0.5;
    #k = 50;
    #map: EmbeddingMap | null = null;
    // tile grid: picked hits, spectrogram tiles (by path@start)
    #sel = { sel: new Set<number>(), anchor: -1 };
    #tiles = new Map<string, ImageData | null>();
    #tilesLoading = false;
    #lut = heatLut();

    constructor(opts: SimilarPanelOptions) {
        this.#opts = opts;
        this.#invoke = import('@tauri-apps/api/core').then((m) => m.invoke as Invoke);
        this.el = document.createElement('div');
        this.el.className = 'scroll-panel similar-panel';
        this.el.addEventListener('click', (e) => this.#onClick(e));
        this.el.addEventListener('contextmenu', (e) => this.#onContextMenu(e));
        this.el.addEventListener('change', (e) => this.#onChange(e));
        this.el.addEventListener('input', (e) => {
            if ((e.target as HTMLElement).id === 'simThr') this.#onChange(e);
        });
        this.#render();
    }

    async #call<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
        return (await this.#invoke)<T>(cmd, args);
    }

    async #listen() {
        if (this.#listening) return;
        this.#listening = true;
        const { listen } = await import('@tauri-apps/api/event');
        await listen<{ bytes: number; total: number }>('lite-embed-model', (e) => {
            this.#downloading = e.payload;
            this.#render();
        });
        await listen<JobProgress>('lite-embed-progress', (e) => {
            if (e.payload.root !== this.#opts.getRoot()) return;
            this.#job = e.payload;
            if (['done', 'cancelled', 'error'].includes(e.payload.phase)) this.refresh();
            else this.#render();
        });
        await listen<{ root: string; phase: string; frac: number }>('lite-map-progress', (e) => {
            if (e.payload.root === this.#opts.getRoot()) this.#map?.progress(e.payload.phase, e.payload.frac);
        });
    }

    /** Reload model, store, labels and classifier status (on activate / project switch). */
    async refresh() {
        await this.#listen();
        try {
            this.#model = await this.#call<ModelStatus>('embed_model_status');
            const root = this.#opts.getRoot();
            this.#info = root ? await this.#call<StoreInfo>('embed_info', { root }) : null;
            if (this.#info && !this.#info.running && this.#job?.phase === 'running') this.#job = null;
            this.#opts.onInfo?.(this.#info);
            if (root) {
                this.#labels = await this.#call<LabelsFile>('agile_labels', { root });
                if (!this.#labels.classes.some((c) => c.name === this.#cls)) this.#cls = this.#labels.classes[0]?.name || '';
                this.#clfInfo = this.#cls ? await this.#call<ClassifierInfo>('agile_classifier_info', { root, class: this.#cls }) : null;
            }
        } catch (e) {
            this.#status = `Error: ${errText(e)}`;
        }
        this.#render();
    }

    async #run(what: string, fn: () => Promise<void>) {
        this.#busy = what;
        this.#status = '';
        this.#render();
        try {
            await fn();
        } catch (e) {
            this.#status = errText(e);
        }
        this.#busy = '';
        this.#render();
    }

    // ── Model + embeddings ────────────────────────────────────────────

    async #download() {
        this.#downloading = { bytes: 0, total: this.#model?.size || 1 };
        this.#status = '';
        this.#render();
        try {
            this.#model = await this.#call<ModelStatus>('embed_model_download');
        } catch (e) {
            this.#status = `Download failed: ${errText(e)}`;
        }
        this.#downloading = null;
        this.refresh();
    }

    async #start() {
        const root = this.#opts.getRoot();
        if (!root) return;
        const hop = Number((this.el.querySelector('#simHop') as HTMLSelectElement)?.value || WINDOW_S);
        if (this.#info?.exists && Math.abs(this.#info.hopS - hop) > 1e-9 && this.#info.windows > 0) {
            const ok = await appConfirm(`Changing the hop from ${this.#info.hopS} s to ${hop} s recomputes all embeddings. `
                + 'Labels on windows that no longer exist are ignored in training. Continue?');
            if (!ok) return;
        }
        this.#status = '';
        this.#job = { root, phase: 'starting', done: 0, total: 0, current: null, windows: 0, audioSeconds: 0, device: '', error: null, failed: 0 };
        this.#render();
        try {
            await this.#call('embed_start', { root, hopS: hop });
        } catch (e) {
            this.#job = null;
            this.#status = errText(e);
            this.#render();
        }
    }

    /** Start of the embedding window that best covers the query (centred on it). */
    #windowStart(q: SimilarQuery): number {
        const hop = this.#info?.hopS || WINDOW_S;
        const mid = (q.start + q.end) / 2;
        const ideal = Math.max(0, mid - WINDOW_S / 2);
        return Math.round(Math.round(ideal / hop) * hop * 1e6) / 1e6;
    }

    /** Search for a given span (e.g. a label: "find similar in project") instead of the selection. */
    async searchFor(q: SimilarQuery) {
        await this.refresh();
        await this.#search(q);
    }

    async #search(query: SimilarQuery | null = null) {
        const root = this.#opts.getRoot();
        const q = query || this.#opts.getQuery();
        if (!root) return;
        if (!q) {
            this.#status = 'Select a region (or place the playhead) in a project recording first.';
            this.#render();
            return;
        }
        await this.#run('Searching…', async () => {
            this.#setHits(await this.#call<SimilarHit[]>('embed_similar', { root, path: q.path, start: this.#windowStart(q), k: this.#k }));
            this.#query = q;
            this.#listKind = 'similar';
        });
    }

    // ── Map ───────────────────────────────────────────────────────────

    /** Open the 2-D map of all windows (overlay, or its panel with `mapHost`). */
    openMap() {
        const root = this.#opts.getRoot();
        if (!root) return;
        this.#map ??= new EmbeddingMap({
            load: (force) => this.#call<MapData>('embed_map', { root: this.#opts.getRoot(), force }),
            getClass: () => this.#cls,
            labelOf: (path, start) => this.#labelOf(path, start),
            setLabels: async (items, label) => {
                if (!this.#cls) return;
                this.#labels = await this.#call<LabelsFile>('agile_label_set_many', {
                    root: this.#opts.getRoot(), class: this.#cls, items, label,
                });
                this.#render();
            },
            openHit: (hit, play) => this.#opts.openHit(hit, play),
            loadClusters: (minSize) => this.#call<Clusters>('embed_clusters', { root: this.#opts.getRoot(), minClusterSize: minSize }),
            loadScores: () => this.#call<{ stamp: number; scores: number[] }>('agile_scores', { root: this.#opts.getRoot(), class: this.#cls }),
            loadSuspects: () => this.#call<Suspect[]>('agile_suspects', { root: this.#opts.getRoot(), class: this.#cls }),
            contextOf: (path) => this.#opts.contextOf?.(path) ?? null,
            host: this.#opts.mapHost,
        });
        this.#map.open();
    }

    // ── Tiles + picking ───────────────────────────────────────────────

    #marksQueued = false;
    /** Labels changed (own marks on the tiles): redraw the grid once per frame, only when hits are shown. */
    refreshMarks() {
        if (!this.#hits.length || this.#marksQueued || !this.el.isConnected) return;
        this.#marksQueued = true;
        requestAnimationFrame(() => { this.#marksQueued = false; this.#render(); });
    }

    #setHits(hits: SimilarHit[]) {
        this.#hits = hits;
        this.#sel = { sel: new Set(), anchor: -1 };
        this.#barMsg = '';
        if (this.#tiles.size > 2000) this.#tiles.clear();
    }

    #picked(): SimilarHit[] {
        return [...this.#sel.sel].sort((a, b) => a - b).map((i) => this.#hits[i]).filter(Boolean);
    }

    /** Spectrogram tiles of the hits not drawn yet, then draw them into the grid. */
    async #loadTiles() {
        const root = this.#opts.getRoot();
        const missing = this.#hits.filter((h) => !this.#tiles.has(tileKey(h)));
        if (!root || !missing.length || this.#tilesLoading) { this.#drawTiles(); return; }
        this.#tilesLoading = true;
        try {
            const res = await this.#call<Tile[]>('similar_tiles', {
                root, windows: missing.map((h) => ({ path: h.path, start: h.start, end: h.end })), spec: TILE_SPEC,
            });
            // One tile per window, in order; anything else cannot be matched safely.
            if (!Array.isArray(res) || res.length !== missing.length) throw new Error('tile count mismatch');
            missing.forEach((h, k) => {
                const t = res[k];
                this.#tiles.set(tileKey(h), t && !t.error && t.w ? new ImageData(thumbPixels(t, this.#lut), t.w, t.h) : null);
            });
        } catch {
            for (const h of missing) this.#tiles.set(tileKey(h), null);
        } finally {
            this.#tilesLoading = false;
        }
        this.#drawTiles();
        if (this.#hits.some((h) => !this.#tiles.has(tileKey(h)))) void this.#loadTiles();   // hits changed meanwhile
    }

    #drawTiles() {
        for (const c of this.el.querySelectorAll<HTMLCanvasElement>('canvas.sim-spec')) {
            const img = this.#tiles.get(c.dataset.k || '');
            if (!img) { c.classList.toggle('is-missing', img === null); continue; }
            c.width = img.width; c.height = img.height;
            c.getContext('2d')?.putImageData(img, 0, 0);
        }
    }

    async #mark(polarity: 'present' | 'absent') {
        const hits = this.#picked();
        if (!hits.length || !this.#opts.markHits) return;
        this.#barMsg = await this.#opts.markHits(hits, polarity);
        this.#render();
    }

    async #classMark(label: Label) {
        const root = this.#opts.getRoot();
        if (!root || !this.#cls) return;
        // All picks go to the class they were picked for, even if the class changes while this runs.
        const cls = this.#cls;
        for (const h of this.#picked()) {
            const next = await this.#call<LabelsFile>('agile_label_set', { root, class: cls, path: h.path, start: h.start, label });
            if (cls === this.#cls) this.#labels = next;   // a late answer must not replace the new class's labels
        }
        this.#render();
    }

    // ── Agile modelling ───────────────────────────────────────────────

    #labelOf(path: string, start: number): Label | null {
        const c = this.#labels.classes.find((x) => x.name === this.#cls);
        return c?.examples.find((e) => e.path === path && Math.abs(e.start - start) < 1e-3)?.label ?? null;
    }

    async #setLabel(path: string, start: number, label: Label) {
        const root = this.#opts.getRoot();
        if (!root) return;
        if (!this.#cls) {
            this.#status = 'Create a class first.';
            this.#render();
            return;
        }
        const next = this.#labelOf(path, start) === label ? null : label;
        this.#labels = await this.#call<LabelsFile>('agile_label_set', { root, class: this.#cls, path, start, label: next });
        this.#render();
    }

    async #addClass() {
        const root = this.#opts.getRoot();
        if (!root) return;
        const name = (await appPrompt('Name of the class (e.g. species or call type):', ''))?.trim();
        if (!name) return;
        this.#labels = await this.#call<LabelsFile>('agile_class_add', { root, name });
        this.#selectClass(name);
    }

    async #removeClass() {
        const root = this.#opts.getRoot();
        if (!root || !this.#cls) return;
        if (!await appConfirm(`Delete class "${this.#cls}" with its labels and classifier?`)) return;
        this.#labels = await this.#call<LabelsFile>('agile_class_remove', { root, name: this.#cls });
        this.#selectClass('');
    }

    #selectClass(name: string) {
        this.#cls = name;
        this.#train = null;
        this.#rank = null;
        if (this.#listKind === 'rank') this.#setHits([]);
        this.#map?.refresh();   // at once: the map drops results of the old class before anything async
        this.refresh();
    }

    /** Label the window under the current selection / playhead. */
    async #labelQuery(label: Label) {
        const q = this.#opts.getQuery();
        if (!q) {
            this.#status = 'Select a region in a project recording first.';
            this.#render();
            return;
        }
        await this.#setLabel(q.path, this.#windowStart(q), label);
    }

    async #trainNow() {
        const root = this.#opts.getRoot();
        if (!root || !this.#cls) return;
        const cls = this.#cls;
        await this.#run('Training…', async () => {
            const train = await this.#call<TrainResult>('agile_train', { root, class: cls });
            const info = await this.#call<ClassifierInfo>('agile_classifier_info', { root, class: cls });
            if (cls !== this.#cls) return;   // another class was chosen meanwhile
            this.#train = train;
            this.#clfInfo = info;
            await this.#fetchRank();
        });
    }

    async #fetchRank() {
        const root = this.#opts.getRoot();
        if (!root || !this.#cls) return;
        const cls = this.#cls;
        const rank = await this.#call<RankResult>('agile_rank', {
            root, class: cls, mode: this.#rankMode, k: this.#k, threshold: this.#threshold, skipLabeled: true,
        });
        if (cls !== this.#cls) return;   // suspects of the old class must not show (and be labelled) under the new one
        this.#rank = rank;
        this.#setHits(rank.hits);
        this.#listKind = 'rank';
    }

    async #export(format: 'raven' | 'csv') {
        const root = this.#opts.getRoot();
        if (!root || !this.#cls) return;
        const { save } = await import('@tauri-apps/plugin-dialog');
        const base = this.#cls.replace(/[^\w\- ]+/g, '_');
        const dest = await save({
            defaultPath: format === 'raven' ? `${base}.selections.txt` : `${base}.csv`,
            filters: [format === 'raven'
                ? { name: 'Raven selection table', extensions: ['txt'] }
                : { name: 'CSV', extensions: ['csv'] }],
        });
        if (!dest) return;
        await this.#run('Exporting…', async () => {
            const n = await this.#call<number>('agile_export', {
                root, class: this.#cls, threshold: this.#threshold, format, dest, merge: true,
            });
            this.#status = `Exported ${n} detection${n === 1 ? '' : 's'} to ${dest}`;
        });
    }

    // ── Events ────────────────────────────────────────────────────────

    #onClick(e: MouseEvent) {
        const tile = (e.target as Element).closest<HTMLElement>('.sim-tile');
        if (tile && !(e.target as Element).closest('[data-act]')) {
            const i = Number(tile.dataset.i);
            // Second click of a double-click (the grid was rebuilt in between, so no dblclick event):
            // undo the first click's pick and open the hit.
            if (e.detail === 2 && !e.shiftKey) {
                this.#sel = clickTile(this.#sel, i);
                this.#render();
                const h = this.#hits[i];
                if (h) void Promise.resolve(this.#opts.openHit(h, false)).catch(() => {});
                return;
            }
            this.#sel = clickTile(this.#sel, i, { shift: e.shiftKey });
            this.#render();
            return;
        }
        const btn = (e.target as Element).closest<HTMLElement>('[data-act]');
        if (!btn || (btn as HTMLButtonElement).disabled) return;
        const act = btn.dataset.act;
        const fail = (err: unknown) => {
            this.#status = errText(err);
            this.#render();
        };
        const hit = () => this.#hits[Number(btn.dataset.i)];
        switch (act) {
            case 'download': this.#download(); break;
            case 'start': this.#start(); break;
            case 'cancel': this.#call('embed_cancel').catch(fail); break;
            case 'search': this.#search(); break;
            case 'map': this.openMap(); break;
            case 'class-add': this.#addClass().catch(fail); break;
            case 'class-del': this.#removeClass().catch(fail); break;
            case 'qlabel': this.#labelQuery(btn.dataset.l as Label).catch(fail); break;
            case 'train': this.#trainNow(); break;
            case 'rank': this.#run('Scoring…', () => this.#fetchRank()); break;
            case 'export': this.#export(btn.dataset.f as 'raven' | 'csv').catch(fail); break;
            case 'mark': this.#mark(btn.dataset.p as 'present' | 'absent').catch(fail); break;
            case 'cmark': this.#classMark(btn.dataset.l as Label).catch(fail); break;
            case 'sel-all':
                this.#sel = this.#sel.sel.size === this.#hits.length
                    ? { sel: new Set(), anchor: -1 } : { sel: new Set(this.#hits.map((_, i) => i)), anchor: 0 };
                this.#render();
                break;
            case 'to-view':
                Promise.resolve(this.#opts.hitsToView?.([...new Set((this.#sel.sel.size ? this.#picked() : this.#hits).map((h) => h.path))]))
                    .then((m) => { if (m) { this.#barMsg = m; this.#render(); } }).catch((err) => { this.#barMsg = errText(err); this.#render(); });
                break;
            case 'label': {
                const h = hit();
                if (h) this.#setLabel(h.path, h.start, btn.dataset.l as Label).catch(fail);
                break;
            }
            case 'play':
            case 'open': {
                const h = hit();
                if (h) Promise.resolve(this.#opts.openHit(h, act === 'play')).catch(fail);
                break;
            }
        }
    }

    #onContextMenu(e: MouseEvent) {
        const li = (e.target as Element).closest<HTMLElement>('.sim-hit, .sim-tile');
        const h = li ? this.#hits[Number(li.dataset.i)] : null;
        if (!h) return;
        e.preventDefault();
        const fail = (err: unknown) => { this.#status = errText(err); this.#render(); };
        showContextMenu({
            x: e.clientX, y: e.clientY,
            items: similarHitMenuItems(h, this.#cls ? this.#labelOf(h.path, h.start) : undefined, {
                play: () => Promise.resolve(this.#opts.openHit(h, true)).catch(fail),
                open: () => Promise.resolve(this.#opts.openHit(h, false)).catch(fail),
                label: (l) => this.#setLabel(h.path, h.start, l).catch(fail),
                copy: (t) => { navigator.clipboard?.writeText(t).catch(() => {}); },
                query: () => this.#search({ path: h.path, start: h.start, end: h.end }).catch(fail),
            }),
        });
    }

    #onChange(e: Event) {
        const t = e.target as HTMLInputElement | HTMLSelectElement;
        if (t.id === 'simClass') this.#selectClass(t.value);
        else if (t.id === 'simMode') this.#rankMode = t.value;
        else if (t.id === 'simK') this.#k = Number(t.value);
        else if (t.id === 'simThr') {
            this.#threshold = Number(t.value);
            const out = this.el.querySelector('#simThrVal');
            if (out) out.textContent = this.#threshold.toFixed(2);
        }
    }

    // ── Rendering ─────────────────────────────────────────────────────

    #render() {
        const root = this.#opts.getRoot();
        if (!root) {
            this.el.innerHTML = '<div class="panel-section"><p class="field-hint">Open a project folder to compute embeddings, '
                + 'search for similar sounds and train classifiers.</p></div>';
            return;
        }
        this.#map?.refresh();
        const parts = [this.#renderModel(), this.#renderEmbeddings(), this.#renderSearch(), this.#renderClassifier(), this.#renderHits()];
        const scroll = this.el.scrollTop;
        this.el.innerHTML = parts.join('');
        this.el.scrollTop = scroll;
        if (this.#hits.length) void this.#loadTiles();
    }

    #renderModel(): string {
        const m = this.#model;
        if (!m || m.present) return '';
        const d = this.#downloading;
        const pct = d ? Math.round((d.bytes / Math.max(1, d.total)) * 100) : 0;
        return `<div class="panel-section">
            <span class="field-label">Perch 2 model</span>
            <p class="field-hint">Similarity search and classifiers use Google's Perch 2 embeddings (Apache 2.0). The model (${(m.size / 1e6).toFixed(0)} MB) is downloaded once.</p>
            ${d ? `<div class="birdnet-progress"><div class="birdnet-progress-bar" style="width:${pct}%"></div></div><p class="field-hint">${pct} %</p>`
                : '<div class="panel-actions"><button class="sidebar-action-btn" data-act="download" type="button">Download model</button></div>'}
        </div>`;
    }

    #renderEmbeddings(): string {
        const m = this.#model, info = this.#info, job = this.#job;
        const running = !!job && (job.phase === 'starting' || job.phase === 'running');
        const hop = info?.hopS ?? WINDOW_S;
        const hopOpts = [5, 2.5, 1].map((h) =>
            `<option value="${h}"${Math.abs(h - hop) < 1e-9 ? ' selected' : ''}>${h} s${h === 5 ? ' (no overlap)' : ''}</option>`).join('');
        const stateLine = info?.exists
            ? `${info.files} file${info.files === 1 ? '' : 's'}, ${info.windows.toLocaleString()} windows`
            : 'No embeddings yet.';
        const failed = info ? Object.entries(info.failed) : [];
        let jobHtml = '';
        if (running && job) {
            const pct = job.total ? Math.round((job.done / job.total) * 100) : 0;
            jobHtml = `<div class="birdnet-progress"><div class="birdnet-progress-bar" style="width:${pct}%"></div></div>
                <p class="field-hint">${job.done}/${job.total} files${job.device ? ` · ${esc(job.device)}` : ''}${job.current ? `<br>${esc(job.current)}` : ''}</p>`;
        } else if (job?.phase === 'error') {
            jobHtml = `<p class="field-hint sim-error">${esc(job.error || 'Error')}</p>`;
        } else if (job?.phase === 'done' && job.total) {
            jobHtml = `<p class="field-hint">Done: ${job.windows.toLocaleString()} windows from ${(job.audioSeconds / 3600).toFixed(2)} h audio${job.device ? ` (${esc(job.device)})` : ''}.</p>`;
        } else if (job?.phase === 'cancelled') {
            jobHtml = '<p class="field-hint">Cancelled — finished files are kept.</p>';
        }
        return `<div class="panel-section">
            <span class="field-label">Embeddings</span>
            <p class="field-hint">${stateLine}</p>
            <label class="field-label" for="simHop" style="margin-top:6px">Window hop</label>
            <select id="simHop" class="field-select"${running ? ' disabled' : ''}>${hopOpts}</select>
            <div class="panel-actions" style="margin-top:8px">
                ${running ? '<button class="sidebar-action-btn secondary" data-act="cancel" type="button">Cancel</button>'
                    : `<button class="sidebar-action-btn" data-act="start" type="button"${m?.present ? '' : ' disabled'}>${info?.exists ? 'Update embeddings' : 'Compute embeddings'}</button>`}
                ${info?.windows && !running ? '<button class="sidebar-action-btn secondary" data-act="map" type="button" title="2-D map of all windows: explore, listen, label in bulk">Open map</button>' : ''}
            </div>
            ${jobHtml}
            ${failed.length ? `<details class="field-hint"><summary>${failed.length} file${failed.length === 1 ? '' : 's'} could not be read</summary>${failed.map(([p, r]) => `<div title="${esc(r)}">${esc(p)}</div>`).join('')}</details>` : ''}
        </div>`;
    }

    #renderSearch(): string {
        const kOpts = [20, 50, 100, 200].map((k) => `<option value="${k}"${k === this.#k ? ' selected' : ''}>${k}</option>`).join('');
        return `<div class="panel-section">
            <span class="field-label">Find similar</span>
            <p class="field-hint">Select a call in the spectrogram (or place the playhead), then search the whole project.</p>
            <div class="sim-search-row">
                <select id="simK" class="field-select sim-k" title="Number of results">${kOpts}</select>
                <button class="sidebar-action-btn" data-act="search" type="button"${this.#info?.windows && !this.#busy ? '' : ' disabled'}>Find similar</button>
            </div>
            ${this.#status ? `<p class="field-hint">${esc(this.#status)}</p>` : ''}
        </div>`;
    }

    #renderClassifier(): string {
        const cls = this.#labels.classes.find((c) => c.name === this.#cls);
        const cnt: Record<Label, number> = { pos: 0, neg: 0, unsure: 0 };
        cls?.examples.forEach((x) => { cnt[x.label] = (cnt[x.label] || 0) + 1; });
        const classOpts = this.#labels.classes.map((c) =>
            `<option value="${esc(c.name)}"${c.name === this.#cls ? ' selected' : ''}>${esc(c.name)}</option>`).join('');
        const tr = this.#train;
        const clf = this.#clfInfo;
        const pct = (v: number | null) => (v == null ? '–' : `${Math.round(v * 100)} %`);
        const busy = !!this.#busy;

        let body: string;
        if (!this.#cls) {
            body = '<p class="field-hint">Create a class, mark a few windows positive / negative (from the selection or from search results), then train.</p>';
        } else {
            const qButtons = (['pos', 'neg', 'unsure'] as Label[]).map((l) =>
                `<button class="sim-lbl ${l}" data-act="qlabel" data-l="${l}" type="button" title="${LABEL_TITLE[l]}: window at the selection">${LABEL_ICON[l]}</button>`).join('');
            const trained = tr
                ? `<p class="field-hint">Trained on ${tr.positives} pos / ${tr.negatives} neg${tr.background ? ` + ${tr.background} random background` : ''}${tr.missing ? ` · ${tr.missing} labels without embedding` : ''}.<br>
                    Cross-validation: accuracy ${pct(tr.cvAccuracy)}, precision ${pct(tr.cvPrecision)}, recall ${pct(tr.cvRecall)}${tr.cvAccuracy == null ? ' (needs ≥ 3 pos and ≥ 3 neg)' : ''}</p>`
                : clf?.trained ? `<p class="field-hint">Classifier trained (${clf.positives} pos / ${clf.negatives} neg).</p>` : '';
            const review = clf?.trained ? `
                <div class="slider-row" style="margin-top:6px">
                    <label class="field-label" for="simThr" style="margin:0">Threshold</label>
                    <span class="slider-val" id="simThrVal">${this.#threshold.toFixed(2)}</span>
                </div>
                <input id="simThr" type="range" min="0.05" max="0.99" step="0.01" value="${this.#threshold}" style="width:100%">
                <div class="sim-search-row" style="margin-top:6px">
                    <select id="simMode" class="field-select" title="Which unlabeled windows to review">
                        <option value="top"${this.#rankMode === 'top' ? ' selected' : ''}>Top scores</option>
                        <option value="uncertain"${this.#rankMode === 'uncertain' ? ' selected' : ''}>Near threshold</option>
                        <option value="random"${this.#rankMode === 'random' ? ' selected' : ''}>Random</option>
                    </select>
                    <button class="sidebar-action-btn" data-act="rank" type="button"${busy ? ' disabled' : ''}>Review</button>
                </div>
                ${this.#rank ? `<p class="field-hint">${this.#rank.above.toLocaleString()} of ${this.#rank.total.toLocaleString()} windows ≥ threshold (at last review).</p>` : ''}
                <div class="sim-search-row" style="margin-top:6px">
                    <span class="field-hint">Export ≥ threshold:</span>
                    <button class="sidebar-action-btn secondary" data-act="export" data-f="raven" type="button"${busy ? ' disabled' : ''}>Raven</button>
                    <button class="sidebar-action-btn secondary" data-act="export" data-f="csv" type="button"${busy ? ' disabled' : ''}>CSV</button>
                </div>` : '';
            body = `
                <p class="field-hint">Labels: <b>${cnt.pos}</b> positive · <b>${cnt.neg}</b> negative · ${cnt.unsure} unsure</p>
                <div class="sim-search-row"><span class="field-hint">Selection:</span>${qButtons}</div>
                <div class="panel-actions" style="margin-top:6px">
                    <button class="sidebar-action-btn" data-act="train" type="button"${cnt.pos && this.#info?.windows && !busy ? '' : ' disabled'}>${clf?.trained ? 'Retrain' : 'Train'}</button>
                </div>
                ${trained}${review}`;
        }
        return `<div class="panel-section">
            <span class="field-label">Classifier</span>
            <div class="sim-search-row">
                <select id="simClass" class="field-select"${classOpts ? '' : ' disabled'}>${classOpts || '<option>No class yet</option>'}</select>
                <button class="sim-icon-btn" data-act="class-add" type="button" title="New class">+</button>
                ${this.#cls ? '<button class="sim-icon-btn" data-act="class-del" type="button" title="Delete class">×</button>' : ''}
            </div>
            ${body}
            ${this.#busy ? `<p class="field-hint">${esc(this.#busy)}</p>` : ''}
        </div>`;
    }

    #renderHits(): string {
        if (!this.#hits.length) return '';
        const q = this.#query;
        const modeName: Record<string, string> = { top: 'top scores', uncertain: 'near threshold', random: 'random' };
        const head = this.#listKind === 'rank'
            ? `Review “${esc(this.#cls)}”: ${modeName[this.#rankMode] || this.#rankMode}, unlabeled windows`
            : q ? `Similar to ${esc(q.path)} @ ${fmtTime(q.start)}` : '';
        const scoreTitle = this.#listKind === 'rank' ? 'Classifier score' : 'Cosine similarity';
        const n = this.#sel.sel.size;
        const mark = !!this.#opts.markHits;
        const classTag = (h: SimilarHit) => {
            const cur = this.#cls ? this.#labelOf(h.path, h.start) : null;
            const own = this.#opts.markOf?.(h);
            return (own ? `<span class="sim-own${own.absent ? ' absent' : ''}" title="My label: ${own.absent ? 'absent – ' : ''}${esc(own.name)}">${own.absent ? '✕' : '✓'}</span>` : '')
                + (cur ? `<span class="sim-cls ${cur}" title="${esc(this.#cls)}: ${LABEL_TITLE[cur]}">${LABEL_ICON[cur]}</span>` : '');
        };
        return `<div class="panel-section sim-results">
            <p class="field-hint">${head}</p>
            <div class="sim-grid">${this.#hits.map((h, i) => `
                <div class="sim-tile${this.#sel.sel.has(i) ? ' sel' : ''}${((o) => (o ? (o.absent ? ' own-absent' : ' own-present') : ''))(this.#opts.markOf?.(h))}" data-i="${i}"
                     title="${esc(h.path.split('/').pop() || h.path)} @ ${fmtTime(h.start)} · click: pick, Shift: range, double-click: open">
                    <canvas class="sim-spec" data-k="${esc(tileKey(h))}" width="${TILE_SPEC.w}" height="${TILE_SPEC.h}"></canvas>
                    <button class="sim-tplay" data-act="play" data-i="${i}" type="button" title="Play" aria-label="Play">▶</button>
                    <span class="sim-plq tr"><span>${esc((h.path.split('/').pop() || h.path).replace(/\.[^.]+$/, ''))}</span></span>
                    <span class="sim-plq bl"><span title="${scoreTitle}">${h.score.toFixed(2)}</span><span>${fmtTime(h.start)}</span></span>
                    <span class="sim-plq br">${classTag(h)}</span>
                </div>`).join('')}
            </div>
            <div class="sim-actbar">
                <button class="sim-abtn" data-act="sel-all" type="button">${n === this.#hits.length ? 'None' : 'All'}</button>
                ${mark ? `<button class="sim-abtn ok" data-act="mark" data-p="present" type="button"${n ? '' : ' disabled'} title="Label the picked windows with the New labels species">✓ present${n ? ` (${n})` : ''}</button>
                <button class="sim-abtn no" data-act="mark" data-p="absent" type="button"${n ? '' : ' disabled'} title="Keep the picked windows as absent labels (not this species)">✕ absent</button>` : ''}
                ${this.#cls ? (['pos', 'neg', 'unsure'] as Label[]).map((l) => `<button class="sim-lbl ${l}" data-act="cmark" data-l="${l}" type="button"${n ? '' : ' disabled'} title="${esc(this.#cls)}: ${LABEL_TITLE[l]}">${LABEL_ICON[l]}</button>`).join('') : ''}
                <span class="sim-spacer"></span>
                ${this.#opts.hitsToView ? `<button class="sim-abtn" data-act="to-view" type="button" title="Show the recordings of ${n ? 'the picked' : 'all'} hits as the view">→ View</button>` : ''}
                ${this.#barMsg ? `<p class="sim-barmsg">${esc(this.#barMsg)}</p>` : ''}
            </div>
        </div>`;
    }
}
