// reference-panel.ts — Xeno-canto recordings of a species next to the own clip (Lite, Annotate v2 mockup R1)
//
// Head: species (follows the suggestion / label under review unless pinned), filter chips.
// "Your clip": mini spectrogram of the suggestion or label, ▶ plays it in the editor.
// Tiles: XC sono, type, quality, distance, length; click plays, Enter / double click compares (R2, later).
// Footer: Compare, Add to project, xeno-canto.org, licence of the selected recording.
// Searching, audio and adding come from outside (main.js); the filter logic lives in app/xc-reference.ts.

import { DEFAULT_FILTERS, type XcFilters, type XcRef, type XcSort } from '../../app/xc-reference.ts';
import type { SnapPatch } from '../../domain/snapToCall.ts';
import { paintPatch } from './suggestions-panel.ts';
import { prefs } from '../../infrastructure/storage/prefs.ts';

const FILTER_KEY = 'aw.reference.filters';
const SORT_KEY = 'aw.reference.sort';

export interface RefTarget {
    /** Label id (a label) or suggestion key (a suggestion). */
    id?: string;
    /** Scientific name (search key). */
    sci: string;
    /** Name in the label language. */
    name: string;
    color?: string;
    /** The own clip (seconds); absent: species only (e.g. from the label template). */
    start?: number;
    end?: number;
    /** Where it comes from, shown under the clip: "suggestion 0.71", "label". */
    source?: string;
}

export interface RefSearchResult { total: number; pages: number; refs: XcRef[] }

export interface ReferencePanelOptions {
    search: (sci: string, f: XcFilters, sort: XcSort, page: number) => Promise<RefSearchResult>;
    /** Play / stop an XC recording; resolves when playback started (or failed). */
    play: (ref: XcRef) => Promise<void>;
    stop: () => void;
    /** Play the own clip in the editor. */
    playClip: (t: RefTarget) => void;
    /** dB patch of the own clip (null: not ready). */
    patch: (t: RefTarget) => SnapPatch | null;
    /** Fallback picture of the own clip when no patch is at hand (e.g. long recordings): a rendered tile. */
    tile?: (t: RefTarget) => Promise<ImageData | null>;
    addToProject: (ref: XcRef) => void;
    openExternal: (ref: XcRef) => void;
    /** Compare view (R2); without it the button is hidden. */
    compare?: (t: RefTarget, ref: XcRef, list: XcRef[]) => void;
    /** Recording location known (enables the distance chips). */
    hasLocation: () => boolean;
}

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls = '', text = '') => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text) e.textContent = text;
    return e;
};
const fmtLen = (s: number) => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}`;
const fmtT = (t: number) => { const m = Math.floor(t / 60); return `${m}:${(t - m * 60).toFixed(1).padStart(4, '0')}`; };
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

type Chip<K extends keyof XcFilters> = { key: K; v: XcFilters[K]; t: string; title?: string };
const TYPE_CHIPS: Chip<'type'>[] = [
    { key: 'type', v: 'song', t: 'song' }, { key: 'type', v: 'call', t: 'call' }, { key: 'type', v: 'alarm call', t: 'alarm' },
    { key: 'type', v: '', t: 'any type' },
];
const Q_CHIPS: Chip<'quality'>[] = [
    { key: 'quality', v: 'A', t: 'Q A' }, { key: 'quality', v: 'AB', t: 'Q ≥ B' }, { key: 'quality', v: 'any', t: 'any Q' },
];
const LEN_CHIPS: Chip<'maxLenS'>[] = [
    { key: 'maxLenS', v: 20, t: '≤ 20 s' }, { key: 'maxLenS', v: 60, t: '≤ 1 min' }, { key: 'maxLenS', v: 0, t: 'any length' },
];
const NEAR_CHIPS: Chip<'nearKm'>[] = [
    { key: 'nearKm', v: 100, t: '≤ 100 km' }, { key: 'nearKm', v: 500, t: '≤ 500 km' }, { key: 'nearKm', v: 0, t: 'world' },
];

export class ReferencePanel {
    readonly el = el('div', 'ref-panel');
    /** Follow the suggestion / label under review (off: the species stays). */
    follow = true;
    private filters: XcFilters = { ...DEFAULT_FILTERS, ...(prefs.json<Partial<XcFilters>>(FILTER_KEY, {}) || {}) };
    private sort: XcSort = (prefs.get(SORT_KEY) as XcSort) || 'quality';
    private target: RefTarget | null = null;
    private refs: XcRef[] = [];
    private total = 0;
    private pages = 0;
    private page = 1;
    private selected: string | null = null;
    private playing: string | null = null;
    private status = '';
    private loading = false;
    private gen = 0;
    private clipRetries = 0;

    private head = el('div', 'ref-head');
    private clip = el('div', 'ref-clip');
    private bar = el('div', 'ref-bar');
    private grid = el('div', 'ref-grid');
    private foot = el('div', 'ref-foot');
    private credit = el('div', 'ref-credit');

    constructor(private opts: ReferencePanelOptions) {
        this.el.append(this.head, this.clip, this.bar, this.grid, this.foot, this.credit);
        this.el.tabIndex = -1;
        this.el.addEventListener('keydown', (e) => this.onKey(e));
        this.render();
    }

    get species() { return this.target?.sci ?? null; }

    /** Candidates of a species with the panel's filters and sort (compare window: cross-check). */
    async searchFor(sci: string) { return (await this.opts.search(sci, this.filters, this.sort, 1)).refs; }

    /** New suggestion / label under review. Ignored while pinned, unless `force`. */
    setTarget(t: RefTarget | null, { force = false } = {}) {
        if (!t?.sci) { if (force || this.follow) { this.target = t; this.renderClip(); } return; }
        if (!force && !this.follow && this.target) {
            // pinned: a clip of the same species still replaces the clip
            if (t.sci !== this.target.sci) return;
        }
        const speciesChanged = t.sci !== this.target?.sci;
        this.target = t;
        this.renderHead();
        this.renderClip();
        if (speciesChanged) void this.load(1);
    }

    /** Panel became visible: search if the species was set while hidden. */
    onShow() {
        if (this.target?.sci && !this.refs.length && !this.loading && !this.status) void this.load(1);
        this.renderClip();
    }

    /** Recording changed: the clip is gone, the species may stay. */
    clearClip() {
        if (this.target) this.target = { sci: this.target.sci, name: this.target.name, color: this.target.color };
        this.renderClip();
    }

    stopped() { this.playing = null; this.renderGrid(); }

    private async load(page: number) {
        const t = this.target;
        if (!t?.sci) return;
        const gen = ++this.gen;
        this.loading = true;
        this.status = page === 1 ? 'Searching Xeno-canto…' : this.status;
        if (page === 1) { this.refs = []; this.selected = null; }
        this.renderBar(); this.renderGrid();
        try {
            const res = await this.opts.search(t.sci, this.filters, this.sort, page);
            if (gen !== this.gen) return;
            this.refs = page === 1 ? res.refs : [...this.refs, ...res.refs.filter((r) => !this.refs.some((x) => x.id === r.id))];
            this.total = res.total; this.pages = res.pages; this.page = page;
            this.status = '';
            if (!this.selected && this.refs[0]) this.selected = this.refs[0].id;
        } catch (err) {
            if (gen !== this.gen) return;
            this.status = err instanceof Error ? err.message : String(err);
        } finally {
            if (gen === this.gen) { this.loading = false; this.render(); }
        }
    }

    private setFilter<K extends keyof XcFilters>(key: K, v: XcFilters[K]) {
        if (this.filters[key] === v) return;
        this.filters = { ...this.filters, [key]: v };
        prefs.setJson(FILTER_KEY, this.filters);
        this.renderHead();
        void this.load(1);
    }

    private render() { this.renderHead(); this.renderClip(); this.renderBar(); this.renderGrid(); this.renderFoot(); }

    private renderHead() {
        const t = this.target;
        const row = el('div', 'ref-row');
        const sp = el('div', 'ref-species');
        if (t) {
            const sw = el('span', 'ref-sw');
            if (t.color) sw.style.background = t.color;
            sp.append(sw, el('b', '', t.name || t.sci));
            if (t.name && t.name !== t.sci) sp.append(el('i', '', t.sci));
        } else sp.append(el('span', 'ref-muted', 'No species – pick a suggestion or label'));
        const fl = el('label', 'ref-follow');
        const cb = el('input');
        cb.type = 'checkbox'; cb.checked = this.follow;
        cb.onchange = () => { this.follow = cb.checked; };
        fl.title = 'Follow the suggestion or label under review; off keeps this species';
        fl.append(cb, document.createTextNode(' follows selection'));
        row.append(sp, fl);
        const chips = el('div', 'ref-chips');
        const hasLoc = this.opts.hasLocation();
        const add = <K extends keyof XcFilters>(list: Chip<K>[]) => {
            for (const c of list) {
                const b = el('button', 'ref-chip', c.t);
                b.type = 'button';
                const off = c.key === 'nearKm' && !hasLoc;
                // without a location the search is world-wide, whatever the chip says
                b.classList.toggle('on', off ? c.v === 0 : this.filters[c.key] === c.v);
                if (off && c.v) { b.disabled = true; b.title = 'No recording location set'; }
                b.onclick = () => this.setFilter(c.key, c.v);
                chips.append(b);
            }
            chips.append(el('span', 'ref-chip-gap'));
        };
        add(TYPE_CHIPS); add(Q_CHIPS); add(LEN_CHIPS); add(NEAR_CHIPS);
        const season = el('button', 'ref-chip', 'same season');
        season.type = 'button';
        season.classList.toggle('on', this.filters.sameSeason);
        season.title = 'Only recordings from the month of this recording ± 1';
        season.onclick = () => this.setFilter('sameSeason', !this.filters.sameSeason);
        chips.append(season);
        this.head.replaceChildren(row, chips);
    }

    private renderClip() {
        const t = this.target;
        this.clip.hidden = !(t && t.start != null && t.end != null);
        if (this.clip.hidden || !t) return;
        const c = el('canvas', 'ref-clip-canvas');
        c.width = 240; c.height = 64;
        const p = this.opts.patch(t);
        if (p) { paintPatch(c, p); this.clipRetries = 0; }
        else if (this.opts.tile) {
            void this.opts.tile(t).then((img) => {
                if (!img || this.target !== t) return;
                c.width = img.width; c.height = img.height;
                c.getContext('2d')?.putImageData(img, 0, 0);
            }).catch(() => {});
        } else if (this.clipRetries < 8) {
            // spectrogram not ready yet (recording just opened): try again shortly
            this.clipRetries++;
            setTimeout(() => { if (this.target === t) this.renderClip(); }, 400);
        }
        const side = el('div', 'ref-clip-side');
        const play = el('button', 'ref-btn small', '▶ Your clip');
        play.title = 'Play your clip in the editor';
        play.onclick = () => this.opts.playClip(t);
        side.append(play, el('span', '', `${fmtT(t.start!)} · ${Math.round(t.end! - t.start!)} s`));
        if (t.source) side.append(el('span', 'ref-muted', t.source));
        this.clip.replaceChildren(c, side);
    }

    private renderBar() {
        const left = el('span', 'ref-count');
        if (this.status) left.textContent = this.status;
        else if (this.target) left.textContent = `${this.total} on Xeno-canto · ${this.refs.length} shown`;
        left.classList.toggle('err', !!this.status && !this.loading);
        const sel = el('select', 'ref-sort');
        for (const [v, t] of [['quality', 'Sort: quality'], ['distance', 'Sort: distance'], ['length', 'Sort: length']] as const) {
            const o = el('option', '', t); o.value = v; o.selected = this.sort === v; sel.append(o);
        }
        sel.onchange = () => { this.sort = sel.value as XcSort; prefs.set(SORT_KEY, this.sort); void this.load(1); };
        this.bar.replaceChildren(left, sel);
    }

    private renderGrid() {
        const tiles: HTMLElement[] = this.refs.map((r) => this.tile(r));
        if (this.pages > this.page && !this.loading) {
            const more = el('button', 'ref-btn ref-more', 'Load more');
            more.onclick = () => void this.load(this.page + 1);
            tiles.push(more);
        }
        this.grid.replaceChildren(...tiles);
        this.renderFoot();
    }

    private tile(r: XcRef) {
        const t = el('div', 'ref-tile');
        t.tabIndex = 0;
        t.dataset.id = r.id;
        t.classList.toggle('on', r.id === this.selected);
        t.classList.toggle('playing', r.id === this.playing);
        const img = el('div', 'ref-sono');
        if (r.sono) { const i = el('img'); i.src = r.sono; i.alt = ''; i.loading = 'lazy'; i.referrerPolicy = 'no-referrer'; img.append(i); }
        if (r.type) img.append(el('span', 'ref-type', r.type));
        if (r.q) img.append(el('span', `ref-q q-${r.q.toLowerCase()}`, r.q));
        if (r.id === this.playing) img.append(el('span', 'ref-playing', '■'));
        const meta = el('div', 'ref-meta');
        meta.append(el('b', '', `XC ${r.id}`), el('span', '', r.lenS ? fmtLen(r.lenS) : ''),
            el('span', '', [r.country, r.distKm != null ? `${r.distKm} km` : ''].filter(Boolean).join(' · ')),
            el('span', '', r.month ? MONTHS[r.month - 1] : ''));
        t.append(img, meta);
        t.title = [r.type, r.q && `quality ${r.q}`, r.recordist, r.licence].filter(Boolean).join(' · ');
        t.onclick = () => this.togglePlay(r);
        t.ondblclick = () => this.compare(r);
        return t;
    }

    private async togglePlay(r: XcRef) {
        this.selected = r.id;
        if (this.playing === r.id) { this.opts.stop(); this.playing = null; this.renderGrid(); return; }
        this.playing = r.id;
        this.renderGrid();
        await this.opts.play(r);
    }

    private compare(r: XcRef) {
        if (this.opts.compare && this.target) this.opts.compare(this.target, r, this.refs);
    }

    private renderFoot() {
        const r = this.refs.find((x) => x.id === this.selected) || null;
        const btns: HTMLElement[] = [];
        if (this.opts.compare) {
            const c = el('button', 'ref-btn pri', '⇄ Compare');
            c.disabled = !r || !this.target;
            c.title = 'Compare your clip with this recording (Enter)';
            c.onclick = () => r && this.compare(r);
            btns.push(c);
        }
        const add = el('button', 'ref-btn', '+ Add to project');
        add.disabled = !r;
        add.title = 'Load this Xeno-canto recording into the project';
        add.onclick = () => r && this.opts.addToProject(r);
        const ext = el('button', 'ref-btn', 'xeno-canto.org ↗');
        ext.disabled = !r;
        ext.onclick = () => r && this.opts.openExternal(r);
        btns.push(add, ext);
        this.foot.replaceChildren(...btns);
        this.credit.textContent = r ? [`XC ${r.id}`, r.recordist && `© ${r.recordist}`, r.licence].filter(Boolean).join(' · ') : '';
    }

    /** ←→↑↓ move the selection, Space plays, Enter compares. */
    private onKey(e: KeyboardEvent) {
        if (e.target instanceof HTMLSelectElement || e.target instanceof HTMLInputElement) return;
        const i = this.refs.findIndex((r) => r.id === this.selected);
        const cols = Math.max(1, Math.round(this.grid.clientWidth / 150));
        const step: Record<string, number> = { ArrowRight: 1, ArrowLeft: -1, ArrowDown: cols, ArrowUp: -cols };
        if (e.key in step) {
            e.preventDefault();
            const n = this.refs[Math.max(0, Math.min(this.refs.length - 1, (i < 0 ? 0 : i + step[e.key])))];
            if (n) { this.selected = n.id; this.renderGrid(); this.grid.querySelector<HTMLElement>(`[data-id="${n.id}"]`)?.focus(); }
        } else if (e.key === ' ' && i >= 0) {
            e.preventDefault(); e.stopPropagation(); void this.togglePlay(this.refs[i]);
        } else if (e.key === 'Enter' && i >= 0) {
            e.preventDefault(); this.compare(this.refs[i]);
        }
    }
}
