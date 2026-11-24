// ═══════════════════════════════════════════════════════════════════════
// domain/catalog/catalog-view.ts — one view over the project catalog
//
// The view every library panel shows: open dataset, filter, sort, the rows
// it pages through (keyset), the picked recordings and the current row.
// Panels (table/tiles, calendar, map, statistics, selection, the chips bar)
// read it and change it; they hear about changes through `subscribe`.
// No DOM: the catalog API is passed in, so it runs in tests.
// ═══════════════════════════════════════════════════════════════════════

import {
    pickRows, sameFilter,
    type CatalogCursor, type CatalogFilter, type CatalogRow, type CatalogSort, type DatasetInfo,
    type Facets, type HeatCell, type Selection,
} from './catalog-types.ts';

/** The part of the catalog API the view needs. */
export interface CatalogViewApi {
    facets(root: string, filter: CatalogFilter): Promise<Facets>;
    heatmap(root: string, filter: CatalogFilter): Promise<HeatCell[]>;
    list(root: string, filter: CatalogFilter, sort: CatalogSort, after: CatalogCursor | null, limit: number):
        Promise<{ rows: CatalogRow[]; next: CatalogCursor | null }>;
    datasets(root: string): Promise<DatasetInfo[]>;
}

/**
 * - `query`: filter/dataset/sort changed and facets, calendar and the first page are loaded (or `error` is set)
 * - `rows`: another page arrived
 * - `selection`: picked recordings or the current row changed
 * - `loading`: a reload started; `ready`: it finished (first page there, or failed)
 */
export type ViewChange = 'query' | 'rows' | 'selection' | 'loading' | 'ready';
export type ViewListener = (change: ViewChange, view: CatalogView) => void;

export const VIEW_PAGE = 500;

export class CatalogView {
    readonly projectRoot: string;
    #api: CatalogViewApi;
    #listeners = new Set<ViewListener>();

    filter: CatalogFilter = {};
    sort: CatalogSort = 'start';
    facets: Facets | null = null;
    heat: HeatCell[] = [];
    rows: CatalogRow[] = [];
    datasets: DatasetInfo[] = [];
    /** Open dataset: static → filter.datasetId; dynamic → its saved filter loaded into the filter. */
    activeDs: number | null = null;
    /** Last reload failed (facets is null then). */
    error: string | null = null;
    /** A reload is under way (until its first page is there). */
    loading = false;

    /** Current row (keyboard, large view, editor); -1: none. */
    current = -1;
    /** Picked recording ids (multi-select) and the anchor row for Shift+click. */
    picked = new Set<number>();
    anchor: number | null = null;
    /** Everything the filter shows is picked (bulk edit). */
    pickAll = false;

    #next: CatalogCursor | null = null;
    /** The page request in flight and the query generation it belongs to. */
    #page: { gen: number; p: Promise<void> } | null = null;
    #gen = 0;
    /** Dataset counts are reloaded only after changes (a dynamic dataset over a big catalog can take a second). */
    #dsStale = true;
    #disposed = false;

    constructor(projectRoot: string, api: CatalogViewApi) {
        this.projectRoot = projectRoot;
        this.#api = api;
    }

    subscribe(fn: ViewListener): () => void {
        this.#listeners.add(fn);
        return () => { this.#listeners.delete(fn); };
    }

    #emit(change: ViewChange) {
        if (this.#disposed) return;
        for (const fn of [...this.#listeners]) {
            try { fn(change, this); } catch (e) { console.error('[catalog-view] listener failed', e); }
        }
    }

    dispose() { this.#disposed = true; this.#gen++; this.#listeners.clear(); }

    /** Recordings the filter matches (all pages). */
    get total(): number { return this.facets?.total ?? this.rows.length; }
    get hasMore(): boolean { return this.#next != null; }
    get active(): DatasetInfo | null { return this.datasets.find((d) => d.id === this.activeDs) ?? null; }
    /** Open dynamic dataset whose filter was changed (not saved yet). */
    get dirty(): boolean {
        const a = this.active;
        return a?.kind === 'filter' && !sameFilter(this.filter, a.filter ?? {});
    }
    get pickedCount(): number { return this.pickAll ? this.total : this.picked.size; }

    /** What bulk actions apply to: everything shown, the picked ids, or nothing. A copy, so later filter edits do not widen it. */
    get selection(): Selection {
        if (this.pickAll) return { filter: structuredClone(this.filter) };
        return this.picked.size ? { ids: [...this.picked] } : {};
    }

    isPicked(id: number | undefined): boolean { return id != null && (this.pickAll || this.picked.has(id)); }

    /** Dataset list changed elsewhere (dialog, large view): counts are fetched on the next reload. */
    datasetsChanged() { this.#dsStale = true; }

    // ── Changing the query ─────────────────────────────────────────

    /** Replace the filter; `activeDs` undefined keeps the open dataset. */
    setFilter(filter: CatalogFilter, opts: { activeDs?: number | null; keepPicks?: boolean } = {}): Promise<void> {
        this.filter = filter;
        if (opts.activeDs !== undefined) this.activeDs = opts.activeDs;
        return this.reload({ keepPicks: opts.keepPicks });
    }

    /** Change parts of the filter in place and reload. */
    updateFilter(change: (f: CatalogFilter) => void): Promise<void> {
        change(this.filter);
        return this.reload();
    }

    setSort(sort: CatalogSort): Promise<void> {
        if (sort === this.sort) return Promise.resolve();
        this.sort = sort;
        return this.reload();
    }

    /** Open a dataset (null: all recordings). Re-reads the list first, so a just-created one is found. */
    async openDataset(id: number | null): Promise<void> {
        if (id == null) return this.setFilter({}, { activeDs: null });
        this.#dsStale = true;
        this.datasets = await this.#api.datasets(this.projectRoot).catch(() => this.datasets);
        const d = this.datasets.find((x) => x.id === id);
        if (!d) return this.setFilter(this.filter, { activeDs: null });
        return this.setFilter(d.kind === 'filter' ? structuredClone(d.filter ?? {}) : { datasetId: d.id }, { activeDs: d.id });
    }

    async reload(opts: { keepPicks?: boolean } = {}): Promise<void> {
        const gen = ++this.#gen;
        this.rows = [];
        this.#next = null;
        this.current = -1;
        if (!opts.keepPicks) { this.picked = new Set(); this.pickAll = false; this.anchor = null; }
        this.loading = true;
        this.#emit('loading');
        try { await this.#reload(gen, opts); } finally {
            if (gen === this.#gen) { this.loading = false; this.#emit('ready'); }
        }
    }

    async #reload(gen: number, opts: { keepPicks?: boolean }) {
        try {
            const [facets, heat, datasets] = await Promise.all([
                this.#api.facets(this.projectRoot, this.filter),
                this.#api.heatmap(this.projectRoot, this.filter),
                this.#dsStale || opts.keepPicks
                    ? this.#api.datasets(this.projectRoot).catch(() => this.datasets)
                    : Promise.resolve(this.datasets),
            ]);
            if (gen !== this.#gen) return;
            this.facets = facets;
            this.heat = heat;
            this.datasets = datasets;
            this.error = null;
            this.#dsStale = false;
            if (this.activeDs != null && !datasets.some((d) => d.id === this.activeDs)) this.activeDs = null;
        } catch (e) {
            if (gen !== this.#gen) return;   // a newer reload owns the view
            this.facets = null;
            this.heat = [];
            this.error = String(e);
            this.#emit('query');
            return;
        }
        this.#emit('query');
        await this.loadMore(gen);
    }

    /**
     * Next page of the current query. Requests of one generation run one after the other
     * (a caller joins the one in flight); a request of an older generation does not block
     * the current one, its rows are dropped.
     */
    async loadMore(gen = this.#gen): Promise<void> {
        while (this.#page) {
            if (this.#page.gen === gen) return this.#page.p;
            await this.#page.p.catch(() => {});
            if (gen !== this.#gen) return;
        }
        if (gen !== this.#gen || (this.rows.length && !this.#next)) return;
        const entry = { gen, p: Promise.resolve() };
        this.#page = entry;
        entry.p = (async () => {
            let got = false;
            try {
                const page = await this.#api.list(this.projectRoot, this.filter, this.sort, this.#next, VIEW_PAGE);
                if (gen !== this.#gen) return;
                this.rows.push(...page.rows);
                this.#next = page.next;
                got = true;
            } finally {
                if (this.#page === entry) this.#page = null;
            }
            // After the release: a listener may ask for the next page right away (deep scroll position).
            if (got) this.#emit('rows');
        })();
        return entry.p;
    }

    /** Row i, loading pages up to it; null when it does not exist or the query changed meanwhile. */
    async rowAt(i: number): Promise<CatalogRow | null> {
        const gen = this.#gen;
        while (i >= this.rows.length && this.#next && gen === this.#gen) {
            const before = this.rows.length;
            await this.loadMore(gen);
            if (this.rows.length === before) break;   // no progress (error or end)
        }
        return gen === this.#gen ? this.rows[i] ?? null : null;
    }

    // ── Selection ──────────────────────────────────────────────────

    /**
     * Make row i current. Plain click: pick only it; ctrl: toggle; shift: range from the anchor;
     * keepPicks: only move the current row (and the anchor).
     */
    select(i: number, mods: { ctrl?: boolean; shift?: boolean; keepPicks?: boolean } = {}) {
        this.current = i;
        if (mods.keepPicks) {
            this.anchor = i;
        } else {
            const r = pickRows(this.rows.map((x) => x.id), this.picked, this.anchor, i, mods);
            this.picked = r.picked;
            this.anchor = r.anchor;
            this.pickAll = false;
        }
        this.#emit('selection');
    }

    /** Move the current row without touching the picks (arrow keys). */
    setCurrent(i: number) {
        if (i === this.current) return;
        this.current = i;
        this.#emit('selection');
    }

    /** Pick exactly these recordings (map lasso, calendar cell, …). */
    pickIds(ids: Iterable<number>) {
        this.picked = new Set(ids);
        this.pickAll = false;
        this.anchor = null;
        this.#emit('selection');
    }

    selectAllShown() { this.picked = new Set(); this.pickAll = true; this.#emit('selection'); }
    selectNone() { this.picked = new Set(); this.pickAll = false; this.anchor = null; this.#emit('selection'); }
}
