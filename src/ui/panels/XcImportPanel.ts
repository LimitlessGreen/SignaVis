// ═══════════════════════════════════════════════════════════════════════
// XcImportPanel.ts — Xeno-canto search & import panel (Phase 7)
// Allows searching XC recordings, filtering results, and downloading
// selected recordings into the active dataset.
// ═══════════════════════════════════════════════════════════════════════

import type { Dataset } from '../../domain/corpus/types.ts';
import {
    searchXenoCantoRecordings,
    type XcRecording,
    type XcSearchResult,
} from '../../infrastructure/xeno-canto/xcSearchApi.ts';
import {
    mapXcRecordingToPayload,
} from '../../infrastructure/xeno-canto/xcImportAdapter.ts';
import { xcDownloadRecording } from '../../infrastructure/tauri/TauriXcImportBridge.ts';

// ── Quality ordering ──────────────────────────────────────────────────
const QUALITY_ORDER: Record<string, number> = { A: 0, B: 1, C: 2, D: 3, E: 4 };

function qualityClass(q: string): string {
    return `xc-quality xc-quality--${q || 'x'}`;
}

// ── parseXcLen: m:ss → readable ──────────────────────────────────────
function formatXcLen(len: string): string {
    if (!len) return '';
    const parts = len.split(':').map(Number);
    if (parts.length === 2 && !parts.some(isNaN)) {
        return `${parts[0]}:${String(parts[1]).padStart(2, '0')}`;
    }
    return len;
}

function escapeHtml(s: string): string {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ── Options ────────────────────────────────────────────────────────────

export interface XcImportPanelOptions {
    container: HTMLElement;
    dataset: Dataset;
    onBack: () => void;
    onStatusMessage?: (msg: string) => void;
    /** Called when recordings were successfully imported, with a count. */
    onImported?: (count: number) => void;
}

// ── XcImportPanel ──────────────────────────────────────────────────────

export class XcImportPanel {
    private readonly container: HTMLElement;
    private readonly dataset: Dataset;
    private readonly onBack: () => void;
    private readonly onStatusMessage: (msg: string) => void;
    private readonly onImported: ((count: number) => void) | undefined;

    private results: XcRecording[] = [];
    private totalResults = 0;
    private currentPage = 1;
    private totalPages = 0;
    private currentQuery = '';
    private selectedIds = new Set<string>();
    private importInProgress = false;

    constructor(opts: XcImportPanelOptions) {
        this.container  = opts.container;
        this.dataset    = opts.dataset;
        this.onBack     = opts.onBack;
        this.onStatusMessage = opts.onStatusMessage ?? ((m) => console.log(m));
        this.onImported = opts.onImported;
    }

    mount(): void {
        this.container.innerHTML = this.buildHtml();
        this.bindEvents();
    }

    // ── HTML ────────────────────────────────────────────────────────

    private buildHtml(): string {
        return `
<div class="xc-import-panel">
  <div class="xc-import-panel__header">
    <button class="btn btn--ghost btn--icon" id="xcImportBack" title="Back">←</button>
    <h2 class="xc-import-panel__title">
      Xeno-canto Import
      <span class="xc-import-panel__dataset-badge">${escapeHtml(this.dataset.name)}</span>
    </h2>
  </div>

  <div class="xc-import-panel__search-bar">
    <input
      type="text"
      id="xcImportQuery"
      class="xc-import-panel__query-input"
      placeholder='Species name or query, e.g. "Turdus merula" or "cnt:Germany grp:birds"'
      autocomplete="off"
    />
    <button class="btn btn--primary" id="xcImportSearchBtn">Search</button>
  </div>

  <div class="xc-import-panel__filters" id="xcImportFilters" style="display:none">
    <label class="xc-import-panel__filter-label">Min quality:</label>
    <select id="xcImportQualityFilter" class="xc-import-panel__filter-select">
      <option value="">Any</option>
      <option value="A">A</option>
      <option value="B">B or better</option>
      <option value="C">C or better</option>
      <option value="D">D or better</option>
    </select>
    <span class="xc-import-panel__result-count" id="xcImportResultCount"></span>
    <div class="xc-import-panel__filter-actions">
      <button class="btn btn--ghost btn--sm" id="xcImportSelectAll">Select all</button>
      <button class="btn btn--ghost btn--sm" id="xcImportDeselectAll">Deselect all</button>
    </div>
  </div>

  <div class="xc-import-panel__results" id="xcImportResults">
    <div class="xc-import-panel__empty">
      Enter a search query above to find Xeno-canto recordings.
    </div>
  </div>

  <div class="xc-import-panel__footer" id="xcImportFooter" style="display:none">
    <div class="xc-import-panel__pager" id="xcImportPager"></div>
    <div class="xc-import-panel__import-bar">
      <span class="xc-import-panel__selected-count" id="xcImportSelectedCount">0 selected</span>
      <button class="btn btn--primary" id="xcImportRunBtn" disabled>
        Import selected
      </button>
    </div>
    <div class="xc-import-panel__progress" id="xcImportProgress" style="display:none">
      <div class="progress-bar"><div class="progress-bar__fill" id="xcImportProgressFill" style="width:0%"></div></div>
      <span class="xc-import-panel__progress-label" id="xcImportProgressLabel"></span>
    </div>
  </div>
</div>`;
    }

    // ── events ──────────────────────────────────────────────────────

    private bindEvents(): void {
        this.container.querySelector('#xcImportBack')!
            .addEventListener('click', () => this.onBack());

        const queryInput = this.container.querySelector<HTMLInputElement>('#xcImportQuery')!;
        const searchBtn  = this.container.querySelector<HTMLButtonElement>('#xcImportSearchBtn')!;

        searchBtn.addEventListener('click', () => {
            const q = queryInput.value.trim();
            if (!q) return;
            this.currentQuery = q;
            this.currentPage = 1;
            this.doSearch();
        });

        queryInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') searchBtn.click();
        });

        this.container.querySelector('#xcImportQualityFilter')
            ?.addEventListener('change', () => this.renderResults());

        this.container.querySelector('#xcImportSelectAll')
            ?.addEventListener('click', () => this.selectAll(true));

        this.container.querySelector('#xcImportDeselectAll')
            ?.addEventListener('click', () => this.selectAll(false));

        this.container.querySelector('#xcImportRunBtn')
            ?.addEventListener('click', () => this.importSelected());
    }

    // ── search ──────────────────────────────────────────────────────

    private async doSearch(): Promise<void> {
        const resultsEl  = this.container.querySelector<HTMLElement>('#xcImportResults')!;
        const filtersEl  = this.container.querySelector<HTMLElement>('#xcImportFilters')!;
        const footerEl   = this.container.querySelector<HTMLElement>('#xcImportFooter')!;
        const searchBtn  = this.container.querySelector<HTMLButtonElement>('#xcImportSearchBtn')!;

        resultsEl.innerHTML = '<div class="xc-import-panel__loading">Searching Xeno-canto…</div>';
        filtersEl.style.display = 'none';
        footerEl.style.display = 'none';
        searchBtn.disabled = true;
        this.selectedIds.clear();

        try {
            const result: XcSearchResult = await searchXenoCantoRecordings(
                this.currentQuery,
                { page: this.currentPage },
            );
            this.results    = result.recordings;
            this.totalResults = parseInt(result.numRecordings, 10) || 0;
            this.currentPage = result.page;
            this.totalPages  = result.numPages;

            filtersEl.style.display = '';
            footerEl.style.display = '';

            this.renderResults();
            this.renderPager();
        } catch (err: any) {
            resultsEl.innerHTML = `<div class="xc-import-panel__error">Search failed: ${escapeHtml(String(err?.message ?? err))}</div>`;
            this.onStatusMessage(`XC search error: ${err?.message ?? err}`);
        } finally {
            searchBtn.disabled = false;
        }
    }

    // ── render results ───────────────────────────────────────────────

    private getFilteredResults(): XcRecording[] {
        const minQ = (this.container.querySelector<HTMLSelectElement>('#xcImportQualityFilter')?.value ?? '');
        if (!minQ) return this.results;
        const threshold = QUALITY_ORDER[minQ] ?? 99;
        return this.results.filter(r => (QUALITY_ORDER[r.q] ?? 99) <= threshold);
    }

    private renderResults(): void {
        const filtered = this.getFilteredResults();
        const resultsEl = this.container.querySelector<HTMLElement>('#xcImportResults')!;
        const countEl   = this.container.querySelector<HTMLElement>('#xcImportResultCount')!;

        countEl.textContent = `${this.totalResults.toLocaleString()} total · ${filtered.length} on this page`;

        if (!filtered.length) {
            resultsEl.innerHTML = '<div class="xc-import-panel__empty">No recordings found.</div>';
            this.updateImportButton();
            return;
        }

        const rows = filtered.map(rec => this.buildRecordingRow(rec)).join('');
        resultsEl.innerHTML = `<div class="xc-import-panel__table">${rows}</div>`;

        // bind checkbox events
        resultsEl.querySelectorAll<HTMLInputElement>('.xc-row-check').forEach(cb => {
            cb.addEventListener('change', () => {
                const id = cb.dataset.id!;
                if (cb.checked) this.selectedIds.add(id);
                else            this.selectedIds.delete(id);
                this.updateImportButton();
            });
        });

        this.updateImportButton();
    }

    private buildRecordingRow(rec: XcRecording): string {
        const checked = this.selectedIds.has(rec.id) ? 'checked' : '';
        const sciName = [rec.gen, rec.sp].filter(Boolean).join(' ');
        const hasCoords = rec.lat && rec.lng && parseFloat(rec.lat) !== 0;
        const geoIcon = hasCoords
            ? `<span class="xc-row__geo" title="${escapeHtml(rec.lat)}, ${escapeHtml(rec.lng)}">📍</span>`
            : '';

        return `
<div class="xc-row" data-id="${escapeHtml(rec.id)}">
  <label class="xc-row__checkbox-wrap">
    <input type="checkbox" class="xc-row-check" data-id="${escapeHtml(rec.id)}" ${checked}>
  </label>
  <div class="xc-row__main">
    <div class="xc-row__names">
      <span class="xc-row__en">${escapeHtml(rec.en || sciName)}</span>
      <span class="xc-row__sci">${escapeHtml(sciName)}</span>
    </div>
    <div class="xc-row__meta">
      <span class="${qualityClass(rec.q)}">${escapeHtml(rec.q || '?')}</span>
      <span class="xc-row__len">${formatXcLen(rec.len)}</span>
      <span class="xc-row__type">${escapeHtml(rec.type || '')}</span>
      <span class="xc-row__country">${escapeHtml(rec.cnt || '')}</span>
      <span class="xc-row__rec">${escapeHtml(rec.rec || '')}</span>
      ${geoIcon}
    </div>
    <div class="xc-row__loc">${escapeHtml(rec.loc || '')}</div>
  </div>
  <a class="xc-row__link btn btn--ghost btn--sm" href="${escapeHtml(rec.url || '#')}" target="_blank" rel="noopener noreferrer" title="Open on xeno-canto.org">XC${escapeHtml(rec.id)}</a>
</div>`;
    }

    // ── pagination ───────────────────────────────────────────────────

    private renderPager(): void {
        const pagerEl = this.container.querySelector<HTMLElement>('#xcImportPager')!;
        if (this.totalPages <= 1) {
            pagerEl.innerHTML = '';
            return;
        }
        const prevDisabled = this.currentPage <= 1 ? 'disabled' : '';
        const nextDisabled = this.currentPage >= this.totalPages ? 'disabled' : '';
        pagerEl.innerHTML = `
          <button class="btn btn--ghost btn--sm" id="xcPagerPrev" ${prevDisabled}>← Prev</button>
          <span class="xc-import-panel__page-info">Page ${this.currentPage} / ${this.totalPages}</span>
          <button class="btn btn--ghost btn--sm" id="xcPagerNext" ${nextDisabled}>Next →</button>
        `;
        pagerEl.querySelector('#xcPagerPrev')?.addEventListener('click', () => {
            this.currentPage--;
            this.doSearch();
        });
        pagerEl.querySelector('#xcPagerNext')?.addEventListener('click', () => {
            this.currentPage++;
            this.doSearch();
        });
    }

    // ── selection helpers ────────────────────────────────────────────

    private selectAll(select: boolean): void {
        const filtered = this.getFilteredResults();
        filtered.forEach(r => {
            if (select) this.selectedIds.add(r.id);
            else        this.selectedIds.delete(r.id);
        });
        this.container.querySelectorAll<HTMLInputElement>('.xc-row-check').forEach(cb => {
            cb.checked = select;
        });
        this.updateImportButton();
    }

    private updateImportButton(): void {
        const btn = this.container.querySelector<HTMLButtonElement>('#xcImportRunBtn');
        const countEl = this.container.querySelector<HTMLElement>('#xcImportSelectedCount');
        const n = this.selectedIds.size;
        if (btn) btn.disabled = n === 0 || this.importInProgress;
        if (countEl) countEl.textContent = n === 1 ? '1 selected' : `${n} selected`;
    }

    // ── import ───────────────────────────────────────────────────────

    private async importSelected(): Promise<void> {
        if (this.selectedIds.size === 0 || this.importInProgress) return;

        this.importInProgress = true;
        this.updateImportButton();

        const progressEl   = this.container.querySelector<HTMLElement>('#xcImportProgress')!;
        const fillEl       = this.container.querySelector<HTMLElement>('#xcImportProgressFill')!;
        const labelEl      = this.container.querySelector<HTMLElement>('#xcImportProgressLabel')!;
        progressEl.style.display = '';

        const toImport = this.results.filter(r => this.selectedIds.has(r.id));
        let imported = 0;
        let failed = 0;

        for (let i = 0; i < toImport.length; i++) {
            const rec = toImport[i];
            const pct = Math.round((i / toImport.length) * 100);
            fillEl.style.width = `${pct}%`;
            labelEl.textContent = `Importing ${i + 1} / ${toImport.length}: XC${rec.id}…`;

            const payload = mapXcRecordingToPayload(rec);
            // Convert ISO recordedAt → Unix ms on the frontend
            const recordedAtMs = payload.recordedAt
                ? (new Date(payload.recordedAt).getTime() || undefined)
                : undefined;

            try {
                await xcDownloadRecording({
                    datasetId: this.dataset.id,
                    xcId: payload.xcId,
                    audioUrl: payload.audioUrl,
                    filename: payload.filename,
                    recordedAtMs: recordedAtMs ?? null,
                    location: payload.location ?? null,
                    fields: payload.fields,
                });
                imported++;
                this.selectedIds.delete(rec.id);
                // Uncheck the row
                const cb = this.container.querySelector<HTMLInputElement>(`.xc-row-check[data-id="${rec.id}"]`);
                if (cb) cb.checked = false;
            } catch (err: any) {
                failed++;
                const msg = String(err?.message ?? err);
                this.onStatusMessage(`XC${rec.id} import failed: ${msg}`);
            }
        }

        fillEl.style.width = '100%';
        labelEl.textContent = `Done: ${imported} imported, ${failed} failed.`;
        this.onStatusMessage(`XC import: ${imported} recordings added to "${this.dataset.name}".`);
        this.onImported?.(imported);

        this.importInProgress = false;
        this.updateImportButton();

        setTimeout(() => {
            progressEl.style.display = 'none';
        }, 3000);
    }
}
