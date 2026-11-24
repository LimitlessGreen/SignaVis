// ═══════════════════════════════════════════════════════════════════════
// ui/panels/library/stats-dialog.ts — statistics of the (filtered) library
//
// Totals, file integrity, coverage per site and week (days with recordings
// out of 7), recorders with the days they did not record, labels and
// detections per class. Follows the library filter.
// ═══════════════════════════════════════════════════════════════════════

import {
    coverageMatrix, dayRanges, formatBytes, type CatalogFilter, type CatalogStats,
} from '../../../domain/catalog/catalog-types.ts';
import { catalogApi } from '../../../infrastructure/tauri/catalogApi.ts';
import { formatDuration } from './library-view.ts';

const esc = (s: unknown) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));
const n = (v: number) => v.toLocaleString();
const day = (ms: number | null) => (ms == null ? '–' : new Date(ms).toISOString().slice(0, 10));

export interface StatsDialogOptions {
    projectRoot: string;
    filter: CatalogFilter;
    /** The filter is not empty (shown as a note). */
    filtered: boolean;
    /** Narrow the library to one site and week (click on a coverage cell). */
    onPickWeek?: (siteId: number | null, weekStart: string) => void;
}

export class StatsDialog {
    el: HTMLElement;
    #o: StatsDialogOptions;

    constructor(o: StatsDialogOptions) {
        this.#o = o;
        this.el = document.createElement('div');
        this.el.className = 'lib-import-preview lib-stats-page';
        this.el.innerHTML = '<p class="lib-hint">Counting…</p>';
        this.el.addEventListener('click', (e) => {
            const c = (e.target as HTMLElement).closest<HTMLElement>('[data-week]');
            if (c && o.onPickWeek) o.onPickWeek(c.dataset.site === '' ? null : Number(c.dataset.site), c.dataset.week!);
        });
        void this.load();
    }

    /** Follow a new library filter (panel). */
    setFilter(filter: CatalogFilter, filtered: boolean) {
        this.#o = { ...this.#o, filter, filtered };
        return this.load();
    }

    #loadGen = 0;

    async load() {
        const gen = ++this.#loadGen;
        try {
            const st = await catalogApi.stats(this.#o.projectRoot, this.#o.filter);
            if (gen === this.#loadGen) this.#render(st);
        } catch (e) {
            if (gen === this.#loadGen) this.el.innerHTML = `<p class="lib-warn">Error: ${esc(e)}</p>`;
        }
    }

    #render(s: CatalogStats) {
        const t = s.totals, it = s.integrity;
        const pct = (a: number) => (t.recordings ? `${Math.round((100 * a) / t.recordings)} %` : '–');
        const dur = t.withDuration ? `${formatDuration(t.seconds)}${t.withDuration < t.recordings ? ` <span class="lib-hint">(${n(t.withDuration)} of ${n(t.recordings)} files measured)</span>` : ''}` : '<span class="lib-hint">not measured yet (Analyse files)</span>';
        const m = coverageMatrix(s);
        const cov = m.weeks.length ? `<table class="lib-table lib-table--compact lib-coverage">
            <thead><tr><th>Site</th>${m.weeks.map((w) => `<th title="Week from Monday ${w}">${w.slice(5)}</th>`).join('')}</tr></thead>
            <tbody>${m.rows.map((r) => `<tr><td>${esc(r.name)}</td>${r.cells.map((c, i) => {
                const days = c?.days ?? 0;
                const tip = c ? `${c.days} of 7 days, ${n(c.recordings)} recordings${c.seconds ? `, ${formatDuration(c.seconds)}` : ''}` : 'no recordings';
                return `<td class="lib-cov" style="--cov:${days / 7}" data-site="${r.siteId ?? ''}" data-week="${m.weeks[i]}" title="${esc(tip)}">${days || ''}</td>`;
            }).join('')}</tr>`).join('')}</tbody></table>
            <p class="lib-hint">Days with recordings per week (Monday to Sunday, local time). Click a cell to show it in the library.${m.hiddenWeeks
                ? ` Showing the last ${n(m.weeks.length)} weeks; ${n(m.hiddenWeeks)} earlier weeks are not shown (narrow the period to see them).` : ''}</p>` : '<p class="lib-hint">No recordings with a start time.</p>';
        const gaps = s.devices.filter((d) => d.missingDays.length);
        this.el.innerHTML = `
          ${this.#o.filtered ? '<p class="lib-hint">Statistics of the filtered recordings.</p>' : ''}
          <div class="lib-kpis">
            <div><b>${n(t.recordings)}</b><span>recordings</span></div>
            <div><b>${dur}</b><span>audio</span></div>
            <div><b>${formatBytes(t.bytes)}</b><span>on disk</span></div>
            <div><b>${day(t.firstMs)} – ${day(t.lastMs)}</b><span>period (UTC)</span></div>
            <div><b>${n(t.sites)} / ${n(t.devices)}</b><span>sites / recorders</span></div>
          </div>
          ${t.noStart || t.unassigned ? `<p class="lib-warn">${t.noStart ? `${n(t.noStart)} without start time. ` : ''}${t.unassigned ? `${n(t.unassigned)} without site or recorder.` : ''}</p>` : ''}
          <h4>Coverage</h4>${cov}
          <h4>Recorders</h4>
          <table class="lib-table lib-table--compact"><thead><tr><th>Recorder</th><th>First day</th><th>Last day</th><th class="num">Days</th>
            <th class="num">Recordings</th><th class="num">Audio</th><th>${this.#o.filtered ? 'Days without matching recordings' : 'Days without recordings'}</th></tr></thead><tbody>
          ${s.devices.map((d) => `<tr><td>${esc(d.device ?? '(none)')}</td><td>${esc(d.firstDay ?? '')}</td><td>${esc(d.lastDay ?? '')}</td>
            <td class="num">${n(d.days)}</td><td class="num">${n(d.recordings)}</td><td class="num">${d.seconds ? formatDuration(d.seconds) : ''}</td>
            <td class="${d.missingDays.length ? 'lib-warn' : 'lib-hint'}">${d.missingDays.length ? `${d.missingDays.length}: ${esc(dayRanges(d.missingDays).join(', '))}` : 'none'}</td></tr>`).join('')}
          </tbody></table>
          ${gaps.length ? `<p class="lib-hint">${this.#o.filtered
              ? 'Days between the first and the last with no recording that matches the filter (the recorder may have recorded then).'
              : 'A missing day between the first and the last can be a failure, a full card, or a planned pause.'}</p>` : ''}
          <h4>Files</h4>
          <table class="lib-table lib-table--compact"><tbody>
            <tr><td>present</td><td class="num">${n(it.ok)}</td><td class="num">${pct(it.ok)}</td></tr>
            ${it.missing ? `<tr class="lib-warn"><td>missing</td><td class="num">${n(it.missing)}</td><td class="num">${pct(it.missing)}</td></tr>` : ''}
            ${it.changed ? `<tr class="lib-warn"><td>changed</td><td class="num">${n(it.changed)}</td><td class="num">${pct(it.changed)}</td></tr>` : ''}
            <tr><td>header read (duration, sample rate)</td><td class="num">${n(it.headerRead)}</td><td class="num">${pct(it.headerRead)}</td></tr>
            <tr><td>fingerprint</td><td class="num">${n(it.hashed)}</td><td class="num">${pct(it.hashed)}</td></tr>
            <tr><td>SHA-256 checksum</td><td class="num">${n(it.fullHashed)}</td><td class="num">${pct(it.fullHashed)}</td></tr>
          </tbody></table>
          <h4>Labels</h4>
          ${s.labels.length ? `<p>${n(s.labeledRecordings)} recordings with labels (${pct(s.labeledRecordings)}).</p>${classTable(s.labels)}` : '<p class="lib-hint">No labels in the catalog yet.</p>'}
          <h4>Detections</h4>
          ${s.runs.length ? s.runs.map((r) => `<p><b>${esc(r.model)}</b>: ${n(r.covered)} recordings processed, ${n(r.detections)} detections</p>${classTable(r.classes)}`).join('')
            : '<p class="lib-hint">No detection runs yet.</p>'}`;
    }
}

function classTable(rows: CatalogStats['labels']): string {
    return `<table class="lib-table lib-table--compact"><thead><tr><th>Class</th><th class="num">Count</th><th class="num">Recordings</th></tr></thead><tbody>
      ${rows.map((c) => `<tr><td>${esc(c.class)}</td><td class="num">${n(c.count)}</td><td class="num">${n(c.recordings)}</td></tr>`).join('')}</tbody></table>`;
}
