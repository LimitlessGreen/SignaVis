// ═══════════════════════════════════════════════════════════════════════
// ui/panels/embedding-map.ts — full-window 2-D map of the project's Perch-2
// windows (SignaVis Lite). Data from embed_map (src-tauri-lite/src/embed_map.rs).
//
// Wheel: zoom · drag: pan · hover: tooltip · click: play · double-click: open
// Shift+drag: lasso → label the selection for the current agile class.
// See plans/lite-embedding-map-plan.md.
// ═══════════════════════════════════════════════════════════════════════

export interface MapData {
    stamp: number; window: number; layoutPoints: number;
    files: string[]; file: number[]; start: number[]; x: number[]; y: number[];
}
export interface MapWindow { path: string; start: number; end: number; score: number }
type Label = 'pos' | 'neg' | 'unsure';
type ColorBy = 'folder' | 'file' | 'label';

export interface EmbeddingMapOptions {
    load: (force: boolean) => Promise<MapData>;
    /** Current agile class ('' = none) and its label for a window. */
    getClass: () => string;
    labelOf: (path: string, start: number) => Label | null;
    setLabels: (items: { path: string; start: number }[], label: Label | null) => Promise<void>;
    openHit: (hit: MapWindow, play: boolean) => Promise<void> | void;
}

// Categorical palette (dark background), cycled for many groups.
const PALETTE = ['#4e9af1', '#f1a34e', '#5cc98a', '#e5615f', '#a77ee8', '#d9c94a', '#4cc6c9', '#e07bc0', '#9aa857', '#c98a5c'];
const LABEL_COLOR: Record<Label, string> = { pos: '#5cc98a', neg: '#e5615f', unsure: '#d9c94a' };
const UNLABELED = 'rgba(160,170,185,0.35)';
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));
const fmtTime = (s: number) => {
    const m = Math.floor(s / 60);
    return `${m}:${(s - m * 60).toFixed(1).padStart(4, '0')}`;
};
const dirOf = (p: string) => p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '.';

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
    #grid = new Map<number, number[]>();
    #hover = -1;
    #sel = new Set<number>();
    #lasso: [number, number][] | null = null;
    #drag: { x: number; y: number; cx: number; cy: number; moved: boolean } | null = null;
    #onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') this.close(); };

    constructor(opts: EmbeddingMapOptions) {
        this.#opts = opts;
        this.el = document.createElement('div');
        this.el.className = 'emap-overlay';
        this.el.innerHTML = `
            <div class="emap-bar">
                <strong>Embedding map</strong>
                <label>Colour <select class="field-select emap-color">
                    <option value="folder">Folder</option><option value="file">Recording</option><option value="label">Class labels</option>
                </select></label>
                <span class="emap-sel"></span>
                <span class="emap-status field-hint"></span>
                <span class="emap-spacer"></span>
                <button class="sidebar-action-btn secondary" data-act="recompute" type="button" title="Recompute the layout">Recompute</button>
                <button class="sidebar-action-btn secondary" data-act="close" type="button">Close</button>
            </div>
            <div class="emap-body"><canvas></canvas><div class="emap-tip" hidden></div><div class="emap-legend"></div>
                <p class="emap-help">Scroll: zoom · drag: pan · click: play · double-click: open · Shift+drag: select</p></div>`;
        this.#canvas = this.el.querySelector('canvas')!;
        this.#tip = this.el.querySelector('.emap-tip')!;
        this.el.querySelector('.emap-color')!.addEventListener('change', (e) => {
            this.#colorBy = (e.target as HTMLSelectElement).value as ColorBy;
            this.#regroup();
            this.#draw();
        });
        this.el.addEventListener('click', (e) => this.#onButton(e));
        this.#bindPointer();
        new ResizeObserver(() => this.#draw()).observe(this.el.querySelector('.emap-body')!);
    }

    async open(force = false) {
        if (!this.el.isConnected) document.body.appendChild(this.el);
        document.addEventListener('keydown', this.#onKey);
        this.#setStatus('Computing map…');
        try {
            this.#data = await this.#opts.load(force);
            this.#sel.clear();
            this.#fit();
            this.#buildGrid();
            this.#regroup();
            const d = this.#data;
            const n = d.x.length;
            this.#setStatus(`${n.toLocaleString()} windows${d.layoutPoints < n ? ` (layout on ${d.layoutPoints.toLocaleString()}, rest placed by neighbours)` : ''}`);
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

    /** Labels changed elsewhere (panel) → repaint. */
    refresh() {
        if (this.el.isConnected) { this.#renderSel(); this.#draw(); }
    }

    #setStatus(s: string) {
        this.el.querySelector('.emap-status')!.textContent = s;
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
        this.#renderLegend();
    }

    #renderLegend() {
        const leg = this.el.querySelector('.emap-legend')!;
        if (this.#colorBy === 'label') {
            const cls = this.#opts.getClass();
            leg.innerHTML = cls
                ? `<b>${esc(cls)}</b>${(['pos', 'neg', 'unsure'] as Label[]).map((l) => `<div><i style="background:${LABEL_COLOR[l]}"></i>${l}</div>`).join('')}`
                : 'No class selected in the Similar panel.';
            return;
        }
        const names = this.#groupNames;
        const shown = names.slice(0, 12).map((nm, i) =>
            `<div title="${esc(nm)}"><i style="background:${PALETTE[i % PALETTE.length]}"></i>${esc(nm.split('/').pop() || nm)}</div>`).join('');
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
        this.#scale = 1;
        if (!d.x.length) return;
        const [x0, x1] = [Math.min(...d.x), Math.max(...d.x)];
        const [y0, y1] = [Math.min(...d.y), Math.max(...d.y)];
        const { w, h, s } = this.#size();
        if (!w || !h) return;
        this.#cx = (x0 + x1) / 2;
        this.#cy = (y0 + y1) / 2;
        this.#scale = this.#fitScale = 0.9 * Math.min(w / Math.max(1e-6, x1 - x0), h / Math.max(1e-6, y1 - y0)) / s;
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
                    if (dd < bestD) { bestD = dd; best = i; }
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
        const byLabel = this.#colorBy === 'label';
        const cls = this.#opts.getClass();
        // unlabeled first so labelled points stay on top
        const order: number[] = [];
        const top: number[] = [];
        for (let i = 0; i < n; i++) {
            if (byLabel && cls && this.#opts.labelOf(d.files[d.file[i]], d.start[i])) top.push(i);
            else order.push(i);
        }
        g.globalAlpha = byLabel ? 1 : 0.75;
        for (const i of order.concat(top)) {
            const [sx, sy] = this.#toScreen(d.x[i], d.y[i]);
            if (sx < -5 || sy < -5 || sx > w + 5 || sy > h + 5) continue;
            if (byLabel) {
                const l = cls ? this.#opts.labelOf(d.files[d.file[i]], d.start[i]) : null;
                g.fillStyle = l ? LABEL_COLOR[l] : UNLABELED;
            } else {
                g.fillStyle = PALETTE[this.#groupOf[d.file[i]] % PALETTE.length];
            }
            const rr = byLabel && g.fillStyle !== UNLABELED ? r * 1.6 : r;
            g.fillRect(sx - rr / 2, sy - rr / 2, rr, rr);
        }
        g.globalAlpha = 1;
        g.strokeStyle = '#fff';
        g.lineWidth = 1;
        for (const i of this.#sel) {
            const [sx, sy] = this.#toScreen(d.x[i], d.y[i]);
            g.strokeRect(sx - r, sy - r, r * 2, r * 2);
        }
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
        this.#tip.innerHTML = `${esc(w.path)}<br>${fmtTime(w.start)}–${fmtTime(w.end)}${l ? `<br>${esc(cls)}: ${l}` : ''}`;
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
            for (let i = 0; i < d.x.length; i++) {
                const [sx, sy] = this.#toScreen(d.x[i], d.y[i]);
                if (inPolygon(sx, sy, poly)) this.#sel.add(i);
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
}
