// label-modal.ts — label window in the style of FiftyOne's sample modal (Lite, Annotate v2 mockup M2)
//
// Head: species · sound type, file, clock time; ‹ n / N › and ← → through the labels of the recording; ×.
// Left: tool bar (play, Label only / ±2 s, Loop, ×0.5, time; Fit to call, Similar, Open in editor),
// the label with context (outside dimmed, neighbours as dashed ghosts, box draggable), waveform,
// film strip of all labels (absent hatched). Right: Fields | History (label-fields-form.ts).
// Foot: Delete, Duplicate, Keep species + tags for next labels · "Changes save when you leave the label" · Revert, Done.
// Every change applies at once; all changes to one label until leaving it = one undo step (host).
// Several labels (M3): Shift/Ctrl-click in the film strip, Ctrl A, or opened with a selection → the selection
// as tiles, fields shared by all (multi-fields-form.ts), Delete N; everything until leaving it = one undo step.

import { LabelFieldsForm, type FieldsFormOptions } from './label-fields-form.ts';
import { MultiFieldsForm, updatesFor, type MultiEdit } from './multi-fields-form.ts';
import { getSpectrogramColor } from '../../../domain/spectrogram.ts';
import { colorForName } from '../../../domain/annotations.ts';
import type { SnapPatch } from '../../../domain/snapToCall.ts';

export interface LabelModalHost {
    /** Labels of the recording in film-strip order (own and detections). */
    labels: () => any[];
    /** Apply updates to a label now (no undo step: the host makes one per visit). */
    change: (id: string, updates: Record<string, any>) => void;
    /** Undo point before the first change to a label; returns the restore function. */
    snapshot: () => () => void;
    /** One undo step for the visit of a label that changed something. */
    commitVisit: (label: any, restore: () => void) => void;
    remove: (id: string) => void;
    /** Delete several as one undo step. */
    removeMany?: (ids: string[]) => void;
    /** Returns the id of the copy. */
    duplicate: (id: string) => string | null;
    fitToCall: (id: string) => void;
    canFit: (label: any) => boolean;
    similar: (id: string) => void;
    openInEditor: (id: string) => void;
    keepAsTemplate: (label: any) => void;
    /** dB patch for a time span (null: not ready). */
    patch: (start: number, end: number) => SnapPatch | null;
    /** Mono samples for the waveform. */
    samples: () => { data: Float32Array; rate: number } | null;
    play: (start: number, end: number, opts: { loop: boolean; slow: boolean }) => void;
    stop: () => void;
    currentTime: () => number;
    isPlaying: () => boolean;
    colorScheme: () => string;
    maxFreq: () => number;
    /** Length of the recording (s); a moved box stays inside it. */
    duration?: () => number;
    fileName: () => string;
    clock: ((sec: number) => string) | null;
    fields: Omit<FieldsFormOptions, 'change'>;
    /** "2 from BirdNET, 1 drawn" for several labels. */
    sourceSummary?: (labels: any[]) => string;
}

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls = '', text = '') => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text) e.textContent = text;
    return e;
};
const btn = (cls: string, html: string, title = '') => {
    const b = el('button', 'lm-b ' + cls);
    b.type = 'button';
    b.innerHTML = html;
    if (title) b.title = title;
    return b;
};

const CONTEXT = 2;          // seconds of context on each side
const MAX_SPAN = 30;        // longest span drawn (s)

export class LabelModal {
    readonly el = el('div', 'lm-backdrop');
    private box = el('div', 'lm');
    private id: string;
    private form: LabelFieldsForm;
    private visit: { id: string; restore: () => void; changed: boolean; name?: string } | null = null;
    /** Several labels selected (M3) when it holds more than one id. */
    private sel = new Set<string>();
    private multi: MultiFieldsForm;
    /** "Play one after another": what is left to play. */
    private queue: any[] = [];
    private wasPlaying = false;
    private mode: 'label' | 'context' = 'label';
    private loop = false;
    private slow = false;
    private keep = false;
    private tab: 'fields' | 'history' = 'fields';
    private raf = 0;
    private win = { t0: 0, t1: 1, f0: 0, f1: 1 };
    private canvas = el('canvas', 'lm-canvas');
    private cropEl = el('div', 'lm-crop');
    private timeEl = el('span', 'lm-time');
    private playBtn!: HTMLButtonElement;
    private onKey = (e: KeyboardEvent) => this.key(e);
    /** Film-strip tiles by label geometry (an STFT each; drawn once). */
    private tiles = new Map<string, HTMLCanvasElement>();
    private pending = 0;

    constructor(private h: LabelModalHost, id: string, selection: string[] = []) {
        this.id = id;
        this.form = new LabelFieldsForm({ ...h.fields, change: (u) => this.change(u) });
        this.multi = new MultiFieldsForm({
            edit: (e) => this.editAll(e),
            speciesSearch: h.fields.speciesSearch,
            tagPresets: h.fields.tagPresets,
            sourceSummary: h.sourceSummary || ((ls) => `${ls.length} labels`),
        });
        if (selection.length > 1) this.sel = new Set(selection);
    }

    private get isMulti() { return this.sel.size > 1; }
    /** The selected labels in film-strip order. */
    private get selected() { return this.h.labels().filter((l) => this.sel.has(l.id)); }

    private editAll(e: MultiEdit) {
        for (const l of this.selected) if (!l.readonly) this.h.change(l.id, updatesFor(l, e));
        if (this.visit) this.visit.changed = true;
        this.refresh();
    }

    /** Change the selection (leaving one label or one selection ends its undo step). */
    private select(ids: string[]) {
        const list = this.h.labels().map((l) => l.id);
        const next = new Set(ids.filter((x) => list.includes(x)));
        const wasMulti = this.isMulti;
        this.endVisit();
        this.h.stop(); this.queue = []; this.wasPlaying = false;
        this.sel = next.size > 1 ? next : new Set();
        if (next.size === 1) this.id = [...next][0];
        if (!this.isMulti && wasMulti && !next.size) this.sel = new Set();
        this.multi.changed.clear();
        this.startVisit();
        this.render();
    }

    get current() { return this.h.labels().find((l) => l.id === this.id) || null; }

    open() {
        this.el.append(this.box);
        document.body.append(this.el);
        this.el.addEventListener('pointerdown', (e) => { if (e.target === this.el) this.close(); });
        document.addEventListener('keydown', this.onKey, true);
        this.startVisit();
        this.render();
        this.tick();
        // Keyboard users start inside the window (Tab then stays in it, see key()).
        this.box.tabIndex = -1;
        this.box.focus({ preventScroll: true });
    }

    close() {
        this.endVisit();
        this.h.stop();
        this.drawTok++;
        cancelAnimationFrame(this.raf);
        document.removeEventListener('keydown', this.onKey, true);
        this.form.destroy();
        this.multi.destroy();
        this.el.remove();
    }

    /** The label changed outside (undo, other panel): draw again. */
    refresh() {
        if (!this.el.isConnected || this.pending) return;
        this.pending = requestAnimationFrame(() => {
            this.pending = 0;
            if (!this.el.isConnected) return;
            if (this.isMulti) {
                const left = this.selected.map((l) => l.id);
                if (left.length !== this.sel.size) { this.sel = new Set(left.length > 1 ? left : []); if (left.length === 1) this.id = left[0]; }
                if (!this.isMulti && !this.current) { this.close(); return; }
                this.render();
            } else if (!this.current) this.close(); else this.render();
        });
    }

    private startVisit() {
        this.visit = this.isMulti
            ? { id: '', restore: this.h.snapshot(), changed: false, name: `${this.sel.size} labels` }
            : { id: this.id, restore: this.h.snapshot(), changed: false };
    }
    private endVisit() {
        const v = this.visit;
        this.visit = null;
        if (v?.changed) {
            const l = v.name ? { id: '', label: v.name } : this.h.labels().find((x) => x.id === v.id);
            this.h.commitVisit(l || { id: v.id }, v.restore);
        }
    }

    private change(u: Record<string, any>) {
        if (!this.current || this.current.readonly) return;
        if (this.visit) this.visit.changed = true;
        this.h.change(this.id, u);
        this.refresh();
    }

    private go(dir: number) {
        const list = this.h.labels();
        const i = list.findIndex((l) => l.id === this.id);
        if (!list.length) return;
        const next = list[(i + dir + list.length) % list.length];
        this.goto(next.id);
    }

    private goto(id: string) {
        if (id === this.id) return;
        this.endVisit();
        this.h.stop();
        this.id = id;
        this.startVisit();
        this.render();
    }

    private key(e: KeyboardEvent) {
        const t = e.target as HTMLElement;
        const typing = t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName));
        if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); if (typing) t.blur(); else this.close(); return; }
        if (e.key === 'Tab') { e.stopPropagation(); this.trapTab(e); return; }   // also from a field
        if (typing) return;
        e.stopPropagation();
        // A focused button or link: Enter / Space activate it (History, Revert, …), not the window shortcuts.
        if ((e.key === 'Enter' || e.key === ' ') && t !== this.box && t?.closest?.('button, a[href], [role="button"], summary')) return;
        if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a') { e.preventDefault(); this.select(this.h.labels().map((l) => l.id)); return; }
        if (e.shiftKey && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) { e.preventDefault(); this.extend(e.key === 'ArrowLeft' ? -1 : 1); return; }
        if (this.isMulti) {
            if (e.key === 'Enter') { e.preventDefault(); this.close(); }
            else if (e.key === ' ') { e.preventDefault(); this.togglePlay(); }
            else if (e.key === 'Delete' || e.key === 'Del') { e.preventDefault(); this.delAll(); }
            return;
        }
        if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') { e.preventDefault(); this.go(e.key === 'ArrowLeft' ? -1 : 1); }
        else if (e.key === 'Enter') { e.preventDefault(); this.close(); }
        else if (e.key === ' ') { e.preventDefault(); this.togglePlay(); }
        else if (e.key === 'Delete' || e.key === 'Del') { e.preventDefault(); this.del(); }
    }

    private del() {
        const l = this.current;
        if (!l || l.readonly) return;
        const list = this.h.labels();
        const i = list.findIndex((x) => x.id === l.id);
        const next = list[i + 1] || list[i - 1] || null;
        this.endVisit();
        this.h.stop(); this.queue = []; this.wasPlaying = false;   // its clip must not play on (or loop) after it is gone
        this.h.remove(l.id);
        if (!next) { this.close(); return; }
        this.id = next.id;
        this.startVisit();
        this.render();
    }

    /** Shift ← →: add the neighbour of the selection's edge. */
    private extend(dir: number) {
        const list = this.h.labels();
        const ids = this.isMulti ? [...this.sel] : [this.id];
        const idx = ids.map((x) => list.findIndex((l) => l.id === x)).filter((i) => i >= 0);
        if (!idx.length) return;
        const j = dir < 0 ? Math.min(...idx) - 1 : Math.max(...idx) + 1;
        if (j < 0 || j >= list.length) return;
        this.select([...ids, list[j].id]);
    }

    private delAll() {
        const ls = this.selected.filter((l) => !l.readonly);
        if (!ls.length) return;
        this.endVisit();
        this.h.stop(); this.queue = []; this.wasPlaying = false;
        if (this.h.removeMany) this.h.removeMany(ls.map((l) => l.id));
        else for (const l of ls) this.h.remove(l.id);
        const left = this.h.labels();
        this.sel = new Set();
        if (!left.length) { this.close(); return; }
        if (!left.some((l) => l.id === this.id)) this.id = left[0].id;
        this.startVisit();
        this.render();
    }

    /** Tab / Shift+Tab wrap around inside the window (it is modal). */
    private trapTab(e: KeyboardEvent) {
        const all = [...this.box.querySelectorAll<HTMLElement>('button, a[href], input, select, textarea, summary, [tabindex]:not([tabindex="-1"])')]
            .filter((x) => !(x as HTMLButtonElement).disabled && x.offsetParent !== null);
        if (!all.length) { e.preventDefault(); return; }
        const i = all.indexOf(document.activeElement as HTMLElement);
        if (e.shiftKey && i <= 0) { e.preventDefault(); all[all.length - 1].focus(); }
        else if (!e.shiftKey && (i < 0 || i === all.length - 1)) { e.preventDefault(); all[0].focus(); }
    }

    private togglePlay() {
        // Stop: also forget that a clip was playing, or the next tick takes it as finished and loops on.
        if (this.h.isPlaying() || this.queue.length) { this.queue = []; this.wasPlaying = false; this.h.stop(); return; }
        if (this.isMulti) { this.queue = [...this.selected]; this.playNext(); return; }
        const l = this.current;
        if (!l) return;
        const [a, b] = this.mode === 'label' ? [l.start, l.end] : [Math.max(0, l.start - CONTEXT), l.end + CONTEXT];
        this.h.play(a, b, { loop: this.loop, slow: this.slow });
    }

    /** One after another; Loop starts over. */
    private playNext() {
        if (!this.queue.length && this.loop && this.isMulti) this.queue = [...this.selected];
        const l = this.queue.shift();
        if (!l) return;
        this.wasPlaying = false;
        this.h.play(l.start, l.end, { loop: false, slow: this.slow });
    }

    // ── rendering ──

    private render() {
        if (this.isMulti) { this.drawTok++; this.renderMulti(); return; }
        const l = this.current;
        if (!l) return;
        const list = this.h.labels();
        const i = list.findIndex((x) => x.id === l.id);
        this.box.replaceChildren(this.head(l, i, list.length), this.body(l, list), this.foot(l));
        this.form.render(l);
        const tok = ++this.drawTok;   // a later render (or multi mode, or close) makes this draw void
        requestAnimationFrame(() => { if (tok === this.drawTok && !this.isMulti && this.el.isConnected) this.draw(l, list); });
    }
    private drawTok = 0;

    // ── several labels (M3) ──

    private renderMulti() {
        const ls = this.selected;
        const list = this.h.labels();
        // head
        const h = el('div', 'lm-head');
        const t = el('div', 'lm-title');
        t.append(el('span', 'lm-kind', '☑'), el('b', '', `${ls.length} labels selected`));
        const nav = el('div', 'lm-nav');
        const x = btn('lm-x', '✕', 'Close (Esc)');
        x.onclick = () => this.close();
        nav.append(el('span', 'lm-kbd', 'Ctrl A'), el('span', '', `all ${list.length} ·`), el('span', 'lm-kbd', 'Shift ← →'), el('span', '', 'extend'), x);
        h.append(t, el('span', 'lm-file', this.h.fileName()), nav);
        // body: tool bar, tiles, film strip | fields
        const b = el('div', 'lm-body');
        const media = el('div', 'lm-media');
        const tb = el('div', 'lm-tb');
        this.playBtn = btn('lm-play', '▶', 'Play one after another (Space)');
        this.playBtn.onclick = () => this.togglePlay();
        const seq = btn('on', 'Play one after another');
        seq.onclick = () => this.togglePlay();
        const loop = btn(this.loop ? 'on' : '', 'Loop');
        loop.onclick = () => { this.loop = !this.loop; this.render(); };
        const fitAble = ls.filter((l) => !l.readonly && this.h.canFit(l));
        const fit = btn('', '<span class="lm-ic">⛶</span> Fit all to calls', 'Fit each box to its call');
        fit.disabled = !fitAble.length;
        fit.onclick = () => { if (this.visit) this.visit.changed = true; for (const l of fitAble) this.h.fitToCall(l.id); this.render(); };
        tb.append(this.playBtn, seq, loop, el('span', 'lm-gap'), fit);
        const grid = el('div', 'lm-grid');
        for (const l of ls) grid.append(this.tile(l));
        media.append(tb, grid, this.film(this.current, list));
        const side = el('div', 'lm-side');
        const tabs = el('div', 'lm-tabs');
        tabs.append(btn('on', `Fields · ${ls.length} labels`), el('span', 'lm-tabs-r', 'only changed fields are written'));
        const pane = el('div', 'lm-pane');
        this.multi.render(ls);
        pane.append(this.multi.el);
        side.append(tabs, pane);
        b.append(media, side);
        // foot
        const f = el('div', 'lm-foot');
        const editable = ls.filter((l) => !l.readonly).length;
        const del = btn('lm-del', `Delete ${editable} <span class="lm-kbd">Del</span>`);
        del.disabled = !editable;
        del.onclick = () => this.delAll();
        const n = this.multi.changed.size;
        const ro = ls.length - editable;
        const note = el('span', 'lm-note', `${n ? `${n} field${n > 1 ? 's' : ''} changed · one undo step` : 'Changes apply to all selected'}${ro ? ` · ${ro} read-only` : ''}`);
        const revert = btn('', 'Revert', 'Back to how these labels were when you selected them');
        revert.disabled = !this.visit?.changed;
        revert.onclick = () => {
            if (!this.visit) return;
            this.visit.restore();
            this.multi.changed.clear();
            this.startVisit();
            this.render();
        };
        const done = btn('lm-done', 'Done <span class="lm-kbd">Enter</span>');
        done.onclick = () => this.close();
        f.append(del, el('span', 'lm-gap'), note, revert, done);
        this.box.replaceChildren(h, b, f);
    }

    /** A selected label as a tile: its call with a little context, the box, name and time. */
    private tile(l: any) {
        const card = el('button', 'lm-card' + (l.polarity === 'absent' ? ' absent' : ''));
        card.type = 'button';
        card.title = 'Open this label';
        card.onclick = () => this.select([l.id]);
        const wrap = el('div', 'lm-card-img');
        const c = el('canvas');
        c.width = 320; c.height = 220;
        wrap.append(c);
        const w = this.tileWin(l.start, l.end, l.freqMin, l.freqMax, l.fullBand === true);
        const full = l.fullBand === true || l.freqMin == null || l.freqMax == null;
        const bx = el('div', 'lm-card-box');
        const col = l.color || colorForName(l.label || '');
        bx.style.borderColor = col;
        bx.style.left = `${((l.start - w.a) / (w.b - w.a)) * 100}%`;
        bx.style.width = `${((l.end - l.start) / (w.b - w.a)) * 100}%`;
        bx.style.top = full ? '0' : `${((w.hi - l.freqMax) / (w.hi - w.lo)) * 100}%`;
        bx.style.height = full ? '100%' : `${((l.freqMax - l.freqMin) / (w.hi - w.lo)) * 100}%`;
        wrap.append(bx);
        const cap = el('div', 'lm-card-cap');
        const sw = el('span', 'lm-sw');
        sw.style.background = col;
        cap.append(sw, el('span', '', `${l.label || '–'}${l.polarity === 'absent' ? ' · absent' : l.tags?.soundType ? ` · ${l.tags.soundType}` : ''}`),
            el('span', 'lm-m', this.fmt(l.start).slice(0, 8)));
        card.append(wrap, cap);
        requestAnimationFrame(() => this.drawWin(c, w));   // the window the box above was placed in
        return card;
    }

    /** Time/frequency window of a tile: the label with a little context and its band (+ margin). */
    private tileWin(start: number, end: number, fLo: number | null, fHi: number | null, fullBand = false) {
        const pad = Math.max(0.15, (end - start) * 0.15);
        let lo = 0, hi = this.h.maxFreq();
        if (!fullBand && fLo != null && fHi != null && fHi > fLo) { const m = (fHi - fLo) * 0.3 + 300; lo = Math.max(0, fLo - m); hi = Math.min(hi, fHi + m); }
        return { a: Math.max(0, start - pad), b: end + pad, lo, hi };
    }

    private head(l: any, i: number, n: number) {
        const h = el('div', 'lm-head');
        const t = el('div', 'lm-title');
        const sw = el('span', 'lm-sw');
        sw.style.background = l.color || colorForName(l.label || '');
        const sound = l.tags?.soundType;
        t.append(el('span', 'lm-kind', 'Label'), sw, el('b', '', `${l.label || 'Unnamed'}${sound ? ` · ${sound}` : ''}`));
        const f = el('span', 'lm-file', `${this.h.fileName()} · ${this.h.clock ? this.h.clock(l.start).slice(0, 8) : `${l.start.toFixed(2)} s`}`);
        const nav = el('div', 'lm-nav');
        const prev = btn('lm-k', '‹', 'Previous label (←)');
        prev.onclick = () => this.go(-1);
        const next = btn('lm-k', '›', 'Next label (→)');
        next.onclick = () => this.go(1);
        const x = btn('lm-x', '✕', 'Close (Esc)');
        x.onclick = () => this.close();
        nav.append(el('span', '', 'label'), prev, el('span', 'lm-pos', `${i + 1} / ${n}`), next, el('span', 'lm-kbd', '← →'), x);
        h.append(t, f, nav);
        return h;
    }

    private body(l: any, list: any[]) {
        const b = el('div', 'lm-body');
        const media = el('div', 'lm-media');
        // tool bar
        const tb = el('div', 'lm-tb');
        this.playBtn = btn('lm-play', '▶', 'Play (Space)');
        this.playBtn.onclick = () => this.togglePlay();
        const only = btn(this.mode === 'label' ? 'on' : '', 'Label only', 'Play the label');
        only.onclick = () => { this.mode = 'label'; this.render(); };
        const ctx = btn(this.mode === 'context' ? 'on' : '', `± ${CONTEXT} s`, 'Play with context');
        ctx.onclick = () => { this.mode = 'context'; this.render(); };
        const loop = btn(this.loop ? 'on' : '', 'Loop');
        loop.onclick = () => { this.loop = !this.loop; this.render(); };
        const slow = btn(this.slow ? 'on' : '', '×0.5', 'Half speed');
        slow.onclick = () => { this.slow = !this.slow; this.render(); };
        this.timeEl.textContent = this.fmt(l.start);
        const ro = l.readonly === true;
        const fit = btn('', '<span class="lm-ic">⛶</span> Fit to call', 'Fit the box to the call');
        fit.disabled = ro || !this.h.canFit(l);
        fit.onclick = () => { if (this.visit) this.visit.changed = true; this.h.fitToCall(l.id); this.render(); };
        const sim = btn('', '<span class="lm-ic">∿</span> Similar', 'Find similar calls');
        sim.onclick = () => { this.close(); this.h.similar(l.id); };
        const ed = btn('', 'Open in editor ↗', 'Show the label in the editor');
        ed.onclick = () => { this.close(); this.h.openInEditor(l.id); };
        tb.append(this.playBtn, only, ctx, loop, slow, this.timeEl, el('span', 'lm-gap'), fit, sim, ed);
        // crop + axes
        const stage = el('div', 'lm-stage');
        this.cropEl.replaceChildren(this.canvas);
        const fa = el('div', 'lm-fa');
        const ta = el('div', 'lm-ta');
        stage.append(fa, this.cropEl, ta);
        const wave = el('div', 'lm-wave');
        wave.append(el('canvas', 'lm-wave-c'));
        const film = this.film(l, list);
        media.append(tb, stage, wave, film);
        // fields
        const side = el('div', 'lm-side');
        const tabs = el('div', 'lm-tabs');
        for (const [k, txt] of [['fields', 'Fields'], ['history', 'History']] as const) {
            const t = btn(this.tab === k ? 'on' : '', txt);
            t.onclick = () => { this.tab = k; this.render(); };
            tabs.append(t);
        }
        tabs.append(el('span', 'lm-tabs-r', 'all fields'));
        const pane = el('div', 'lm-pane');
        if (this.tab === 'fields') pane.append(this.form.el);
        else pane.append(this.history(l));
        side.append(tabs, pane);
        b.append(media, side);
        return b;
    }

    private history(l: any) {
        const d = el('div', 'lm-hist');
        const rows: [string, string][] = [];
        if (l.createdAt) rows.push([new Date(l.createdAt).toLocaleString(), l.adoptedFrom ? `Accepted from ${l.adoptedFrom.origin || 'a detection'}` : 'Created']);
        if (l.updatedAt && l.updatedAt !== l.createdAt) rows.push([new Date(l.updatedAt).toLocaleString(), 'Last edited']);
        if (!rows.length) d.append(el('p', 'lm-m', 'No history recorded for this label.'));
        for (const [t, w] of rows) { const r = el('div', 'lm-hrow'); r.append(el('span', 'lm-m', t), el('span', '', w)); d.append(r); }
        return d;
    }

    private film(cur: any, list: any[]) {
        const f = el('div', 'lm-film');
        f.append(el('span', 'lm-film-l', 'Labels'));
        const strip = el('div', 'lm-film-s');
        for (const l of list) {
            const inSel = this.isMulti ? this.sel.has(l.id) : l.id === cur?.id;
            const t = el('button', 'lm-ft' + (inSel ? (this.isMulti ? ' sel' : ' cur') : '') + (l.polarity === 'absent' ? ' absent' : ''));
            t.type = 'button';
            t.title = 'Click: open · Shift/Ctrl-click: select several';
            if (this.isMulti && inSel) t.append(el('span', 'lm-ft-ck', '✓'));
            const c = el('canvas');
            c.width = 118; c.height = 52;
            t.append(c, el('span', 'lm-ft-t', this.fmt(l.start).slice(0, 8)));
            const nm = el('span', 'lm-ft-n', `${l.label || '–'}${l.polarity === 'absent' ? ' · absent' : l.tags?.soundType ? ` · ${l.tags.soundType}` : ''}`);
            nm.style.background = l.color || colorForName(l.label || '');
            t.append(nm);
            t.onclick = (ev) => {
                if (ev.shiftKey || ev.ctrlKey || ev.metaKey) {
                    const ids = new Set(this.isMulti ? this.sel : [this.id]);
                    if (ids.has(l.id)) ids.delete(l.id); else ids.add(l.id);
                    this.select([...ids]);
                } else if (this.isMulti) this.select([l.id]);
                else this.goto(l.id);
            };
            strip.append(t);
            const key = `${l.start}|${l.end}|${l.freqMin}|${l.freqMax}|${l.fullBand === true}`;
            const cached = this.tiles.get(key);
            if (cached) c.getContext('2d')?.drawImage(cached, 0, 0);
            else {
                const w = this.tileWin(l.start, l.end, l.freqMin, l.freqMax, l.fullBand === true);
                // cached only once drawn (audio not analysed yet: try again on the next render)
                requestAnimationFrame(() => { if (this.drawWin(c, w)) this.tiles.set(key, c); });
            }
        }
        f.append(strip);
        queueMicrotask(() => strip.querySelector('.cur, .sel')?.scrollIntoView({ block: 'nearest', inline: 'center' }));
        return f;
    }

    private foot(l: any) {
        const f = el('div', 'lm-foot');
        const ro = l.readonly === true;
        const del = btn('lm-del', 'Delete <span class="lm-kbd">Del</span>');
        del.disabled = ro;
        del.onclick = () => this.del();
        const dup = btn('', 'Duplicate');
        // The edit visit is committed first: edit and copy are two undo steps, each undoing only itself.
        dup.onclick = () => {
            this.endVisit();
            const id = this.h.duplicate(l.id);
            if (id) this.id = id;
            this.startVisit();
            this.render();
        };
        const keep = el('label', 'lm-keep');
        const cb = el('input');
        cb.type = 'checkbox';
        cb.checked = this.keep;
        cb.onchange = () => { this.keep = cb.checked; if (cb.checked) this.h.keepAsTemplate(this.current); };
        keep.append(cb, ' Keep species + tags for next labels');
        const note = el('span', 'lm-note', ro ? 'Read-only label' : 'Changes save when you leave the label');
        const revert = btn('', 'Revert', 'Back to how this label was when you opened it');
        revert.disabled = !this.visit?.changed;
        revert.onclick = () => {
            if (!this.visit) return;
            this.visit.restore();
            this.visit = { id: this.id, restore: this.h.snapshot(), changed: false };
            this.render();
        };
        const done = btn('lm-done', 'Done <span class="lm-kbd">Enter</span>');
        done.onclick = () => this.close();
        f.append(del, dup, keep, el('span', 'lm-gap'), note, revert, done);
        return f;
    }

    private fmt(sec: number) {
        return this.h.clock ? this.h.clock(sec) : `${sec.toFixed(1)} s`;
    }

    // ── drawing ──

    private draw(l: any, list: any[]) {
        const crop = this.cropEl;
        const w = Math.max(50, crop.clientWidth), hgt = Math.max(50, crop.clientHeight);
        const span = Math.min(MAX_SPAN, l.end - l.start + 2 * CONTEXT);
        const mid = (l.start + l.end) / 2;
        const t0 = Math.max(0, Math.min(l.start - CONTEXT, mid - span / 2));
        // A label longer than the usual span is shown whole, with its end handle reachable.
        const t1 = Math.max(t0 + span, l.end + Math.min(CONTEXT, 0.5));
        const maxF = this.h.maxFreq();
        const top = l.fullBand || l.freqMax == null ? maxF : Math.min(maxF, Math.max(l.freqMax * 1.35, l.freqMax + 1000));
        this.win = { t0, t1, f0: 0, f1: top };
        this.canvas.width = w; this.canvas.height = hgt;
        this.drawWin(this.canvas, { a: t0, b: t1, lo: 0, hi: top });
        // dim outside the label, ghosts of neighbours, the label box with handles
        crop.querySelectorAll('.lm-dim, .lm-lbx, .lm-ph').forEach((e) => e.remove());
        const x = (t: number) => ((t - t0) / (t1 - t0)) * w;
        const y = (f: number) => hgt - (f / top) * hgt;
        const dimL = el('div', 'lm-dim'); dimL.style.left = '0'; dimL.style.width = `${Math.max(0, x(l.start))}px`;
        const dimR = el('div', 'lm-dim'); dimR.style.left = `${x(l.end)}px`; dimR.style.right = '0';
        crop.append(dimL, dimR);
        for (const n of list) {
            if (n.id === l.id || n.end < t0 || n.start > t1) continue;
            crop.append(this.lbx(n, x, y, top, true));
        }
        crop.append(this.lbx(l, x, y, top, false));
        const ph = el('div', 'lm-ph');
        ph.hidden = true;
        crop.append(ph);
        // axes
        const fa = this.box.querySelector('.lm-fa')!;
        fa.replaceChildren(...[4, 3, 2, 1, 0].map((k) => el('span', '', k === 4 ? `${(top / 1000).toFixed(top < 10000 ? 1 : 0)} kHz` : (top * k / 4 / 1000).toFixed(1).replace(/\.0$/, ''))));
        const ta = this.box.querySelector('.lm-ta')!;
        ta.replaceChildren(...[0, 1, 2, 3, 4].map((k) => el('span', '', this.fmt(t0 + (t1 - t0) * k / 4).replace(/^(\d+:\d+:\d+\.\d).*/, '$1'))));
        this.drawWave(t0, t1);
    }

    /** A label box in the crop; the current one gets handles and can be dragged. */
    private lbx(l: any, x: (t: number) => number, y: (f: number) => number, top: number, ghost: boolean) {
        const full = l.fullBand === true || l.freqMin == null || l.freqMax == null;
        const b = el('div', 'lm-lbx' + (ghost ? ' ghost' : '') + (l.polarity === 'absent' ? ' absent' : ''));
        const c = l.color || colorForName(l.label || '');
        b.style.borderColor = c;
        b.style.left = `${x(l.start)}px`;
        b.style.width = `${Math.max(2, x(l.end) - x(l.start))}px`;
        b.style.top = `${full ? 0 : y(Math.min(top, l.freqMax))}px`;
        b.style.height = `${full ? this.canvas.height : Math.max(2, y(l.freqMin) - y(Math.min(top, l.freqMax)))}px`;
        const tag = el('b', '', `${l.label || '–'}${l.tags?.soundType ? ` · ${l.tags.soundType}` : ''}${l.tags?.lifeStage ? ` · ${l.tags.lifeStage}` : ''}${l.polarity === 'absent' ? ' · absent' : ''}`);
        tag.style.background = c;
        b.append(tag);
        if (ghost) {
            b.title = 'Click: open this label';
            b.onclick = () => this.goto(l.id);
            return b;
        }
        if (l.readonly) return b;
        const handles = full ? ['w', 'e'] : ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];
        for (const hnd of handles) { const i = el('i', `lm-h lm-h-${hnd}`); i.dataset.h = hnd; b.append(i); }
        b.addEventListener('pointerdown', (e) => this.drag(e, b, l, full));
        return b;
    }

    private drag(e: PointerEvent, b: HTMLElement, l: any, full: boolean) {
        if (e.button !== 0) return;
        e.preventDefault();
        const hnd = (e.target as HTMLElement).dataset?.h || 'move';
        const r = this.cropEl.getBoundingClientRect();
        const { t0, t1, f1 } = this.win;
        const dt = (t1 - t0) / r.width, df = f1 / r.height;
        const sx = e.clientX, sy = e.clientY;
        const o = { start: l.start, end: l.end, freqMin: l.freqMin ?? 0, freqMax: l.freqMax ?? f1 };
        let n = { ...o };
        b.setPointerCapture(e.pointerId);
        const move = (ev: PointerEvent) => {
            const ddt = (ev.clientX - sx) * dt, ddf = -(ev.clientY - sy) * df;
            n = { ...o };
            if (hnd === 'move') { n.start += ddt; n.end += ddt; if (!full) { n.freqMin += ddf; n.freqMax += ddf; } }
            if (hnd.includes('w')) n.start = Math.min(o.end - 0.01, o.start + ddt);
            if (hnd.includes('e')) n.end = Math.max(o.start + 0.01, o.end + ddt);
            if (!full && hnd.includes('n')) n.freqMax = Math.max(o.freqMin + 10, o.freqMax + ddf);
            if (!full && hnd.includes('s')) n.freqMin = Math.min(o.freqMax - 10, Math.max(0, o.freqMin + ddf));
            const x = (t: number) => ((t - t0) / (t1 - t0)) * r.width;
            const y = (f: number) => r.height - (f / f1) * r.height;
            b.style.left = `${x(n.start)}px`;
            b.style.width = `${x(n.end) - x(n.start)}px`;
            if (!full) { b.style.top = `${y(n.freqMax)}px`; b.style.height = `${y(n.freqMin) - y(n.freqMax)}px`; }
        };
        const up = () => {
            b.removeEventListener('pointermove', move);
            b.removeEventListener('pointerup', up);
            const moved = n.start !== o.start || n.end !== o.end || n.freqMin !== o.freqMin || n.freqMax !== o.freqMax;
            if (!moved) return;
            // Inside the recording: a moved box keeps its length and is shifted back; an edge stops at the end.
            const dur = this.h.duration?.() || Infinity;
            if (hnd === 'move') {
                const len = n.end - n.start;
                n.start = Math.max(0, Math.min(n.start, dur - len));
                n.end = n.start + len;
            } else { n.start = Math.max(0, n.start); n.end = Math.min(dur, n.end); }
            this.change(full ? { start: n.start, end: n.end } : { start: n.start, end: n.end, freqMin: Math.max(0, n.freqMin), freqMax: n.freqMax });
        };
        b.addEventListener('pointermove', move);
        b.addEventListener('pointerup', up);
    }

    /** Spectrogram of a time/frequency window into a canvas; false when the audio is not analysed yet. */
    private drawWin(c: HTMLCanvasElement, w: { a: number; b: number; lo: number; hi: number }): boolean {
        const ctx = c.getContext('2d');
        if (!ctx) return false;
        ctx.fillStyle = '#000';
        ctx.fillRect(0, 0, c.width, c.height);
        const { a, b: b2, lo, hi } = w;
        const p = this.h.patch(a, b2);
        if (!p) return false;
        const img = ctx.createImageData(c.width, c.height);
        const scheme = this.h.colorScheme();
        // contrast from the patch: 5th … 99.5th percentile
        const sample: number[] = [];
        for (let i = 0; i < p.values.length; i += Math.max(1, Math.floor(p.values.length / 4000))) sample.push(p.values[i]);
        sample.sort((x, y) => x - y);
        const vLo = sample[Math.floor(sample.length * 0.6)] ?? -100, vHi = sample[Math.floor(sample.length * 0.995)] ?? 0;
        const span = Math.max(1, vHi - vLo);
        const lut: { r: number; g: number; b: number }[] = [];
        for (let k = 0; k < 256; k++) lut.push(getSpectrogramColor(k / 255, scheme));
        for (let x = 0; x < c.width; x++) {
            const t = a + ((b2 - a) * (x + 0.5)) / c.width;
            const fr = Math.round((t - p.t0) / p.dt);
            if (fr < 0 || fr >= p.frames) continue;
            for (let yy = 0; yy < c.height; yy++) {
                const f = hi - ((hi - lo) * (yy + 0.5)) / c.height;
                const bin = Math.round((f - p.f0) / p.df);
                if (bin < 0 || bin >= p.bins) continue;
                const v = (p.values[fr * p.bins + bin] - vLo) / span;
                const col = lut[Math.max(0, Math.min(255, Math.round(v * 255)))];
                const o = (yy * c.width + x) * 4;
                img.data[o] = col.r; img.data[o + 1] = col.g; img.data[o + 2] = col.b; img.data[o + 3] = 255;
            }
        }
        ctx.putImageData(img, 0, 0);
        return true;
    }

    private drawWave(t0: number, t1: number) {
        const c = this.box.querySelector<HTMLCanvasElement>('.lm-wave-c');
        const s = this.h.samples();
        if (!c || !s) return;
        c.width = c.clientWidth || 600; c.height = c.clientHeight || 40;
        const ctx = c.getContext('2d')!;
        ctx.clearRect(0, 0, c.width, c.height);
        ctx.fillStyle = getComputedStyle(c).color || '#2b8fd6';
        const a = Math.floor(t0 * s.rate), b = Math.min(s.data.length, Math.floor(t1 * s.rate));
        const per = Math.max(1, Math.floor((b - a) / c.width));
        let peak = 1e-6;
        for (let i = a; i < b; i += Math.max(1, Math.floor(per / 8))) peak = Math.max(peak, Math.abs(s.data[i]));
        const mid = c.height / 2;
        for (let x = 0; x < c.width; x++) {
            let mn = 0, mx = 0;
            const i0 = a + x * per;
            for (let i = i0; i < Math.min(b, i0 + per); i++) { const v = s.data[i]; if (v < mn) mn = v; if (v > mx) mx = v; }
            ctx.fillRect(x, mid - (mx / peak) * mid, 1, Math.max(1, ((mx - mn) / peak) * mid));
        }
    }

    /** Play head and time while the modal is open. */
    private tick() {
        this.raf = requestAnimationFrame(() => this.tick());
        const ph = this.cropEl.querySelector<HTMLElement>('.lm-ph');
        const playing = this.h.isPlaying();
        if (playing) this.wasPlaying = true;
        else if (this.wasPlaying && this.queue.length + (this.loop ? 1 : 0) > 0 && this.isMulti) { this.wasPlaying = false; this.playNext(); }
        else if (this.wasPlaying) this.wasPlaying = false;
        if (this.playBtn) { this.playBtn.textContent = playing || this.queue.length ? '❚❚' : '▶'; }
        if (!ph) return;
        const t = this.h.currentTime();
        const { t0, t1 } = this.win;
        const inside = t >= t0 && t <= t1;
        ph.hidden = !inside;
        if (inside) ph.style.left = `${((t - t0) / (t1 - t0)) * this.cropEl.clientWidth}px`;
        if (playing) this.timeEl.textContent = this.fmt(t);
    }
}
