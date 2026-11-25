// suggestions-panel.ts — review BirdNET suggestions of one recording (Lite, Annotate v2 mockup B4/B6)
//
// Panel "Suggestions" (right column, full height): head with progress, join + minimum confidence,
// one block per species (confidence strip with threshold, tiles with a mini spectrogram, ✓ all ≥ t / ✕ rest),
// bulk buttons at the bottom. ReviewStrip sits in the editor between head and player:
// "Suggestion 4 / 11 · species 0.71 · also …" with Accept / Reject / Unsure and ‹ ›.
// Data and decisions come from outside (suggestions.ts model; main.js adopts / sets `review`).

import type { Suggestion, SuggestionGroup, ReviewState } from '../../app/suggestions.ts';
import type { SnapPatch } from '../../domain/snapToCall.ts';
import { showContextMenu } from '../components/context-menu/context-menu.ts';
import { prefs } from '../../infrastructure/storage/prefs.ts';

const OPT_KEY = 'aw.suggestions.options';
/** Review options in the ⋯ menu (mockup B6): kept across sessions. */
function loadOptions(): { autoPlay: boolean; fit: boolean } {
    const o = prefs.json<{ autoPlay?: boolean; fit?: boolean }>(OPT_KEY, {}) || {};
    return { autoPlay: o.autoPlay !== false, fit: o.fit !== false };
}

export type Decision = 'accepted' | 'rejected' | 'unsure' | 'open';

export interface SuggestionsPanelOptions {
    /** Show this suggestion in the editor (seek, zoom, maybe play). */
    pick: (s: Suggestion) => void;
    decide: (list: Suggestion[], d: Decision) => void;
    /** Join / minimum confidence / show-done changed: rebuild and render again. */
    changed: () => void;
    /** dB patch for a tile (null: not ready yet, the tile stays plain). */
    patch?: (s: Suggestion) => SnapPatch | null;
}

export interface SuggestionsData {
    groups: SuggestionGroup[];
    progress: { total: number; reviewed: number; windows: number; byState: Record<ReviewState, number> };
    current: string | null;
}

const STATE_MARK: Record<ReviewState, string> = { open: '', accepted: '✓', rejected: '✕', unsure: '?' };
const DEFAULT_T = 0.7;
const BULK_HIGH = 0.7, BULK_LOW = 0.5;
const fmtTime = (t: number) => {
    const m = Math.floor(t / 60), s = t - m * 60;
    return `${m}:${s.toFixed(1).padStart(4, '0')}`;
};
const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls = '', text = '') => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text) e.textContent = text;
    return e;
};

/** Paint a dB patch (frames × bins) into a canvas, low frequencies at the bottom, up to `maxHz`. */
export function paintPatch(canvas: HTMLCanvasElement, p: SnapPatch, maxHz = 12000) {
    const w = canvas.width, h = canvas.height;
    const ctx = canvas.getContext('2d');
    if (!ctx || !p.frames || !p.bins) return;
    const top = Math.max(1, Math.min(p.bins, Math.ceil((maxHz - p.f0) / p.df)));
    let hi = -Infinity;
    for (let i = 0; i < p.values.length; i++) if (p.values[i] > hi) hi = p.values[i];
    const lo = hi - 60;
    const img = ctx.createImageData(w, h);
    for (let x = 0; x < w; x++) {
        const f = Math.min(p.frames - 1, Math.floor(x * p.frames / w));
        for (let y = 0; y < h; y++) {
            const b = Math.min(top - 1, Math.floor((h - 1 - y) * top / h));
            const v = Math.max(0, Math.min(1, (p.values[f * p.bins + b] - lo) / (hi - lo)));
            // dark violet → orange → yellow, like the editor's default colour map
            const o = (y * w + x) * 4;
            img.data[o] = Math.round(30 + 225 * Math.min(1, v * 1.4));
            img.data[o + 1] = Math.round(10 + 200 * v * v);
            img.data[o + 2] = Math.round(60 + 60 * (1 - v));
            img.data[o + 3] = 255;
        }
    }
    ctx.putImageData(img, 0, 0);
}

export class SuggestionsPanel {
    readonly el = el('div', 'sugg-panel');
    join = true;
    minConfidence = 0.3;
    showDone = true;
    /** After a decision: play the next suggestion (A / X / U jump on). */
    autoPlay = loadOptions().autoPlay;
    /** Zoom the editor to the suggestion when it is shown. */
    fit = loadOptions().fit;
    /** Threshold per species key (dragged on its strip). */
    private thresholds = new Map<string, number>();
    private collapsed = new Set<string>();
    private data: SuggestionsData | null = null;
    private thumbs = new Map<string, HTMLCanvasElement>();

    constructor(private opts: SuggestionsPanelOptions) {}

    private gkey(g: SuggestionGroup) { return (g.scientificName || g.species).toLowerCase(); }
    threshold(g: SuggestionGroup) { return this.thresholds.get(this.gkey(g)) ?? DEFAULT_T; }

    render(data: SuggestionsData | null) {
        this.data = data;
        const root = this.el;
        root.replaceChildren();
        if (!data || !data.progress.total) {
            root.append(el('div', 'sugg-empty', data ? 'No BirdNET suggestions in this recording. Run BirdNET (B) in Analyse.'
                : 'Open a recording to review its suggestions.'));
            return;
        }
        root.append(this.head(data));
        const list = el('div', 'sugg-list');
        for (const g of data.groups) list.append(this.group(g, data.current));
        root.append(list, this.foot(data));
        root.querySelector('.sugg-tile.current')?.scrollIntoView({ block: 'nearest' });
    }

    private head(d: SuggestionsData) {
        const h = el('div', 'sugg-head');
        const row = el('div', 'sugg-row');
        const join = el('label', 'sugg-join');
        const cb = el('input');
        cb.type = 'checkbox';
        cb.checked = this.join;
        cb.onchange = () => { this.join = cb.checked; this.opts.changed(); };
        join.append(cb, document.createTextNode(' Join runs'));
        join.title = 'Adjacent 3 s windows of one species count as one suggestion';
        const min = el('label', 'sugg-min', 'min ');
        const num = el('input');
        num.type = 'number'; num.min = '0'; num.max = '1'; num.step = '0.05';
        num.value = String(this.minConfidence);
        num.onchange = () => { this.minConfidence = Math.max(0, Math.min(1, Number(num.value) || 0)); this.opts.changed(); };
        min.append(num);
        const done = el('button', 'sugg-btn small', this.showDone ? 'Hide done' : 'Show done');
        done.onclick = () => { this.showDone = !this.showDone; this.render(this.data); };
        const more = el('button', 'sugg-btn small sugg-more', '⋯');
        more.title = 'Review options';
        more.onclick = () => {
            const r = more.getBoundingClientRect();
            const save = () => prefs.setJson(OPT_KEY, { autoPlay: this.autoPlay, fit: this.fit });
            showContextMenu({
                x: r.left, y: r.bottom,
                items: [
                    { heading: 'Review' },
                    { label: 'Join runs', checked: this.join, hint: '3 s windows', action: () => { this.join = !this.join; this.opts.changed(); } },
                    { label: 'Play next after a decision', checked: this.autoPlay, action: () => { this.autoPlay = !this.autoPlay; save(); } },
                    { label: 'Zoom to the suggestion', checked: this.fit, action: () => { this.fit = !this.fit; save(); } },
                ],
            });
        };
        row.append(join, min, done, more);
        const p = d.progress;
        const prog = el('div', 'sugg-progress', `Reviewed ${p.reviewed} of ${p.total} suggestions (${p.windows} windows)`);
        const bar = el('div', 'sugg-bar');
        for (const s of ['accepted', 'rejected', 'unsure'] as ReviewState[]) {
            const seg = el('span', `seg ${s}`);
            seg.style.width = `${(100 * p.byState[s]) / p.total}%`;
            bar.append(seg);
        }
        h.append(row, prog, bar);
        return h;
    }

    private group(g: SuggestionGroup, current: string | null) {
        const k = this.gkey(g);
        const box = el('section', 'sugg-group');
        const open = !this.collapsed.has(k);
        const t = this.threshold(g);
        const hd = el('div', 'sugg-ghead');
        const tw = el('button', 'sugg-twisty', open ? '▾' : '▸');
        tw.onclick = () => { open ? this.collapsed.add(k) : this.collapsed.delete(k); this.render(this.data); };
        const name = el('span', 'sugg-species', g.species);
        if (g.scientificName && g.scientificName !== g.species) name.title = g.scientificName;
        const n = el('span', 'sugg-count', `${g.suggestions.length} · ${g.windows} win.`);
        hd.append(tw, name, n);
        if (g.unexpected) hd.append(el('span', 'sugg-unexpected', 'check first'));
        const openOnes = g.suggestions.filter((s) => s.state === 'open');
        if (openOnes.length) {
            const hi = openOnes.filter((s) => s.confidence >= t), lo = openOnes.filter((s) => s.confidence < t);
            if (hi.length) {
                const a = el('button', 'sugg-btn ok small', `✓ ≥ ${t.toFixed(2)} (${hi.length})`);
                a.title = 'Accept the open suggestions of this species at or above the threshold';
                a.onclick = () => this.opts.decide(hi, 'accepted');
                hd.append(a);
            }
            const r = el('button', 'sugg-btn no small', hi.length ? `✕ rest (${lo.length})` : '✕ all');
            r.title = hi.length ? 'Reject the open suggestions below the threshold' : 'Reject every open suggestion of this species';
            r.disabled = hi.length > 0 && !lo.length;
            r.onclick = () => this.opts.decide(hi.length ? lo : openOnes, 'rejected');
            hd.append(r);
        }
        box.append(hd);
        if (!open) return box;
        box.append(this.strip(g));
        const tiles = el('div', 'sugg-tiles');
        for (const s of g.suggestions) {
            if (!this.showDone && s.state !== 'open' && s.key !== current) continue;
            tiles.append(this.tile(s, s.key === current));
        }
        box.append(tiles);
        return box;
    }

    /** One tick per window (colour = state), the threshold as a handle that can be dragged. */
    private strip(g: SuggestionGroup) {
        const s = el('div', 'sugg-strip');
        s.title = 'Confidence of each window; drag to set the threshold';
        for (const sg of g.suggestions) {
            for (const w of sg.windows) {
                const tick = el('span', `tick ${sg.state}`);
                tick.style.left = `${100 * (w.confidence ?? 0)}%`;
                s.append(tick);
            }
        }
        const handle = el('span', 'thr');
        const label = el('span', 'thr-label');
        const place = (v: number) => {
            handle.style.left = `${100 * v}%`;
            label.style.left = `${100 * v}%`;
            label.textContent = v.toFixed(2);
        };
        place(this.threshold(g));
        s.append(handle, label);
        s.onpointerdown = (e) => {
            s.setPointerCapture(e.pointerId);
            const at = (ev: PointerEvent) => {
                const r = s.getBoundingClientRect();
                const v = Math.round(Math.max(0, Math.min(1, (ev.clientX - r.left) / r.width)) * 100) / 100;
                this.thresholds.set(this.gkey(g), v);
                place(v);
            };
            at(e);
            s.onpointermove = at;
            s.onpointerup = () => { s.onpointermove = null; s.onpointerup = null; this.render(this.data); };
        };
        return s;
    }

    private tile(s: Suggestion, current: boolean) {
        const t = el('button', `sugg-tile ${s.state}${current ? ' current' : ''}`);
        t.title = `${s.species} ${s.confidence.toFixed(2)} · ${fmtTime(s.start)}–${fmtTime(s.end)}\nClick: show · A / X / U: decide`;
        const c = this.thumb(s);
        t.append(c);
        t.append(el('span', 'conf', s.confidence.toFixed(2)), el('span', 'time', fmtTime(s.start)));
        if (s.windows.length > 1) t.append(el('span', 'runs', `×${s.windows.length}`));
        if (STATE_MARK[s.state]) t.append(el('span', 'mark', STATE_MARK[s.state]));
        t.onclick = () => this.opts.pick(s);
        t.oncontextmenu = (e) => { e.preventDefault(); this.opts.decide([s], s.state === 'open' ? 'rejected' : 'open'); };
        return t;
    }

    private thumb(s: Suggestion) {
        const key = `${s.key}|${s.end}`;
        let c = this.thumbs.get(key);
        if (c) return c;
        c = el('canvas', 'thumb');
        c.width = 120; c.height = 56;
        const p = this.opts.patch?.(s);
        if (p) { paintPatch(c, p); this.thumbs.set(key, c); }
        return c;
    }

    /** New recording: tiles of the old one are no longer needed. */
    clearThumbs() { this.thumbs.clear(); }

    private foot(d: SuggestionsData) {
        const f = el('div', 'sugg-foot');
        const all = d.groups.flatMap((g) => g.suggestions).filter((s) => s.state === 'open');
        const hi = all.filter((s) => s.confidence >= BULK_HIGH), lo = all.filter((s) => s.confidence < BULK_LOW);
        const a = el('button', 'sugg-btn ok', `✓ Accept open ≥ ${BULK_HIGH.toFixed(2)} (${hi.length})`);
        a.disabled = !hi.length;
        a.onclick = () => this.opts.decide(hi, 'accepted');
        const r = el('button', 'sugg-btn no', `✕ Reject open < ${BULK_LOW.toFixed(2)} (${lo.length})`);
        r.disabled = !lo.length;
        r.onclick = () => this.opts.decide(lo, 'rejected');
        f.append(a, r);
        return f;
    }
}

export interface ReviewStripOptions {
    decide: (d: Decision) => void;
    step: (dir: 1 | -1) => void;
    play: () => void;
}

/** "Suggestion 4 / 11 · Sperlingskauz 0.71 · also Waldkauz 0.12" + Accept / Reject / Unsure (editor, B6 ②). */
export class ReviewStrip {
    readonly el = el('div', 'review-strip');
    private text = el('span', 'rs-text');

    constructor(opts: ReviewStripOptions) {
        const btn = (cls: string, label: string, key: string, title: string, run: () => void) => {
            const b = el('button', `sugg-btn ${cls}`);
            b.append(document.createTextNode(label), el('kbd', '', key));
            b.title = title;
            b.onclick = run;
            return b;
        };
        const prev = el('button', 'sugg-btn small', '‹'), next = el('button', 'sugg-btn small', '›');
        prev.title = 'Previous suggestion'; next.title = 'Next suggestion';
        prev.onclick = () => opts.step(-1); next.onclick = () => opts.step(1);
        this.el.append(this.text,
            btn('play', '▶ ', 'Space', 'Play this suggestion', opts.play),
            btn('ok', '✓ Accept ', 'A', 'Copy into my labels (fits to the call box when BirdBox found one)', () => opts.decide('accepted')),
            btn('no', '✕ Reject ', 'X', 'Not this species', () => opts.decide('rejected')),
            btn('maybe', '? Unsure ', 'U', 'Decide later', () => opts.decide('unsure')),
            prev, next);
        this.el.hidden = true;
    }

    /** `others`: other species detected in the same time span. */
    show(s: Suggestion | null, index: number, total: number, others: { species: string; confidence: number }[] = []) {
        this.el.hidden = !s;
        if (!s) return;
        this.text.replaceChildren(
            document.createTextNode(`Suggestion ${index + 1} / ${total} · `),
            el('b', '', s.species), document.createTextNode(' '),
            el('span', 'rs-conf', s.confidence.toFixed(2)),
        );
        if (s.state !== 'open') this.text.append(el('span', `rs-state ${s.state}`, ` ${s.state}`));
        if (others.length) {
            this.text.append(el('span', 'rs-also', ` also ${others.slice(0, 3).map((o) => `${o.species} ${o.confidence.toFixed(2)}`).join(', ')}`));
        }
    }
}
