// ═══════════════════════════════════════════════════════════════════════
// ui/panels/similar-panel.ts — Perch-2 embeddings, "find similar" and
// agile modelling (label windows → linear classifier → review → export).
// SignaVis Lite only.
//
// Talks to src-tauri-lite/src/embeddings.rs:
//   embed_model_status / embed_model_download   (event lite-embed-model)
//   embed_info / embed_start / embed_cancel     (event lite-embed-progress)
//   embed_similar                               (top-k windows)
// and src-tauri-lite/src/agile.rs:
//   agile_labels / agile_class_add / agile_class_remove / agile_label_set
//   agile_train / agile_classifier_info / agile_rank / agile_export
// The host page supplies the project root, the query (selection/playhead)
// and how to open + play a hit.
// ═══════════════════════════════════════════════════════════════════════

import { appConfirm, appPrompt } from '../components/modal/dialogs.ts';
import { showContextMenu } from '../components/context-menu/context-menu.ts';

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
}

const WINDOW_S = 5;
const LABEL_ICON: Record<Label, string> = { pos: '✓', neg: '✗', unsure: '?' };
const LABEL_TITLE: Record<Label, string> = { pos: 'Positive', neg: 'Negative', unsure: 'Unsure (ignored in training)' };
const fmtTime = (s: number) => {
    const m = Math.floor(s / 60);
    return `${m}:${(s - m * 60).toFixed(1).padStart(4, '0')}`;
};
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
    }

    /** Reload model, store, labels and classifier status (on activate / project switch). */
    async refresh() {
        await this.#listen();
        try {
            this.#model = await this.#call<ModelStatus>('embed_model_status');
            const root = this.#opts.getRoot();
            this.#info = root ? await this.#call<StoreInfo>('embed_info', { root }) : null;
            if (this.#info && !this.#info.running && this.#job?.phase === 'running') this.#job = null;
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
            this.#hits = await this.#call<SimilarHit[]>('embed_similar', { root, path: q.path, start: this.#windowStart(q), k: this.#k });
            this.#query = q;
            this.#listKind = 'similar';
        });
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
        if (this.#listKind === 'rank') this.#hits = [];
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
        await this.#run('Training…', async () => {
            this.#train = await this.#call<TrainResult>('agile_train', { root, class: this.#cls });
            this.#clfInfo = await this.#call<ClassifierInfo>('agile_classifier_info', { root, class: this.#cls });
            await this.#fetchRank();
        });
    }

    async #fetchRank() {
        const root = this.#opts.getRoot();
        if (!root || !this.#cls) return;
        this.#rank = await this.#call<RankResult>('agile_rank', {
            root, class: this.#cls, mode: this.#rankMode, k: this.#k, threshold: this.#threshold, skipLabeled: true,
        });
        this.#hits = this.#rank.hits;
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
            case 'class-add': this.#addClass().catch(fail); break;
            case 'class-del': this.#removeClass().catch(fail); break;
            case 'qlabel': this.#labelQuery(btn.dataset.l as Label).catch(fail); break;
            case 'train': this.#trainNow(); break;
            case 'rank': this.#run('Scoring…', () => this.#fetchRank()); break;
            case 'export': this.#export(btn.dataset.f as 'raven' | 'csv').catch(fail); break;
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
        const li = (e.target as Element).closest<HTMLElement>('.sim-hit');
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
        const parts = [this.#renderModel(), this.#renderEmbeddings(), this.#renderSearch(), this.#renderClassifier(), this.#renderHits()];
        const scroll = this.el.scrollTop;
        this.el.innerHTML = parts.join('');
        this.el.scrollTop = scroll;
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
        const labelButtons = (h: SimilarHit, i: number) => {
            if (!this.#cls) return '';
            const cur = this.#labelOf(h.path, h.start);
            return (['pos', 'neg', 'unsure'] as Label[]).map((l) =>
                `<button class="sim-lbl ${l}${cur === l ? ' on' : ''}" data-act="label" data-l="${l}" data-i="${i}" type="button" title="${LABEL_TITLE[l]}">${LABEL_ICON[l]}</button>`).join('');
        };
        const scoreTitle = this.#listKind === 'rank' ? 'Classifier score' : 'Cosine similarity';
        return `<div class="panel-section sim-results">
            <p class="field-hint">${head}</p>
            <ol class="sim-list">${this.#hits.map((h, i) => `
                <li class="sim-hit" data-i="${i}">
                    <button class="sim-play" data-act="play" data-i="${i}" type="button" title="Play">▶</button>
                    <button class="sim-open" data-act="open" data-i="${i}" type="button" title="${esc(h.path)} — open in spectrogram">
                        <span class="sim-file">${esc(h.path.split('/').pop() || h.path)}</span>
                        <span class="sim-time">${fmtTime(h.start)}</span>
                    </button>
                    <span class="sim-score" title="${scoreTitle}">${h.score.toFixed(3)}</span>
                    ${labelButtons(h, i)}
                </li>`).join('')}
            </ol>
        </div>`;
    }
}
