// ═══════════════════════════════════════════════════════════════════════
// ui/panels/library/expanded-view.ts — one recording, large (library grid)
//
// Opened by a click on a tile (like the expanded sample in dataset browsers):
// a large spectrogram of the whole recording, its fields on the right,
// ←/→ to step through the current list, Enter opens it in the editor.
// Drag over the spectrogram to pick a time range and add it to a static
// dataset; ranges already in datasets are shown as coloured bands.
// ═══════════════════════════════════════════════════════════════════════

import {
    fmtClock, formatBytes, localTime, parseClock, rangeFromDrag,
    type CatalogRow, type DatasetInfo, type Membership, type RecordingDetail,
} from '../../../domain/catalog/catalog-types.ts';
import { clockDuration, heatLut, thumbPixels, type Thumb } from '../../../domain/catalog/thumb-grid.ts';
import { catalogApi } from '../../../infrastructure/tauri/catalogApi.ts';

const esc = (s: unknown) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));
const BIG = { w: 1200, h: 300 };

export interface ExpandedViewOptions {
    projectRoot: string;
    /** Step to another index of the list; resolves to its row (loads pages as needed) or null. */
    rowAt: (i: number) => Promise<CatalogRow | null>;
    total: () => number;
    open: (i: number) => void;
    /** Called when the shown index changes (the grid follows) and on close (null). */
    onIndex: (i: number | null) => void;
    maxHz: () => number;
    /** Colour of a field value (same as the pills on the tiles). */
    color: (field: 'site' | 'device', id: string | null) => string;
    /** Static datasets (targets for ranges). */
    datasets: () => DatasetInfo[];
    /** Memberships changed (the library refreshes its dataset counts). */
    onDatasetsChanged: () => void;
}

export class ExpandedView {
    el: HTMLElement;
    #o: ExpandedViewOptions;
    #i = -1;
    #row: CatalogRow | null = null;
    #gen = 0;
    #lut = heatLut();
    #members: Membership[] = [];
    /** Picked range in seconds. */
    #sel: [number, number] | null = null;
    #drag: { x0: number; moved: boolean } | null = null;
    #justDragged = false;
    #target: number | null = null;
    #msg: { text: string; bad: boolean } | null = null;

    constructor(o: ExpandedViewOptions) {
        this.#o = o;
        this.el = document.createElement('div');
        this.el.className = 'lib-expand';
        this.el.hidden = true;
        this.el.addEventListener('click', (e) => {
            const t = e.target as HTMLElement;
            const act = t.closest<HTMLElement>('[data-act]')?.dataset.act;
            if (this.#justDragged) { this.#justDragged = false; return; }
            if (act === 'x-close' || t === this.el) this.close();
            else if (act === 'x-prev') void this.step(-1);
            else if (act === 'x-next') void this.step(1);
            else if (act === 'x-open') this.#o.open(this.#i);
            else if (act?.startsWith('x-ds-') || act?.startsWith('x-range-')) void this.#dsAction(act, t.closest<HTMLElement>('[data-act]')!);
        });
        this.el.addEventListener('change', (e) => {
            const t = e.target as HTMLInputElement;
            if (t.dataset.k === 'x-target') { this.#target = Number(t.value); return; }
            if (t.dataset.k !== 'x-t0' && t.dataset.k !== 'x-t1') return;
            const a = parseClock(this.el.querySelector<HTMLInputElement>('[data-k="x-t0"]')!.value);
            const b = parseClock(this.el.querySelector<HTMLInputElement>('[data-k="x-t1"]')!.value);
            const d = this.#row?.durationS ?? Infinity;
            this.#sel = a != null && b != null && b > a && b <= d + 0.05 ? [a, Math.min(b, d)] : null;
            this.#msg = a != null && b != null && !this.#sel ? { text: `Start must be before end${Number.isFinite(d) ? ` and the end at most ${fmtClock(d)}` : ''}.`, bad: true } : null;
            this.#renderBands();
            this.#renderDs(false, false);   // typed text stays as it is, even while still incomplete
        });
        this.el.addEventListener('pointerdown', (e) => {
            const spec = (e.target as HTMLElement).closest<HTMLElement>('.lib-x-spec');
            if (!spec || e.button !== 0 || !(this.#row?.durationS)) return;
            spec.setPointerCapture(e.pointerId);
            this.#drag = { x0: e.clientX - spec.getBoundingClientRect().left, moved: false };
        });
        this.el.addEventListener('pointermove', (e) => {
            if (!this.#drag) return;
            const spec = this.el.querySelector<HTMLElement>('.lib-x-spec')!;
            const r = spec.getBoundingClientRect();
            const x = e.clientX - r.left;
            if (Math.abs(x - this.#drag.x0) > 3) this.#drag.moved = true;
            if (!this.#drag.moved) return;
            this.#sel = rangeFromDrag(this.#drag.x0, x, r.width, this.#row!.durationS!);
            this.#renderBands();
        });
        this.el.addEventListener('pointerup', (e) => {
            if (!this.#drag) return;
            const spec = this.el.querySelector<HTMLElement>('.lib-x-spec')!;
            const r = spec.getBoundingClientRect();
            const moved = this.#drag.moved;
            if (moved) this.#sel = rangeFromDrag(this.#drag.x0, e.clientX - r.left, r.width, this.#row!.durationS!);
            else this.#sel = null;   // a click clears the selection
            this.#drag = null;
            this.#justDragged = true;
            setTimeout(() => { this.#justDragged = false; }, 0);
            this.#msg = null;
            this.#renderBands();
            this.#renderDs(false);
        });
    }

    get isOpen() { return !this.el.hidden; }

    close() {
        this.el.hidden = true;
        this.#gen++;
        this.#o.onIndex(null);
    }

    async step(d: number) {
        const j = this.#i + d;
        if (j < 0 || j >= this.#o.total()) return;
        await this.show(j);
    }

    /** Keys while open; returns true when handled. */
    onKey(e: KeyboardEvent): boolean {
        if (!this.isOpen) return false;
        if (e.key === 'Escape') this.close();
        else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') void this.step(-1);
        else if (e.key === 'ArrowRight' || e.key === 'ArrowDown') void this.step(1);
        else if (e.key === 'Enter') this.#o.open(this.#i);
        else return false;
        e.preventDefault();
        return true;
    }

    async show(i: number) {
        const gen = ++this.#gen;
        const row = await this.#o.rowAt(i);
        if (!row || gen !== this.#gen) return;
        if (row.id !== this.#row?.id) { this.#sel = null; this.#msg = null; this.#members = []; }
        this.#i = i;
        this.#row = row;
        this.el.hidden = false;
        this.#o.onIndex(i);
        const maxHz = this.#o.maxHz();
        const name = (row.path ?? '').split('/').pop() ?? '';
        const pill = (f: 'site' | 'device', v: string | null) =>
            v ? `<span class="lib-pill" style="--pill:${this.#o.color(f, v)}">${esc(v)}</span>` : '<span class="lib-muted">—</span>';
        this.el.innerHTML = `
          <div class="lib-expand-box" role="dialog" aria-label="Recording">
            <header>
              <span class="lib-expand-pos">${(i + 1).toLocaleString()} / ${this.#o.total().toLocaleString()}</span>
              <b title="${esc(row.path)}">${esc(name)}</b>
              <span class="lib-spacer"></span>
              <button class="btn btn--sm" data-act="x-open" title="Open in the editor (Enter)">Open in editor</button>
              <button class="lib-icon" data-act="x-close" title="Close (Esc)">✕</button>
            </header>
            <div class="lib-expand-body">
              <button class="lib-expand-nav" data-act="x-prev" title="Previous (←)"${i === 0 ? ' disabled' : ''}>‹</button>
              <figure>
                <div class="lib-x-spec" title="${row.durationS ? 'Drag to pick a time range' : 'Duration unknown (analyse the files first); type the range on the right'}">
                  <canvas width="${BIG.w}" height="${BIG.h}" class="is-empty"></canvas><div class="lib-x-bands"></div></div>
                <figcaption><span>${esc(localTime(row))}</span><span>0–${maxHz / 1000} kHz</span><span>${esc(clockDuration(row.durationS))}</span></figcaption>
              </figure>
              <button class="lib-expand-nav" data-act="x-next" title="Next (→)"${i + 1 >= this.#o.total() ? ' disabled' : ''}>›</button>
              <aside class="lib-expand-fields">
                <dl>
                  <dt>Start (local)</dt><dd>${esc(localTime(row))}</dd>
                  <dt>Duration</dt><dd>${esc(clockDuration(row.durationS)) || '—'}</dd>
                  <dt>Site</dt><dd>${pill('site', row.site)}</dd>
                  <dt>Recorder</dt><dd>${pill('device', row.device)}</dd>
                  <dt>Labels</dt><dd>${row.labels || '—'}</dd>
                  <dt>Size</dt><dd>${row.size != null ? formatBytes(row.size) : '—'}</dd>
                  <dt>Path</dt><dd class="lib-expand-path">${esc(row.path)}</dd>
                </dl>
                <section class="lib-x-ds"></section>
                <dl class="lib-expand-more"></dl>
              </aside>
            </div>
          </div>`;
        this.#renderDs(true);
        void this.#loadMembers(gen);
        const [thumb, detail] = await Promise.all([
            catalogApi.thumbs(this.#o.projectRoot, [row.id], { ...BIG, maxHz }).then((r) => r[0]).catch((e) => ({ thumb: null, error: String(e) })),
            catalogApi.recordingDetail(this.#o.projectRoot, row.id).catch(() => null),
        ]);
        if (gen !== this.#gen) return;
        this.#drawBig(thumb.thumb, thumb.error);
        if (detail) this.#renderDetail(detail);
    }

    async #loadMembers(gen = this.#gen) {
        const id = this.#row?.id;
        if (id == null) return;
        const m = await catalogApi.recordingDatasets(this.#o.projectRoot, id).catch(() => null);
        if (gen !== this.#gen || !m) return;
        this.#members = m;
        this.#renderBands();
        this.#renderDs(true);
    }

    /** Ranges already in datasets (coloured) and the picked one. */
    #renderBands() {
        const host = this.el.querySelector<HTMLElement>('.lib-x-bands');
        const d = this.#row?.durationS;
        if (!host) return;
        if (!d) { host.innerHTML = ''; return; }
        const pct = (t: number) => `${Math.min(100, Math.max(0, (t / d) * 100))}%`;
        const bands = this.#members.flatMap((m) => m.ranges.map(([a, b]) =>
            `<div class="lib-x-band" style="--pill:${m.color ?? 'var(--color-accent)'};left:${pct(a)};width:calc(${pct(b)} - ${pct(a)})"
               title="${esc(m.name)} · ${fmtClock(a)}–${fmtClock(b)}"></div>`));
        if (this.#sel) {
            const [a, b] = this.#sel;
            bands.push(`<div class="lib-x-sel" style="left:${pct(a)};width:calc(${pct(b)} - ${pct(a)})"><span>${fmtClock(a)}–${fmtClock(b)}</span></div>`);
        }
        host.innerHTML = bands.join('');
    }

    /** Datasets block in the side column; `full` = also rebuild the inputs (else they keep focus);
     *  `syncFields` = write the picked range into the start/end fields (not while the user types). */
    #renderDs(full: boolean, syncFields = true) {
        const host = this.el.querySelector<HTMLElement>('.lib-x-ds');
        if (!host) return;
        const targets = this.#o.datasets();
        if (this.#target == null || !targets.some((t) => t.id === this.#target)) this.#target = targets[0]?.id ?? null;
        const isStatic = (id: number) => this.#members.find((m) => m.datasetId === id)?.kind === 'static';
        const list = this.#members.map((m) => `
          <div class="lib-x-member"><span class="lib-pill" style="--pill:${m.color ?? 'var(--color-accent)'}">${m.kind === 'filter' ? '⚲' : '▤'} ${esc(m.name)}</span>
            ${m.ranges.length ? m.ranges.map(([a, b]) => `<span class="lib-x-range"><button class="lib-link" data-act="x-range-pick" data-a="${a}" data-b="${b}" title="Select this range">${fmtClock(a)}–${fmtClock(b)}</button>${isStatic(m.datasetId)
                ? `<button class="lib-x-del" data-act="x-range-del" data-ds="${m.datasetId}" data-a="${a}" data-b="${b}" title="Remove this range from “${esc(m.name)}”">×</button>` : ''}</span>`).join('')
              : `<span class="lib-muted">${m.kind === 'filter' ? 'matches its filter' : 'whole recording'}</span>`}</div>`).join('');
        const msg = `<p class="lib-hint${this.#msg?.bad ? ' lib-warn' : ''}" data-k="x-msg">${esc(this.#msg?.text ?? '')}</p>`;
        if (!full && host.querySelector('[data-k="x-t0"]')) {
            host.querySelector('.lib-x-members')!.innerHTML = list || '<span class="lib-muted">in no dataset</span>';
            const [t0, t1] = [host.querySelector<HTMLInputElement>('[data-k="x-t0"]')!, host.querySelector<HTMLInputElement>('[data-k="x-t1"]')!];
            if (syncFields) {
                t0.value = this.#sel ? fmtClock(this.#sel[0]) : '';
                t1.value = this.#sel ? fmtClock(this.#sel[1]) : '';
            }
            host.querySelector<HTMLButtonElement>('[data-act="x-ds-add-range"]')?.toggleAttribute('disabled', !this.#sel);
            host.querySelector('[data-k="x-msg"]')!.outerHTML = msg;
            return;
        }
        host.innerHTML = `<h4>Datasets</h4>
          <div class="lib-x-members">${list || '<span class="lib-muted">in no dataset</span>'}</div>
          ${targets.length ? `
          <div class="lib-x-add">
            <div class="lib-row"><span>range</span>
              <input class="input" data-k="x-t0" placeholder="0:00" value="${this.#sel ? fmtClock(this.#sel[0]) : ''}" aria-label="Range start (m:ss)">
              <span>–</span><input class="input" data-k="x-t1" placeholder="${this.#row?.durationS ? fmtClock(this.#row.durationS) : '0:10'}" value="${this.#sel ? fmtClock(this.#sel[1]) : ''}" aria-label="Range end (m:ss)"></div>
            <div class="lib-row"><span>into</span><select class="field-select" data-k="x-target">
              ${targets.map((t) => `<option value="${t.id}"${t.id === this.#target ? ' selected' : ''}>${esc(t.name)}</option>`).join('')}</select></div>
            <div class="lib-row"><button class="btn btn--sm" data-act="x-ds-add-range"${this.#sel ? '' : ' disabled'} title="Drag over the spectrogram or type start and end">Add range</button>
              <button class="btn btn--sm btn--ghost" data-act="x-ds-add-whole">Add whole recording</button></div>
          </div>` : '<p class="lib-hint">Ranges go into static datasets: create one with “+ New” in the library.</p>'}
          ${msg}`;
    }

    async #dsAction(act: string, btn: HTMLElement) {
        const row = this.#row;
        if (!row) return;
        const root = this.#o.projectRoot;
        const name = (id: number | null) => this.#o.datasets().find((d) => d.id === id)?.name ?? this.#members.find((m) => m.datasetId === id)?.name ?? '';
        try {
            if (act === 'x-range-pick') {
                this.#sel = [Number(btn.dataset.a), Number(btn.dataset.b)];
                this.#renderBands();
                this.#renderDs(false);
                return;
            }
            if (act === 'x-range-del') {
                const id = Number(btn.dataset.ds);
                await catalogApi.datasetRemoveRange(root, id, row.id, [Number(btn.dataset.a), Number(btn.dataset.b)]);
                this.#msg = { text: `Range ${fmtClock(Number(btn.dataset.a))}–${fmtClock(Number(btn.dataset.b))} removed from “${name(id)}”.`, bad: false };
            } else if ((act === 'x-ds-add-range' || act === 'x-ds-add-whole') && this.#target != null) {
                const range = act === 'x-ds-add-range' ? this.#sel : null;
                if (act === 'x-ds-add-range' && !range) return;
                const n = await catalogApi.datasetAdd(root, this.#target, { ids: [row.id] }, range);
                const covered = this.#members.some((m) => m.datasetId === this.#target && !m.ranges.length);
                this.#msg = {
                    text: n ? `${range ? `Range ${fmtClock(range[0])}–${fmtClock(range[1])}` : 'Whole recording'} added to “${name(this.#target)}”.`
                        : covered ? `“${name(this.#target)}” already has the whole recording.` : `Already in “${name(this.#target)}”.`,
                    bad: false,
                };
                if (n && range) this.#sel = null;
            } else return;
        } catch (e) {
            this.#msg = { text: `Error: ${e instanceof Error ? e.message : e}`, bad: true };
            this.#renderDs(false);
            return;
        }
        this.#o.onDatasetsChanged();
        await this.#loadMembers();
    }

    #drawBig(t: Thumb | null, error: string | null) {
        const c = this.el.querySelector<HTMLCanvasElement>('figure canvas');
        if (!c) return;
        c.classList.remove('is-empty');
        if (!t) {
            c.classList.add('is-failed');
            c.title = `No preview: ${error ?? ''}`;
            return;
        }
        c.getContext('2d')?.putImageData(new ImageData(thumbPixels(t, this.#lut), t.w, t.h), 0, 0);
    }

    #renderDetail(d: RecordingDetail) {
        const host = this.el.querySelector<HTMLElement>('.lib-expand-more');
        if (!host) return;
        const rows: [string, string][] = [];
        if (d.sampleRate) rows.push(['Sample rate', `${(d.sampleRate / 1000).toLocaleString()} kHz${d.channels ? ` · ${d.channels} ch` : ''}`]);
        if (d.lat != null && d.lon != null) rows.push(['Position', `${d.lat.toFixed(5)}, ${d.lon.toFixed(5)}${d.posOrigin ? ` (${d.posOrigin})` : ''}`]);
        if (d.tz) rows.push(['Clock', d.tz]);
        if (d.tags.length) rows.push(['Tags', d.tags.map((t) => `<span class="lib-pill lib-pill--tag">${esc(t)}</span>`).join(' ')]);
        for (const [k, v] of d.meta) rows.push([k, esc(v)]);
        if (d.fullHash) rows.push(['SHA-256', `<code title="${esc(d.fullHash)}">${esc(d.fullHash.slice(0, 16))}…</code>`]);
        host.innerHTML = rows.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${v}</dd>`).join('');
    }
}
