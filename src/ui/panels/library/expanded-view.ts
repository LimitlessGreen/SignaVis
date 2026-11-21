// ═══════════════════════════════════════════════════════════════════════
// ui/panels/library/expanded-view.ts — one recording, large (library grid)
//
// Opened by a click on a tile (like the expanded sample in dataset browsers):
// a large spectrogram of the whole recording, its fields on the right,
// ←/→ to step through the current list, Enter opens it in the editor.
// ═══════════════════════════════════════════════════════════════════════

import { formatBytes, localTime, type CatalogRow, type RecordingDetail } from '../../../domain/catalog/catalog-types.ts';
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
}

export class ExpandedView {
    el: HTMLElement;
    #o: ExpandedViewOptions;
    #i = -1;
    #row: CatalogRow | null = null;
    #gen = 0;
    #lut = heatLut();

    constructor(o: ExpandedViewOptions) {
        this.#o = o;
        this.el = document.createElement('div');
        this.el.className = 'lib-expand';
        this.el.hidden = true;
        this.el.addEventListener('click', (e) => {
            const t = e.target as HTMLElement;
            const act = t.closest<HTMLElement>('[data-act]')?.dataset.act;
            if (act === 'x-close' || t === this.el) this.close();
            else if (act === 'x-prev') void this.step(-1);
            else if (act === 'x-next') void this.step(1);
            else if (act === 'x-open') this.#o.open(this.#i);
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
                <canvas width="${BIG.w}" height="${BIG.h}" class="is-empty"></canvas>
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
                <dl class="lib-expand-more"></dl>
              </aside>
            </div>
          </div>`;
        const [thumb, detail] = await Promise.all([
            catalogApi.thumbs(this.#o.projectRoot, [row.id], { ...BIG, maxHz }).then((r) => r[0]).catch((e) => ({ thumb: null, error: String(e) })),
            catalogApi.recordingDetail(this.#o.projectRoot, row.id).catch(() => null),
        ]);
        if (gen !== this.#gen) return;
        this.#drawBig(thumb.thumb, thumb.error);
        if (detail) this.#renderDetail(detail);
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
