// ═══════════════════════════════════════════════════════════════════════
// ui/panels/similar-panel.ts — Perch-2 embeddings + "find similar" (Lite)
//
// Talks to src-tauri-lite/src/embeddings.rs:
//   embed_model_status / embed_model_download   (event lite-embed-model)
//   embed_info / embed_start / embed_cancel     (event lite-embed-progress)
//   embed_similar                               (top-k windows)
// The host page supplies the project root, the query (selection/playhead)
// and how to open + play a hit.
// ═══════════════════════════════════════════════════════════════════════

type Invoke = <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>;

interface ModelStatus { present: boolean; path: string; size: number }
interface StoreInfo { exists: boolean; hopS: number; files: number; windows: number; failed: Record<string, string>; running: boolean }
interface JobProgress {
    root: string; phase: string; done: number; total: number; current: string | null;
    windows: number; audioSeconds: number; device: string; error: string | null; failed: number;
}
export interface SimilarHit { path: string; start: number; end: number; score: number }
export interface SimilarQuery { path: string; start: number; end: number }

export interface SimilarPanelOptions {
    /** Absolute project folder, or null when no folder project is open. */
    getRoot: () => string | null;
    /** Query window: current selection, else playhead, in the active recording. */
    getQuery: () => SimilarQuery | null;
    /** Open the hit's recording (if needed) and play / show the window. */
    openHit: (hit: SimilarHit, play: boolean) => Promise<void> | void;
}

const WINDOW_S = 5;
const fmtTime = (s: number) => {
    const m = Math.floor(s / 60);
    return `${m}:${(s - m * 60).toFixed(1).padStart(4, '0')}`;
};
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));

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
    #status = '';
    #listening = false;

    constructor(opts: SimilarPanelOptions) {
        this.#opts = opts;
        this.#invoke = import('@tauri-apps/api/core').then((m) => m.invoke as Invoke);
        this.el = document.createElement('div');
        this.el.className = 'scroll-panel similar-panel';
        this.el.addEventListener('click', (e) => this.#onClick(e));
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

    /** Reload model + store status (call on activate and after project switch). */
    async refresh() {
        await this.#listen();
        try {
            this.#model = await this.#call<ModelStatus>('embed_model_status');
            const root = this.#opts.getRoot();
            this.#info = root ? await this.#call<StoreInfo>('embed_info', { root }) : null;
            if (this.#info && !this.#info.running && this.#job?.phase === 'running') this.#job = null;
        } catch (e) {
            this.#status = `Error: ${(e as Error)?.message || e}`;
        }
        this.#render();
    }

    async #download() {
        this.#downloading = { bytes: 0, total: this.#model?.size || 1 };
        this.#status = '';
        this.#render();
        try {
            this.#model = await this.#call<ModelStatus>('embed_model_download');
        } catch (e) {
            this.#status = `Download failed: ${(e as Error)?.message || e}`;
        }
        this.#downloading = null;
        this.refresh();
    }

    async #start() {
        const root = this.#opts.getRoot();
        if (!root) return;
        const hop = Number((this.el.querySelector('#simHop') as HTMLSelectElement)?.value || WINDOW_S);
        if (this.#info?.exists && Math.abs(this.#info.hopS - hop) > 1e-9 && this.#info.windows > 0) {
            if (!confirm(`Changing the hop from ${this.#info.hopS} s to ${hop} s recomputes all embeddings. Continue?`)) return;
        }
        this.#status = '';
        this.#job = { root, phase: 'starting', done: 0, total: 0, current: null, windows: 0, audioSeconds: 0, device: '', error: null, failed: 0 };
        this.#render();
        try {
            await this.#call('embed_start', { root, hopS: hop });
        } catch (e) {
            this.#job = null;
            this.#status = `${(e as Error)?.message || e}`;
            this.#render();
        }
    }

    async #search() {
        const root = this.#opts.getRoot();
        const q = this.#opts.getQuery();
        if (!root) return;
        if (!q) {
            this.#status = 'Select a region (or place the playhead) in a project recording first.';
            this.#render();
            return;
        }
        // Window best covering the query: centred on the selection.
        const mid = (q.start + q.end) / 2;
        const start = Math.max(0, mid - WINDOW_S / 2);
        const k = Number((this.el.querySelector('#simK') as HTMLSelectElement)?.value || 50);
        this.#status = 'Searching…';
        this.#render();
        try {
            this.#hits = await this.#call<SimilarHit[]>('embed_similar', { root, path: q.path, start, k });
            this.#query = q;
            this.#status = '';
        } catch (e) {
            this.#hits = [];
            this.#status = `${(e as Error)?.message || e}`;
        }
        this.#render();
    }

    #onClick(e: MouseEvent) {
        const btn = (e.target as Element).closest<HTMLElement>('[data-act]');
        if (!btn) return;
        const act = btn.dataset.act;
        if (act === 'download') this.#download();
        else if (act === 'start') this.#start();
        else if (act === 'cancel') this.#call('embed_cancel');
        else if (act === 'search') this.#search();
        else if (act === 'play' || act === 'open') {
            const hit = this.#hits[Number(btn.dataset.i)];
            if (hit) Promise.resolve(this.#opts.openHit(hit, act === 'play')).catch((err) => {
                this.#status = `${err?.message || err}`;
                this.#render();
            });
        }
    }

    #render() {
        const root = this.#opts.getRoot();
        const m = this.#model, info = this.#info, job = this.#job;
        const running = !!job && (job.phase === 'starting' || job.phase === 'running');
        const parts: string[] = [];

        if (!root) {
            parts.push(`<div class="panel-section"><p class="field-hint">Open a project folder to compute embeddings and search for similar sounds.</p></div>`);
            this.el.innerHTML = parts.join('');
            return;
        }

        // ── Model ──
        if (m && !m.present) {
            const d = this.#downloading;
            const pct = d ? Math.round((d.bytes / Math.max(1, d.total)) * 100) : 0;
            parts.push(`<div class="panel-section">
                <span class="field-label">Perch 2 model</span>
                <p class="field-hint">Similarity search uses Google's Perch 2 embeddings (Apache 2.0). The model (${(m.size / 1e6).toFixed(0)} MB) is downloaded once.</p>
                ${d ? `<div class="birdnet-progress"><div class="birdnet-progress-bar" style="width:${pct}%"></div></div><p class="field-hint">${pct} %</p>`
                    : `<div class="panel-actions"><button class="sidebar-action-btn" data-act="download" type="button">Download model</button></div>`}
            </div>`);
        }

        // ── Embeddings ──
        const hop = info?.hopS ?? WINDOW_S;
        const hopOpts = [5, 2.5, 1].map((h) => `<option value="${h}"${Math.abs(h - hop) < 1e-9 ? ' selected' : ''}>${h} s${h === 5 ? ' (no overlap)' : ''}</option>`).join('');
        let stateLine = 'No embeddings yet.';
        if (info?.exists) stateLine = `${info.files} file${info.files === 1 ? '' : 's'}, ${info.windows.toLocaleString()} windows`;
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
            jobHtml = `<p class="field-hint">Cancelled — finished files are kept.</p>`;
        }
        parts.push(`<div class="panel-section">
            <span class="field-label">Embeddings</span>
            <p class="field-hint">${stateLine}</p>
            <label class="field-label" for="simHop" style="margin-top:6px">Window hop</label>
            <select id="simHop" class="field-select"${running ? ' disabled' : ''}>${hopOpts}</select>
            <div class="panel-actions" style="margin-top:8px">
                ${running ? `<button class="sidebar-action-btn secondary" data-act="cancel" type="button">Cancel</button>`
                    : `<button class="sidebar-action-btn" data-act="start" type="button"${m?.present ? '' : ' disabled'}>${info?.exists ? 'Update embeddings' : 'Compute embeddings'}</button>`}
            </div>
            ${jobHtml}
            ${failed.length ? `<details class="field-hint"><summary>${failed.length} file${failed.length === 1 ? '' : 's'} could not be read</summary>${failed.map(([p, r]) => `<div title="${esc(r)}">${esc(p)}</div>`).join('')}</details>` : ''}
        </div>`);

        // ── Search ──
        const kOpts = [20, 50, 100, 200].map((k) => `<option value="${k}"${k === 50 ? ' selected' : ''}>${k}</option>`).join('');
        parts.push(`<div class="panel-section">
            <span class="field-label">Find similar</span>
            <p class="field-hint">Select a call in the spectrogram (or place the playhead), then search the whole project.</p>
            <div class="sim-search-row">
                <select id="simK" class="field-select" title="Number of results">${kOpts}</select>
                <button class="sidebar-action-btn" data-act="search" type="button"${info?.windows ? '' : ' disabled'}>Find similar</button>
            </div>
            ${this.#status ? `<p class="field-hint">${esc(this.#status)}</p>` : ''}
        </div>`);

        if (this.#hits.length) {
            const q = this.#query;
            parts.push(`<div class="panel-section sim-results">
                ${q ? `<p class="field-hint">Query: ${esc(q.path)} @ ${fmtTime(q.start)}</p>` : ''}
                <ol class="sim-list">${this.#hits.map((h, i) => `
                    <li class="sim-hit">
                        <button class="sim-play" data-act="play" data-i="${i}" type="button" title="Play">▶</button>
                        <button class="sim-open" data-act="open" data-i="${i}" type="button" title="Open in spectrogram">
                            <span class="sim-file">${esc(h.path.split('/').pop() || h.path)}</span>
                            <span class="sim-time">${fmtTime(h.start)}</span>
                        </button>
                        <span class="sim-score" title="Cosine similarity">${h.score.toFixed(3)}</span>
                    </li>`).join('')}
                </ol>
            </div>`);
        }

        // keep focus-less re-render cheap: preserve current k selection
        const kSel = (this.el.querySelector('#simK') as HTMLSelectElement | null)?.value;
        this.el.innerHTML = parts.join('');
        if (kSel) (this.el.querySelector('#simK') as HTMLSelectElement).value = kSel;
    }
}
