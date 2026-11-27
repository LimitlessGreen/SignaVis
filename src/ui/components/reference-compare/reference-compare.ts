// reference-compare.ts — own clip and a Xeno-canto recording one above the other (Lite, Annotate v2 mockup R2)
//
// Both rows share frequency range, time span and dB mapping. The XC row shows a window of the same length
// as the own clip, placed on its loudest part and draggable. A plays own → XC, Space plays the active row,
// ↑↓ steps through the candidates, ← → through the open suggestions; ⇧A / X / U decide (suggestions),
// V marks a label verified. Data, audio and decisions come from outside (main.js).

import type { XcRef } from '../../../app/xc-reference.ts';
import type { SnapPatch } from '../../../domain/snapToCall.ts';
import type { RefTarget } from '../../panels/reference-panel.ts';

export type CompareDecision = 'accepted' | 'rejected' | 'unsure' | 'verified';

export interface CompareSpecies { sci: string; name: string }

export interface ReferenceCompareOptions {
    /** Own clip: dB patch over [from, to] (preferred) or a rendered picture. */
    ownPatch: (from: number, to: number) => Promise<SnapPatch | ImageData | null>;
    playOwn: (from: number, to: number) => void;
    stopOwn: () => void;
    ownTime: () => number | null;
    /** Length of the open recording (s); the own window stays inside it. */
    ownDuration: () => number;
    /** Decoded XC recording (first ~90 s). */
    xcAudio: (ref: XcRef) => Promise<AudioBuffer>;
    /** dB patch over a whole buffer. */
    patchOf: (audio: AudioBuffer) => Promise<SnapPatch | null>;
    /** Candidates of another species (same filters as the panel). */
    search: (sci: string) => Promise<XcRef[]>;
    /** Decide the suggestion / label; returns the next target (or null: stay). */
    decide: (t: RefTarget, d: CompareDecision) => Promise<RefTarget | null>;
    /** Next / previous open suggestion (null: none). */
    step: (t: RefTarget, dir: 1 | -1) => RefTarget | null;
    addToProject: (ref: XcRef) => void;
    openExternal: (ref: XcRef) => void;
    /** Other species to cross-check (e.g. "also …" of the suggestion). */
    others: (t: RefTarget) => CompareSpecies[];
}

const MAX_HZ = 12_000;
const fmt = (t: number) => { const m = Math.floor(t / 60); return `${m}:${(t - m * 60).toFixed(1).padStart(4, '0')}`; };
const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls = '', text = '') => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text) e.textContent = text;
    return e;
};

/** Draw frames [f0, f1) of a dB patch into `canvas` (canvas pixel size = CSS size), 60 dB below the patch maximum. */
export function paintPatchRange(canvas: HTMLCanvasElement, p: SnapPatch, f0: number, f1: number, maxHz = MAX_HZ) {
    const w = canvas.width, h = canvas.height, ctx = canvas.getContext('2d');
    if (!ctx || !p.frames || !p.bins || w < 2 || h < 2) return;
    const top = Math.max(1, Math.min(p.bins, Math.ceil((maxHz - p.f0) / p.df)));
    let hi = -Infinity;
    for (let i = 0; i < p.values.length; i++) if (p.values[i] > hi) hi = p.values[i];
    const lo = hi - 60;
    const img = ctx.createImageData(w, h);
    for (let x = 0; x < w; x++) {
        const f = Math.floor(f0 + (x / w) * (f1 - f0));
        const inside = f >= 0 && f < p.frames;
        for (let y = 0; y < h; y++) {
            const o = (y * w + x) * 4;
            img.data[o + 3] = 255;
            if (!inside) { img.data[o] = 12; img.data[o + 1] = 10; img.data[o + 2] = 24; continue; }
            const b = Math.min(top - 1, Math.floor((h - 1 - y) * top / h));
            const v = Math.max(0, Math.min(1, (p.values[f * p.bins + b] - lo) / (hi - lo)));
            img.data[o] = Math.round(30 + 225 * Math.min(1, v * 1.4));
            img.data[o + 1] = Math.round(10 + 200 * v * v);
            img.data[o + 2] = Math.round(60 + 60 * (1 - v));
        }
    }
    ctx.putImageData(img, 0, 0);
}

/** Start (s) of the loudest `len`-second window of a patch below `maxHz` (energy in dB above the floor). */
export function loudestWindow(p: SnapPatch, len: number, maxHz = MAX_HZ): number {
    const top = Math.max(1, Math.min(p.bins, Math.ceil((maxHz - p.f0) / p.df)));
    const n = Math.max(1, Math.round(len / p.dt));
    if (p.frames <= n) return p.t0;
    let lo = Infinity;
    for (let i = 0; i < p.values.length; i++) if (p.values[i] < lo) lo = p.values[i];
    const e = new Float64Array(p.frames);
    for (let f = 0; f < p.frames; f++) {
        let s = 0;
        for (let b = 0; b < top; b++) s += p.values[f * p.bins + b] - lo;
        e[f] = s;
    }
    let sum = 0, best = 0, at = 0;
    for (let f = 0; f < p.frames; f++) {
        sum += e[f];
        if (f >= n) sum -= e[f - n];
        if (f >= n - 1 && sum > best) { best = sum; at = f - n + 1; }
    }
    return p.t0 + at * p.dt;
}

type Row = 'own' | 'xc';

export class ReferenceCompare {
    readonly el = el('div', 'rcmp-backdrop');
    private box = el('div', 'rcmp');
    private target!: RefTarget;
    private refs: XcRef[] = [];
    private ref: XcRef | null = null;
    private species: CompareSpecies | null = null;
    private ownCanvas = el('canvas', 'rcmp-spec');
    private xcCanvas = el('canvas', 'rcmp-spec');
    private ownHead = el('div', 'rcmp-lab');
    private xcHead = el('div', 'rcmp-lab');
    private ownAxis = el('div', 'rcmp-tax');
    private xcAxis = el('div', 'rcmp-tax');
    private ownPh = el('div', 'rcmp-ph');
    private xcPh = el('div', 'rcmp-ph');
    private ownSeg = el('div', 'rcmp-seg');
    private title = el('div', 'rcmp-title');
    private list = el('div', 'rcmp-list');
    private othersEl = el('div', 'rcmp-others');
    private foot = el('div', 'rcmp-foot');
    private status = el('span', 'rcmp-status');
    private ownPatch: SnapPatch | ImageData | null = null;
    private xcPatch: SnapPatch | null = null;
    private xcBuf: AudioBuffer | null = null;
    private xcOff = 0;
    private audioCtx: AudioContext | null = null;
    private xcSrc: AudioBufferSourceNode | null = null;
    private xcStartedAt = 0;
    private playing: Row | null = null;
    private active: Row = 'xc';
    private raf = 0;
    private loadGen = 0;
    private onKeyBound = (e: KeyboardEvent) => this.onKey(e);
    private onResize = () => this.drawAll();

    private opts: ReferenceCompareOptions;

    constructor(opts: ReferenceCompareOptions) {
        this.opts = opts;
        this.build();
    }

    get isOpen() { return this.el.isConnected; }

    open(t: RefTarget, ref: XcRef, list: XcRef[]) {
        this.target = t;
        this.refs = list.length ? list : [ref];
        this.species = null;
        if (!this.el.isConnected) {
            document.body.append(this.el);
            window.addEventListener('keydown', this.onKeyBound, true);
            window.addEventListener('resize', this.onResize);
        }
        this.renderTitle();
        this.renderOthers();
        void this.loadOwn();
        void this.pick(ref);
        this.box.focus();
    }

    close() {
        this.stop();
        cancelAnimationFrame(this.raf);
        window.removeEventListener('keydown', this.onKeyBound, true);
        window.removeEventListener('resize', this.onResize);
        void this.audioCtx?.close().catch(() => {});
        this.audioCtx = null;
        this.el.remove();
    }

    // ── layout ──
    private build() {
        this.box.tabIndex = -1;
        const head = el('div', 'rcmp-head');
        const nav = el('div', 'rcmp-nav');
        const prev = el('button', 'rcmp-k', '‹'), next = el('button', 'rcmp-k', '›');
        prev.title = 'Previous open suggestion (←)'; next.title = 'Next open suggestion (→)';
        prev.onclick = () => this.stepTarget(-1); next.onclick = () => this.stepTarget(1);
        const x = el('button', 'rcmp-x', '✕');
        x.title = 'Close (Esc)';
        x.onclick = () => this.close();
        nav.append(prev, el('span', '', 'prev / next open'), next, x);
        head.append(this.title, nav);

        const bar = el('div', 'rcmp-bar');
        const b = (label: string, title: string, run: () => void, cls = '') => {
            const btn = el('button', `rcmp-b ${cls}`, label);
            btn.title = title; btn.onclick = run; return btn;
        };
        bar.append(
            b('▶', 'Play the active row (Space)', () => this.toggle(this.active), 'play'),
            b('A ⇄ alternate', 'Your clip, then the Xeno-canto window (A)', () => this.playAlternate()),
            b('■', 'Stop', () => this.stop()),
            this.status,
            el('span', 'rcmp-sp'),
            el('span', 'rcmp-hint', `0–${MAX_HZ / 1000} kHz · same dB range · drag the XC row to move its window`),
        );

        const row = (r: Row, lab: HTMLElement, canvas: HTMLCanvasElement, axis: HTMLElement, ph: HTMLElement, extra: HTMLElement[]) => {
            const w = el('div', `rcmp-row rcmp-${r}`);
            const plot = el('div', 'rcmp-plot');
            const fa = el('div', 'rcmp-fa');
            for (const k of [12, 9, 6, 3, 0]) fa.append(el('span', '', k ? `${k}k` : '0'));
            plot.append(canvas, ...extra, ph, fa, axis);
            w.append(lab, plot);
            w.onmousedown = () => this.setActive(r);
            return { w, plot };
        };
        const own = row('own', this.ownHead, this.ownCanvas, this.ownAxis, this.ownPh, [this.ownSeg]);
        const xc = row('xc', this.xcHead, this.xcCanvas, this.xcAxis, this.xcPh, []);
        this.dragXc(xc.plot);
        own.plot.ondblclick = () => this.toggle('own');
        xc.plot.ondblclick = () => this.toggle('xc');

        const cmp = el('div', 'rcmp-cmp');
        cmp.append(bar, own.w, xc.w);
        const side = el('div', 'rcmp-side');
        side.append(el('div', 'rcmp-side-head', '↑↓ candidates'), this.list, this.othersEl);
        const body = el('div', 'rcmp-body');
        body.append(cmp, side);
        this.box.append(head, body, this.foot);
        this.el.append(this.box);
        this.el.onmousedown = (e) => { if (e.target === this.el) this.close(); };
    }

    // ── data ──
    private clipSpan() {
        const t = this.target;
        const dur = this.opts.ownDuration() || Infinity;
        const s = Math.max(0, Math.min(t.start ?? 0, dur)), e = Math.max(s, Math.min(t.end ?? s + 3, dur));
        const len = Math.max(1, e - s);
        const pad = Math.min(2, Math.max(0.5, len * 0.25));
        return { s, e, from: Math.max(0, s - pad), to: Math.min(dur, e + pad) };
    }

    private async loadOwn() {
        const gen = ++this.loadGen;
        const { from, to } = this.clipSpan();
        this.ownPatch = null;
        this.drawOwn();
        const p = await this.opts.ownPatch(from, to).catch(() => null);
        if (gen !== this.loadGen) return;
        this.ownPatch = p;
        this.drawOwn();
        // the XC window follows the clip length
        if (this.xcPatch) { this.xcOff = this.bestOffset(); this.drawXc(); }
    }

    private async pick(ref: XcRef) {
        this.stop();
        this.ref = ref;
        this.renderList();
        this.renderFoot();
        this.xcPatch = null; this.xcBuf = null;
        this.status.textContent = `Loading XC ${ref.id}…`;
        this.drawXc();
        try {
            const buf = await this.opts.xcAudio(ref);
            if (this.ref !== ref) return;
            const p = await this.opts.patchOf(buf);
            if (this.ref !== ref) return;
            this.xcBuf = buf; this.xcPatch = p;
            this.xcOff = this.bestOffset();
            this.status.textContent = '';
        } catch (err) {
            if (this.ref !== ref) return;
            this.status.textContent = `XC ${ref.id}: ${err instanceof Error ? err.message : String(err)}`;
        }
        this.drawXc();
    }

    private span() { const { from, to } = this.clipSpan(); return to - from; }

    private bestOffset() {
        const len = this.span();
        if (!this.xcPatch) return 0;
        const { s, e, from } = this.clipSpan();
        // ranked: centre the most similar 5-s window on the own clip
        if (this.ref?.simStart != null) return this.clampOff(this.ref.simStart + 2.5 - ((s + e) / 2 - from), len);
        // put the loudest clip-long part where the own clip sits in its window
        const at = loudestWindow(this.xcPatch, Math.max(0.5, this.clipSpan().e - s));
        return this.clampOff(at - (s - from), len);
    }

    private clampOff(off: number, len = this.span()) {
        const dur = this.xcBuf?.duration ?? 0;
        return Math.max(0, Math.min(Math.max(0, dur - len), off));
    }

    // ── drawing ──
    private fit(c: HTMLCanvasElement) {
        const r = c.getBoundingClientRect();
        const w = Math.max(2, Math.round(r.width)), h = Math.max(2, Math.round(r.height));
        if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
    }

    private drawAll() { this.drawOwn(); this.drawXc(); }

    private drawOwn() {
        const c = this.ownCanvas;
        this.fit(c);
        const ctx = c.getContext('2d');
        const { s, e, from, to } = this.clipSpan();
        const p = this.ownPatch;
        if (!p) { ctx?.clearRect(0, 0, c.width, c.height); }
        else if (p instanceof ImageData) {
            createImageBitmap(p).then((bm) => ctx?.drawImage(bm, 0, 0, c.width, c.height)).catch(() => {});
        } else {
            paintPatchRange(c, p, (from - p.t0) / p.dt, (to - p.t0) / p.dt);
        }
        const len = to - from;
        this.ownSeg.style.left = `${((s - from) / len) * 100}%`;
        this.ownSeg.style.width = `${((e - s) / len) * 100}%`;
        this.axis(this.ownAxis, from, to);
        const t = this.target;
        this.ownHead.replaceChildren(el('b', '', 'Your clip'),
            el('span', 'rcmp-tag own', t.source || 'clip'),
            el('span', '', `${fmt(s)} – ${fmt(e)}`), el('span', 'rcmp-muted', t.name));
    }

    private drawXc() {
        const c = this.xcCanvas;
        this.fit(c);
        const p = this.xcPatch, len = this.span();
        if (!p) c.getContext('2d')?.clearRect(0, 0, c.width, c.height);
        else paintPatchRange(c, p, (this.xcOff - p.t0) / p.dt, (this.xcOff + len - p.t0) / p.dt);
        this.axis(this.xcAxis, this.xcOff, this.xcOff + len);
        const r = this.ref;
        if (!r) { this.xcHead.replaceChildren(); return; }
        const link = el('a', 'rcmp-link', 'xeno-canto.org ↗');
        link.href = '#';
        link.onclick = (e) => { e.preventDefault(); this.opts.openExternal(r); };
        this.xcHead.replaceChildren(el('b', '', `XC ${r.id}`),
            el('span', 'rcmp-tag xc', [r.sim != null && `similar ${r.sim.toFixed(2)}`, r.type, r.q && `Q ${r.q}`].filter(Boolean).join(' · ') || 'Xeno-canto'),
            el('span', '', [r.country, r.distKm != null ? `${r.distKm} km` : ''].filter(Boolean).join(' · ')),
            el('span', 'rcmp-muted', [r.recordist && `© ${r.recordist}`, r.licence].filter(Boolean).join(' · ')),
            link);
    }

    private axis(a: HTMLElement, from: number, to: number) {
        const n = 4;
        a.replaceChildren(...Array.from({ length: n + 1 }, (_, i) => el('span', '', `${(from + (to - from) * i / n).toFixed(1)} s`)));
    }

    private dragXc(plot: HTMLElement) {
        plot.addEventListener('pointerdown', (e) => {
            if (!this.xcPatch || e.button !== 0) return;
            const x0 = e.clientX, off0 = this.xcOff, w = plot.getBoundingClientRect().width || 1;
            plot.setPointerCapture(e.pointerId);
            const move = (m: PointerEvent) => {
                this.xcOff = this.clampOff(off0 - ((m.clientX - x0) / w) * this.span());
                this.drawXc();
            };
            const up = () => { plot.removeEventListener('pointermove', move); plot.removeEventListener('pointerup', up); };
            plot.addEventListener('pointermove', move);
            plot.addEventListener('pointerup', up);
        });
    }

    // ── side list ──
    private renderList() {
        this.list.replaceChildren(...this.refs.map((r) => {
            const li = el('div', 'rcmp-li');
            li.classList.toggle('on', r === this.ref || r.id === this.ref?.id);
            const img = el('div', 'rcmp-li-img');
            if (r.sono) { const i = el('img'); i.src = r.sono; i.alt = ''; i.loading = 'lazy'; i.referrerPolicy = 'no-referrer'; img.append(i); }
            const txt = el('div', 'rcmp-li-txt');
            txt.append(el('b', '', `XC ${r.id}`), el('span', '', [r.type, r.q, r.country].filter(Boolean).join(' · ')));
            li.append(img, txt);
            li.onclick = () => void this.pick(r);
            return li;
        }));
        this.list.querySelector('.on')?.scrollIntoView({ block: 'nearest' });
    }

    private renderOthers() {
        const others = this.opts.others(this.target).filter((o) => o.sci !== this.target.sci);
        this.othersEl.hidden = !others.length && !this.species;
        const chips: HTMLElement[] = [el('span', 'rcmp-muted', 'Cross-check: ')];
        const chip = (label: string, on: boolean, run: () => void) => {
            const c = el('button', `rcmp-chip${on ? ' on' : ''}`, label); c.onclick = run; return c;
        };
        chips.push(chip(this.target.name, !this.species, () => void this.loadSpecies(null)));
        for (const o of others) chips.push(chip(o.name, this.species?.sci === o.sci, () => void this.loadSpecies(o)));
        this.othersEl.replaceChildren(...chips);
    }

    private async loadSpecies(sp: CompareSpecies | null) {
        this.species = sp;
        this.renderOthers();
        this.status.textContent = 'Searching Xeno-canto…';
        try {
            const refs = await this.opts.search(sp?.sci ?? this.target.sci);
            if (this.species !== sp) return;
            this.refs = refs;
            this.status.textContent = refs.length ? '' : 'Nothing found with these filters';
            if (refs[0]) void this.pick(refs[0]); else this.renderList();
        } catch (err) {
            this.status.textContent = err instanceof Error ? err.message : String(err);
        }
    }

    // ── head / foot ──
    private renderTitle() {
        const t = this.target;
        const sw = el('span', 'rcmp-sw');
        if (t.color) sw.style.background = t.color;
        this.title.replaceChildren(el('b', '', '⇄ Compare'), sw, el('b', '', t.name), el('span', 'rcmp-muted', t.source || ''));
        this.renderFoot();
    }

    private renderFoot() {
        const t = this.target, r = this.ref;
        const btn = (label: string, cls: string, title: string, run: () => void, disabled = false) => {
            const b = el('button', `rcmp-b ${cls}`, label); b.title = title; b.onclick = run; b.disabled = disabled; return b;
        };
        const add = btn(r ? `+ Add XC ${r.id} to project` : '+ Add to project', '', 'Load this recording into the project',
            () => r && this.opts.addToProject(r), !r);
        const right = el('div', 'rcmp-foot-r');
        if (t?.source?.startsWith('suggestion')) {
            right.append(
                btn('✓ Accept ⇧A', 'ok', 'Accept the suggestion (Shift+A; A alternates playback here)', () => void this.decide('accepted')),
                btn('✕ Reject X', 'no', 'Not this species', () => void this.decide('rejected')),
                btn('? Unsure U', 'maybe', 'Decide later', () => void this.decide('unsure')));
        } else if (t) {
            right.append(btn('✓ Verified V', 'ok', 'Mark this label as verified', () => void this.decide('verified')));
        }
        this.foot.replaceChildren(add, el('span', 'rcmp-muted', 'Esc closes'), right);
    }

    private async decide(d: CompareDecision) {
        this.stop();
        const next = await this.opts.decide(this.target, d);
        if (next) this.retarget(next);
        else { this.status.textContent = d === 'verified' ? 'Marked verified' : 'All suggestions reviewed'; this.renderFoot(); }
    }

    private stepTarget(dir: 1 | -1) {
        const next = this.opts.step(this.target, dir);
        if (next) this.retarget(next);
    }

    private retarget(t: RefTarget) {
        this.stop();
        const sameSpecies = t.sci === this.target.sci;
        this.target = t;
        this.renderTitle();
        this.renderOthers();
        void this.loadOwn();
        if (!sameSpecies) void this.loadSpecies(null);
    }

    // ── playback ──
    private setActive(r: Row) {
        this.active = r;
        this.box.querySelectorAll('.rcmp-row').forEach((x) => x.classList.toggle('act', x.classList.contains(`rcmp-${r}`)));
    }

    private toggle(r: Row) {
        if (this.playing === r) { this.stop(); return; }
        this.play(r);
    }

    private play(r: Row, then?: () => void) {
        this.stop();
        this.setActive(r);
        const { from, to } = this.clipSpan();
        if (r === 'own') {
            this.opts.playOwn(from, to);
            this.playing = 'own';
            const startedAt = performance.now();
            this.track(() => {
                const now = this.opts.ownTime();
                const t = now ?? from + (performance.now() - startedAt) / 1000;
                if (t >= to - 0.02 || performance.now() - startedAt > (to - from) * 1000 + 400) return null;
                return (t - from) / (to - from);
            }, this.ownPh, then);
        } else {
            if (!this.xcBuf) return;
            this.audioCtx ??= new AudioContext();
            const src = this.audioCtx.createBufferSource();
            src.buffer = this.xcBuf;
            src.connect(this.audioCtx.destination);
            const len = this.span();
            src.start(0, this.xcOff, len);
            this.xcSrc = src;
            this.xcStartedAt = this.audioCtx.currentTime;
            this.playing = 'xc';
            this.track(() => {
                const t = (this.audioCtx!.currentTime - this.xcStartedAt) / len;
                return t >= 1 ? null : t;
            }, this.xcPh, then);
        }
    }

    private track(pos: () => number | null, ph: HTMLElement, then?: () => void) {
        cancelAnimationFrame(this.raf);
        const tick = () => {
            if (!this.playing) { ph.hidden = true; return; }
            const f = pos();
            if (f == null) { this.stop(); then?.(); return; }
            ph.hidden = false;
            ph.style.left = `${Math.max(0, Math.min(1, f)) * 100}%`;
            this.raf = requestAnimationFrame(tick);
        };
        this.raf = requestAnimationFrame(tick);
    }

    private playAlternate() {
        // own → XC; pressed again while playing: the other row
        if (this.playing) { const other: Row = this.playing === 'own' ? 'xc' : 'own'; this.play(other); return; }
        this.play('own', () => this.play('xc'));
    }

    stop() {
        cancelAnimationFrame(this.raf);
        if (this.playing === 'own') this.opts.stopOwn();
        try { this.xcSrc?.stop(); } catch { /* already ended */ }
        this.xcSrc = null;
        this.playing = null;
        this.ownPh.hidden = true; this.xcPh.hidden = true;
    }

    // ── keys (window capture while open: the editor and the app see none of them) ──
    private onKey(e: KeyboardEvent) {
        if (!this.isOpen) return;
        const t = e.target;
        if (t instanceof HTMLElement && /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)) return;
        const k = e.key;
        const run = (f: () => void) => { e.preventDefault(); e.stopImmediatePropagation(); f(); };
        if (k === 'Escape') return run(() => this.close());
        if (e.ctrlKey || e.metaKey || e.altKey) return;
        if (k === ' ') return run(() => this.toggle(this.active));
        if (k === 'a' && !e.shiftKey) return run(() => this.playAlternate());
        if (k === 'A' && e.shiftKey && this.target.source?.startsWith('suggestion')) return run(() => void this.decide('accepted'));
        if ((k === 'x' || k === 'X') && this.target.source?.startsWith('suggestion')) return run(() => void this.decide('rejected'));
        if ((k === 'u' || k === 'U') && this.target.source?.startsWith('suggestion')) return run(() => void this.decide('unsure'));
        if ((k === 'v' || k === 'V') && !this.target.source?.startsWith('suggestion')) return run(() => void this.decide('verified'));
        if (k === 'ArrowUp' || k === 'ArrowDown') return run(() => {
            const i = this.refs.findIndex((r) => r.id === this.ref?.id);
            const n = this.refs[Math.max(0, Math.min(this.refs.length - 1, i + (k === 'ArrowDown' ? 1 : -1)))];
            if (n && n !== this.ref) void this.pick(n);
        });
        if (k === 'ArrowLeft' || k === 'ArrowRight') return run(() => this.stepTarget(k === 'ArrowRight' ? 1 : -1));
        if (k === 'Tab') return run(() => this.setActive(this.active === 'own' ? 'xc' : 'own'));
        // everything else stays inside the window
        e.stopImmediatePropagation();
    }
}
