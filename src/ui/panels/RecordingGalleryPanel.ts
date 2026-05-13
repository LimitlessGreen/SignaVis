// ═══════════════════════════════════════════════════════════════════════
// ui/panels/RecordingGalleryPanel.ts — Recording gallery within a dataset
// ═══════════════════════════════════════════════════════════════════════

import type { Recording, Dataset, SavedView } from '../../domain/corpus/types.ts';
import {
    recordingList,
    recordingSetTags,
    recordingDelete,
    recordingDistinctValues,
    datasetRunBirdnet,
    datasetSaveView,
    datasetDeleteView,
    type BirdnetRunArgs,
    type BirdnetDonePayload,
} from '../../infrastructure/tauri/TauriCorpusAdapter.ts';
import { FieldSchemaPanel } from './FieldSchemaPanel.ts';
import { TrainingSplitPanel } from './TrainingSplitPanel.ts';
import { ExportPanel } from './ExportPanel.ts';
import { getWaveformThumbnail } from '../services/WaveformThumbnailService.ts';
import { listen } from '@tauri-apps/api/event';

export interface RecordingGalleryOptions {
    container: HTMLElement;
    dataset: Dataset;
    onBack: () => void;
    onOpenRecording?: (recording: Recording) => void;
    onImport?: () => void;
    onStatusMessage?: (msg: string) => void;
    /** Called when a field is added so the dataset reference stays fresh. */
    onDatasetUpdated?: (updated: Dataset) => void;
    /** Called when the user wants to open the Cluster Browser. */
    onShowClusters?: () => void;
    /** Called when the user wants to open the Embedding Scatter plot. */
    onShowScatter?: () => void;
}

const PAGE_SIZE = 50;

export class RecordingGalleryPanel {
    private readonly container: HTMLElement;
    private dataset: Dataset;
    private readonly onBack: () => void;
    private readonly onOpenRecording: ((r: Recording) => void) | undefined;
    private readonly onImport: (() => void) | undefined;
    private readonly onStatusMessage: (msg: string) => void;
    private readonly onDatasetUpdated: ((d: Dataset) => void) | undefined;
    private readonly onShowClusters: (() => void) | undefined;
    private readonly onShowScatter: (() => void) | undefined;

    private recordings: Recording[] = [];
    private offset = 0;
    private hasMore = true;
    private isLoading = false;
    private activeTagFilter: string | null = null;
    private searchQuery = '';
    /** Active field filters: fieldName → selectedValue ('' = all) */
    private fieldFilters: Map<string, string> = new Map();
    /** Distinct values per field (cached after first load) */
    private fieldValues: Map<string, string[]> = new Map();
    /** Running BirdNET job (prevents double-execution) */
    private birdnetRunning = false;
    private unlistenBirdnet: (() => void) | null = null;
    private fieldSchemaPanel: FieldSchemaPanel | null = null;
    private splitOverlay: HTMLElement | null = null;
    private exportOverlay: HTMLElement | null = null;

    constructor(opts: RecordingGalleryOptions) {
        this.container = opts.container;
        this.dataset = opts.dataset;
        this.onBack = opts.onBack;
        this.onOpenRecording = opts.onOpenRecording;
        this.onImport = opts.onImport;
        this.onStatusMessage = opts.onStatusMessage ?? ((m) => console.log(m));
        this.onDatasetUpdated = opts.onDatasetUpdated;
        this.onShowClusters = opts.onShowClusters;
        this.onShowScatter = opts.onShowScatter;
    }

    async mount(): Promise<void> {
        this.container.innerHTML = this.renderShell();
        this.bindEvents();
        await this.loadMore(true);
    }

    private renderShell(): string {
        const knownTags = this.dataset.knownTags ?? [];
        const tagPills = knownTags
            .map(
                (t) =>
                    `<button class="tag-pill" data-tag="${escapeHtml(t)}">${escapeHtml(t)}</button>`,
            )
            .join('');

        // Field filters from fieldSchema (primitive fields only)
        const fieldSchema = this.dataset.fieldSchema ?? [];
        const filterableFields = fieldSchema.filter((f) =>
            ['string', 'int', 'float'].includes(f.kind) && !f.system,
        );
        const fieldDropdowns = filterableFields
            .map((f) => {
                const values = this.fieldValues.get(f.name) ?? [];
                const opts = values
                    .map((v) => `<option value="${escapeHtml(v)}">${escapeHtml(v)}</option>`)
                    .join('');
                return `
                    <select class="input input--sm field-filter-select" data-field="${escapeHtml(f.name)}" title="${escapeHtml(f.name)}">
                        <option value="">${escapeHtml(f.name)}: All</option>
                        ${opts}
                    </select>
                `;
            })
            .join('');

        return `
            <div class="recording-gallery">
                <div class="recording-gallery__header">
                    <button class="btn btn--ghost btn--icon" id="galleryBackBtn" title="Back">←</button>
                    <h2 class="recording-gallery__title">${escapeHtml(this.dataset.name)}</h2>
                    <div class="recording-gallery__header-actions">
                        <button class="btn btn--ghost btn--sm" id="galleryFieldsBtn" title="View and manage dataset fields">Fields</button>
                        <button class="btn btn--ghost btn--sm" id="gallerySplitBtn" title="Assign train/val/test tags">Split</button>
                        <button class="btn btn--ghost btn--sm" id="galleryExportBtn" title="Export training data / fine-tune">Export</button>
                        <button class="btn btn--ghost btn--sm" id="gallerySaveViewBtn" title="Save current filters as a named view">Save view</button>
                        <button class="btn btn--ghost" id="galleryBirdnetBtn" title="Run BirdNET on the entire dataset">🔍 BirdNET</button>
                        <button class="btn btn--ghost btn--sm" id="galleryClusterBtn" title="Open cluster browser">⬡ Clusters</button>
                        <button class="btn btn--ghost btn--sm" id="galleryScatterBtn" title="Open UMAP scatter plot">⬖ Scatter</button>
                        <button class="btn btn--primary" id="galleryImportBtn">+ Import</button>
                    </div>
                </div>

                <div class="recording-gallery__birdnet-progress" id="galleryBirdnetProgress" style="display:none">
                    <div class="progress-bar">
                        <div class="progress-bar__fill" id="galleryProgressFill" style="width:0%"></div>
                    </div>
                    <span class="progress-label" id="galleryProgressLabel">Starting BirdNET…</span>
                    <button class="btn btn--ghost btn--sm" id="galleryBirdnetCancel">Cancel</button>
                </div>

                ${this.renderSavedViewsBar()}

                <div class="recording-gallery__toolbar">
                    <input
                        type="search"
                        class="input input--sm recording-gallery__search"
                        id="gallerySearch"
                        placeholder="Search path or tag…"
                    />
                    <div class="recording-gallery__tag-filter">
                        <button class="tag-pill tag-pill--active" data-tag="">All</button>
                        ${tagPills}
                    </div>
                    ${filterableFields.length > 0 ? `
                    <div class="recording-gallery__field-filters" id="galleryFieldFilters">
                        ${fieldDropdowns}
                    </div>` : ''}
                </div>

                <div class="recording-gallery__stats" id="galleryStats">
                    ${this.dataset.recordingCount.toLocaleString()} recordings
                </div>

                <div class="recording-gallery__grid" id="galleryGrid">
                    <div class="recording-gallery__loading">Lade…</div>
                </div>

                <div class="recording-gallery__pagination">
                    <button class="btn btn--ghost" id="galleryLoadMore" style="display:none">
                        Load more
                    </button>
                </div>
            </div>
        `;
    }

    private renderSavedViewsBar(): string {
        const views = this.dataset.savedViews ?? [];
        if (views.length === 0) return '';
        const pills = views.map((v) => `
            <span class="saved-view-pill" data-view-name="${escapeHtml(v.name)}">
                <button class="saved-view-pill__name" data-apply-view="${escapeHtml(v.name)}">${escapeHtml(v.name)}</button>
                <button class="saved-view-pill__delete" data-delete-view="${escapeHtml(v.name)}" title="Delete view">✕</button>
            </span>
        `).join('');
        return `
            <div class="recording-gallery__saved-views" id="gallerySavedViews">
                <span class="saved-views__label">Views:</span>
                ${pills}
            </div>
        `;
    }

    private bindEvents(): void {
        const backBtn = this.container.querySelector('#galleryBackBtn') as HTMLButtonElement;
        const importBtn = this.container.querySelector('#galleryImportBtn') as HTMLButtonElement;
        const loadMoreBtn = this.container.querySelector('#galleryLoadMore') as HTMLButtonElement;
        const searchInput = this.container.querySelector('#gallerySearch') as HTMLInputElement;

        backBtn.addEventListener('click', () => this.onBack());
        importBtn.addEventListener('click', () => this.onImport?.());
        loadMoreBtn.addEventListener('click', () => this.loadMore(false));

        this.container.querySelector('#galleryClusterBtn')?.addEventListener('click', () => this.onShowClusters?.());
        this.container.querySelector('#galleryScatterBtn')?.addEventListener('click', () => this.onShowScatter?.());

        // Fields button
        const fieldsBtn = this.container.querySelector('#galleryFieldsBtn') as HTMLButtonElement | null;
        fieldsBtn?.addEventListener('click', () => this.openFieldSchemaPanel());

        // Split button
        this.container.querySelector('#gallerySplitBtn')?.addEventListener('click', () => this.openSplitPanel());

        // Export button
        this.container.querySelector('#galleryExportBtn')?.addEventListener('click', () => this.openExportPanel());

        // Saved views — save current view
        this.container.querySelector('#gallerySaveViewBtn')?.addEventListener('click', () => {
            this.promptSaveView();
        });

        // Saved views — apply / delete
        this.container.querySelectorAll('[data-apply-view]').forEach((btn) => {
            btn.addEventListener('click', () => {
                const name = (btn as HTMLElement).dataset.applyView!;
                this.applyView(name);
            });
        });
        this.container.querySelectorAll('[data-delete-view]').forEach((btn) => {
            btn.addEventListener('click', async (e) => {
                e.stopPropagation();
                const name = (btn as HTMLElement).dataset.deleteView!;
                await this.deleteView(name);
            });
        });

        const birdnetBtn = this.container.querySelector('#galleryBirdnetBtn') as HTMLButtonElement | null;
        birdnetBtn?.addEventListener('click', () => this.showBirdnetDialog());

        const cancelBtn = this.container.querySelector('#galleryBirdnetCancel') as HTMLButtonElement | null;
        cancelBtn?.addEventListener('click', () => {
            this.unlistenBirdnet?.();
            this.unlistenBirdnet = null;
            this.birdnetRunning = false;
            const progressEl = this.container.querySelector('#galleryBirdnetProgress') as HTMLElement | null;
            if (progressEl) progressEl.style.display = 'none';
            if (birdnetBtn) { birdnetBtn.disabled = false; birdnetBtn.textContent = '🔍 BirdNET'; }
            this.onStatusMessage('BirdNET cancelled.');
        });

        searchInput.addEventListener('input', () => {
            this.searchQuery = searchInput.value.trim().toLowerCase();
            this.renderGrid();
        });

        this.container.querySelectorAll('[data-tag]').forEach((btn) => {
            btn.addEventListener('click', () => {
                const tag = (btn as HTMLElement).dataset.tag ?? '';
                this.activeTagFilter = tag === '' ? null : tag;
                this.container
                    .querySelectorAll('[data-tag]')
                    .forEach((b) => b.classList.remove('tag-pill--active'));
                btn.classList.add('tag-pill--active');
                // Tag filter is server-side: reload from offset 0.
                this.loadMore(true);
            });
        });

        // Field filter dropdowns
        this.container.querySelectorAll<HTMLSelectElement>('.field-filter-select').forEach((sel) => {
            // On first focus: lazy-load distinct values
            sel.addEventListener('focus', async () => {
                const field = sel.dataset.field!;
                if (!this.fieldValues.has(field)) {
                    try {
                        const vals = await recordingDistinctValues(this.dataset.id, field);
                        this.fieldValues.set(field, vals);
                        // Populate options
                        vals.forEach((v) => {
                            const opt = document.createElement('option');
                            opt.value = v;
                            opt.textContent = v;
                            sel.appendChild(opt);
                        });
                    } catch {
                        // Ignore — empty list remains
                    }
                }
            });

            sel.addEventListener('change', () => {
                const field = sel.dataset.field!;
                this.fieldFilters.set(field, sel.value);
                this.renderGrid();
            });
        });
    }

    private async loadMore(reset: boolean): Promise<void> {
        if (this.isLoading) return;
        if (reset) {
            this.offset = 0;
            this.recordings = [];
            this.hasMore = true;
        }
        if (!this.hasMore) return;

        this.isLoading = true;
        try {
            const batch = await recordingList({
                datasetId: this.dataset.id,
                limit: PAGE_SIZE,
                offset: this.offset,
                tagFilter: this.activeTagFilter ?? undefined,
            });
            this.recordings.push(...batch);
            this.offset += batch.length;
            this.hasMore = batch.length === PAGE_SIZE;
        } catch (e) {
            this.onStatusMessage(`Error loading recordings: ${e}`);
        } finally {
            this.isLoading = false;
        }

        this.renderGrid();
        const loadMoreBtn = this.container.querySelector('#galleryLoadMore') as HTMLButtonElement;
        if (loadMoreBtn) {
            loadMoreBtn.style.display = this.hasMore ? 'inline-flex' : 'none';
        }
    }

    private filteredRecordings(): Recording[] {
        return this.recordings.filter((r) => {
            // Tag filter is applied server-side; only client-side search + field filters here.
            if (this.searchQuery) {
                const fp = r.filepath.toLowerCase();
                const tagMatch = r.tags.some((t) => t.toLowerCase().includes(this.searchQuery));
                if (!fp.includes(this.searchQuery) && !tagMatch) return false;
            }
            // Field filters
            for (const [field, value] of this.fieldFilters) {
                if (!value) continue; // '' = All
                const fields = r.fields as Record<string, string> | undefined;
                if (!fields || fields[field] !== value) return false;
            }
            return true;
        });
    }

    private renderGrid(): void {
        const grid = this.container.querySelector('#galleryGrid')!;
        const filtered = this.filteredRecordings();

        if (filtered.length === 0 && !this.isLoading) {
            grid.innerHTML = `
                <div class="recording-gallery__empty">
                    No recordings found.<br>
                    <button class="btn btn--primary" id="galleryEmptyImport">Import folder</button>
                </div>
            `;
            const emptyImportBtn = grid.querySelector('#galleryEmptyImport');
            emptyImportBtn?.addEventListener('click', () => this.onImport?.());
            return;
        }

        grid.innerHTML = filtered.map((r) => this.renderRecordingCard(r)).join('');

        grid.querySelectorAll('[data-open-recording]').forEach((el) => {
            el.addEventListener('click', () => {
                const id = (el as HTMLElement).dataset.openRecording!;
                const rec = this.recordings.find((r) => r.id === id);
                if (rec) this.onOpenRecording?.(rec);
            });
        });

        // Lazy-load waveform thumbnails asynchronously
        grid.querySelectorAll<HTMLElement>('[data-waveform-path]').forEach((img) => {
            const path = img.dataset.waveformPath!;
            getWaveformThumbnail(path).then((url) => {
                if (url) {
                    img.style.backgroundImage = `url(${url})`;
                    img.classList.add('recording-card__waveform--loaded');
                }
            });
        });

        grid.querySelectorAll('[data-toggle-tag]').forEach((btn) => {
            btn.addEventListener('click', async (e) => {
                e.stopPropagation();
                const id = (btn as HTMLElement).dataset.recordingId!;
                const tag = (btn as HTMLElement).dataset.toggleTag!;
                const rec = this.recordings.find((r) => r.id === id);
                if (!rec) return;
                const newTags = rec.tags.includes(tag)
                    ? rec.tags.filter((t) => t !== tag)
                    : [...rec.tags, tag];
                try {
                    await recordingSetTags(id, newTags);
                    rec.tags = newTags;
                    this.renderGrid();
                } catch (e) {
                    this.onStatusMessage(`Tag error: ${e}`);
                }
            });
        });
    }

    // ── Field schema ──────────────────────────────────────────────────

    private openFieldSchemaPanel(): void {
        this.fieldSchemaPanel?.close();
        this.fieldSchemaPanel = new FieldSchemaPanel({
            dataset: this.dataset,
            onDatasetUpdated: (updated) => {
                this.dataset = updated;
                this.onDatasetUpdated?.(updated);
            },
            onClose: () => { this.fieldSchemaPanel = null; },
            onStatusMessage: this.onStatusMessage,
        });
        this.fieldSchemaPanel.open();
    }

    // ── Split & Export ────────────────────────────────────────────────

    private openSplitPanel(): void {
        this.splitOverlay?.remove();
        this.splitOverlay = document.createElement('div');
        this.splitOverlay.className = 'split-overlay';
        document.body.appendChild(this.splitOverlay);
        const panel = new TrainingSplitPanel({
            container: this.splitOverlay,
            dataset: this.dataset,
            onStatusMessage: this.onStatusMessage,
            onClose: () => { this.splitOverlay?.remove(); this.splitOverlay = null; },
        });
        panel.mount();
    }

    private openExportPanel(): void {
        this.exportOverlay?.remove();
        this.exportOverlay = document.createElement('div');
        this.exportOverlay.className = 'export-overlay';
        document.body.appendChild(this.exportOverlay);
        const panel = new ExportPanel({
            container: this.exportOverlay,
            dataset: this.dataset,
            onStatusMessage: this.onStatusMessage,
            onClose: () => { this.exportOverlay?.remove(); this.exportOverlay = null; },
        });
        panel.mount();
    }

    // ── Saved Views ───────────────────────────────────────────────────

    /** Builds a view descriptor from the current filter state. */
    private currentViewStages(): Record<string, unknown>[] {
        const stages: Record<string, unknown>[] = [];
        if (this.activeTagFilter) {
            stages.push({ kind: 'match_tags', params: { tags: [this.activeTagFilter] } });
        }
        for (const [field, value] of this.fieldFilters) {
            if (value) {
                stages.push({ kind: 'match', params: { field, value } });
            }
        }
        return stages;
    }

    private promptSaveView(): void {
        const stages = this.currentViewStages();
        if (stages.length === 0) {
            this.onStatusMessage('No active filters to save as a view.');
            return;
        }
        const name = window.prompt('Name for this view:')?.trim();
        if (!name) return;
        this.saveView(name, stages);
    }

    private async saveView(name: string, stages: Record<string, unknown>[]): Promise<void> {
        try {
            const updated = await datasetSaveView({ datasetId: this.dataset.id, name, stages });
            this.dataset = updated;
            this.onDatasetUpdated?.(updated);
            this.onStatusMessage(`View "${name}" saved.`);
            this.refreshSavedViewsBar();
        } catch (e) {
            this.onStatusMessage(`Error saving view: ${e}`);
        }
    }

    private async deleteView(name: string): Promise<void> {
        if (!confirm(`Delete saved view "${name}"?`)) return;
        try {
            const updated = await datasetDeleteView(this.dataset.id, name);
            this.dataset = updated;
            this.onDatasetUpdated?.(updated);
            this.onStatusMessage(`View "${name}" deleted.`);
            this.refreshSavedViewsBar();
        } catch (e) {
            this.onStatusMessage(`Error deleting view: ${e}`);
        }
    }

    /** Applies a saved view: restores its filter state and reloads. */
    private applyView(name: string): void {
        const view = (this.dataset.savedViews ?? []).find((v: SavedView) => v.name === name);
        if (!view) return;

        // Reset current filters
        this.activeTagFilter = null;
        this.fieldFilters.clear();

        // Restore from stages
        for (const stage of view.stages) {
            const s = stage as { kind: string; params: Record<string, unknown> };
            if (s.kind === 'match_tags') {
                const tags = s.params.tags as string[] | undefined;
                if (tags?.[0]) this.activeTagFilter = tags[0];
            } else if (s.kind === 'match') {
                const field = s.params.field as string;
                const value = s.params.value as string;
                if (field && value) this.fieldFilters.set(field, value);
            }
        }

        // Sync tag pills UI
        this.container.querySelectorAll('[data-tag]').forEach((btn) => {
            const tag = (btn as HTMLElement).dataset.tag ?? '';
            btn.classList.toggle('tag-pill--active', tag === (this.activeTagFilter ?? ''));
        });

        this.onStatusMessage(`View "${name}" applied.`);
        this.loadMore(true);
    }

    /** Re-renders just the saved views bar without full shell rebuild. */
    private refreshSavedViewsBar(): void {
        const existing = this.container.querySelector('#gallerySavedViews');
        if (existing) {
            // Replace the entire saved-views bar with re-rendered HTML
            const tmp = document.createElement('div');
            tmp.innerHTML = this.renderSavedViewsBar();
            const newBar = tmp.firstElementChild;
            if (newBar) {
                existing.replaceWith(newBar);
            } else {
                existing.remove();
            }
        } else if (this.dataset.savedViews?.length) {
            // Bar didn't exist yet — insert before toolbar
            const toolbar = this.container.querySelector('.recording-gallery__toolbar');
            if (toolbar) {
                const tmp = document.createElement('div');
                tmp.innerHTML = this.renderSavedViewsBar();
                const newBar = tmp.firstElementChild;
                if (newBar) toolbar.before(newBar);
            }
        }
        // Rebind events on the new bar
        this.container.querySelectorAll('[data-apply-view]').forEach((btn) => {
            btn.addEventListener('click', () => {
                this.applyView((btn as HTMLElement).dataset.applyView!);
            });
        });
        this.container.querySelectorAll('[data-delete-view]').forEach((btn) => {
            btn.addEventListener('click', async (e) => {
                e.stopPropagation();
                await this.deleteView((btn as HTMLElement).dataset.deleteView!);
            });
        });
        this.container.querySelector('#gallerySaveViewBtn')?.addEventListener('click', () => {
            this.promptSaveView();
        });
    }

    // ── BirdNET-Dialog & Run ──────────────────────────────────────────

    private showBirdnetDialog(): void {
        const existing = document.getElementById('birdnetDialogOverlay');
        if (existing) existing.remove();

        const overlay = document.createElement('div');
        overlay.id = 'birdnetDialogOverlay';
        overlay.className = 'modal-overlay';
        overlay.innerHTML = `
            <div class="modal" role="dialog" aria-modal="true" aria-label="Run BirdNET analysis">
                <div class="modal__header">
                    <h3 class="modal__title">Run BirdNET analysis</h3>
                    <button class="btn btn--ghost btn--icon" id="birdnetDialogClose">✕</button>
                </div>
                <div class="modal__body">
                    <div class="form-row">
                        <label class="form-label" for="birdnetFieldName">Result field name</label>
                        <input
                            class="input" id="birdnetFieldName"
                            type="text" value="birdnetV24"
                            placeholder="e.g. birdnetV24"
                        />
                        <span class="form-hint">SoundEvents will be stored under this field name.</span>
                    </div>
                    <div class="form-row">
                        <label class="form-label" for="birdnetMinConf">Minimum confidence</label>
                        <input
                            class="input" id="birdnetMinConf"
                            type="number" value="0.25" min="0" max="1" step="0.05"
                        />
                    </div>
                    <div class="form-row form-row--inline">
                        <div>
                            <label class="form-label" for="birdnetLat">Latitude (lat)</label>
                            <input class="input" id="birdnetLat" type="number" placeholder="e.g. 49.5" step="0.001"/>
                        </div>
                        <div>
                            <label class="form-label" for="birdnetLon">Longitude (lon)</label>
                            <input class="input" id="birdnetLon" type="number" placeholder="e.g. 11.0" step="0.001"/>
                        </div>
                        <div>
                            <label class="form-label" for="birdnetWeek">Week (1-48)</label>
                            <input class="input" id="birdnetWeek" type="number" placeholder="e.g. 22" min="1" max="48"/>
                        </div>
                    </div>
                    <div class="form-row">
                        <label class="form-label" for="birdnetScope">Scope</label>
                        <select class="input" id="birdnetScope">
                            <option value="all">All recordings (${this.dataset.recordingCount.toLocaleString()})</option>
                            <option value="filtered">Filtered recordings (${this.filteredRecordings().length.toLocaleString()})</option>
                        </select>
                    </div>
                </div>
                <div class="modal__footer">
                    <button class="btn btn--ghost" id="birdnetDialogCancel">Cancel</button>
                    <button class="btn btn--primary" id="birdnetDialogRun">Start analysis</button>
                </div>
            </div>
        `;
        document.body.appendChild(overlay);

        overlay.querySelector('#birdnetDialogClose')?.addEventListener('click', () => overlay.remove());
        overlay.querySelector('#birdnetDialogCancel')?.addEventListener('click', () => overlay.remove());
        overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });

        overlay.querySelector('#birdnetDialogRun')?.addEventListener('click', () => {
            const fieldNameInput = overlay.querySelector('#birdnetFieldName') as HTMLInputElement;
            const minConfInput   = overlay.querySelector('#birdnetMinConf') as HTMLInputElement;
            const latInput       = overlay.querySelector('#birdnetLat') as HTMLInputElement;
            const lonInput       = overlay.querySelector('#birdnetLon') as HTMLInputElement;
            const weekInput      = overlay.querySelector('#birdnetWeek') as HTMLInputElement;
            const scopeSelect    = overlay.querySelector('#birdnetScope') as HTMLSelectElement;

            const fieldName = fieldNameInput.value.trim() || 'birdnetV24';
            const minConf   = parseFloat(minConfInput.value) || 0.25;
            const lat       = latInput.value ? parseFloat(latInput.value) : undefined;
            const lon       = lonInput.value ? parseFloat(lonInput.value) : undefined;
            const week      = weekInput.value ? parseInt(weekInput.value, 10) : undefined;

            // Filtered IDs or all
            const recordingIds = scopeSelect.value === 'filtered'
                ? this.filteredRecordings().map((r) => r.id)
                : undefined;

            overlay.remove();
            this.runBirdnet({ datasetId: this.dataset.id, fieldName, minConf, lat, lon, week, recordingIds });
        });
    }

    private async runBirdnet(args: BirdnetRunArgs): Promise<void> {
        if (this.birdnetRunning) return;
        this.birdnetRunning = true;

        const birdnetBtn    = this.container.querySelector('#galleryBirdnetBtn') as HTMLButtonElement | null;
        const progressEl    = this.container.querySelector('#galleryBirdnetProgress') as HTMLElement | null;
        const progressFill  = this.container.querySelector('#galleryProgressFill') as HTMLElement | null;
        const progressLabel = this.container.querySelector('#galleryProgressLabel') as HTMLElement | null;

        if (birdnetBtn) { birdnetBtn.disabled = true; birdnetBtn.textContent = '⏳ BirdNET running…'; }
        if (progressEl) progressEl.style.display = '';

        this.unlistenBirdnet?.();

        // Subscribe to progress events
        const unlistenProgress = await listen<{
            jobId: string; current: number; total: number; filepath: string | null;
        }>('dataset:birdnet-progress', (event) => {
            const { current, total, filepath } = event.payload;
            const pct = total > 0 ? Math.round((current / total) * 100) : 0;
            if (progressFill) progressFill.style.width = `${pct}%`;
            const name = filepath ? filepath.split('/').pop() ?? filepath : '…';
            if (progressLabel) progressLabel.textContent = `${current} / ${total} — ${name}`;
        });

        // Subscribe to done event — dataset_run_birdnet now returns immediately
        let jobId = '';
        const unlistenDone = await listen<BirdnetDonePayload>(
            'dataset:birdnet-done',
            async (event) => {
                if (jobId && event.payload.jobId !== jobId) return; // ignore other runs
                const p = event.payload;
                if (p.status === 'completed') {
                    this.onStatusMessage(
                        `BirdNET: ${p.processed} analysed, ${p.errors} errors, ${p.skipped} skipped.`,
                    );
                    await this.loadMore(true);
                } else {
                    this.onStatusMessage(`BirdNET failed: ${p.errorMessage ?? 'unknown error'}`);
                }
                cleanup();
            },
        );

        const cleanup = () => {
            this.birdnetRunning = false;
            unlistenProgress();
            unlistenDone();
            this.unlistenBirdnet = null;
            if (birdnetBtn) { birdnetBtn.disabled = false; birdnetBtn.textContent = '🔍 BirdNET'; }
            if (progressEl) progressEl.style.display = 'none';
        };

        this.unlistenBirdnet = cleanup;

        try {
            const summary = await datasetRunBirdnet(args);
            jobId = summary.jobId;
        } catch (e) {
            this.onStatusMessage(`BirdNET error: ${e}`);
            cleanup();
        }
    }

    private renderRecordingCard(r: Recording): string {
        const filename = r.filepath.split('/').pop() ?? r.filepath;
        const dur = r.metadata.duration > 0
            ? formatDuration(r.metadata.duration)
            : '?';
        const sr = r.metadata.sampleRate > 0
            ? `${Math.round(r.metadata.sampleRate / 1000)}kHz`
            : '';
        const tags = r.tags
            .map(
                (t) =>
                    `<button
                        class="tag-pill tag-pill--sm tag-pill--active"
                        data-toggle-tag="${escapeHtml(t)}"
                        data-recording-id="${escapeHtml(r.id)}"
                        title="Remove tag: ${escapeHtml(t)}"
                    >${escapeHtml(t)}</button>`,
            )
            .join('');

        return `
            <div
                class="recording-card"
                data-open-recording="${escapeHtml(r.id)}"
                role="button"
                tabindex="0"
                title="${escapeHtml(r.filepath)}"
            >
                <div
                    class="recording-card__waveform"
                    data-waveform-path="${escapeHtml(r.filepath)}"
                    aria-hidden="true"
                ></div>
                <div class="recording-card__info">
                    <div class="recording-card__name" title="${escapeHtml(r.filepath)}">${escapeHtml(filename)}</div>
                    <div class="recording-card__meta">
                        <span class="recording-card__dur">${dur}</span>
                        ${sr ? `<span class="recording-card__sr">${sr}</span>` : ''}
                    </div>
                    ${tags ? `<div class="recording-card__tags">${tags}</div>` : ''}
                </div>
            </div>
        `;
    }
}

function escapeHtml(s: string): string {
    return s
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

function formatDuration(s: number): string {
    if (s < 60) return `${Math.round(s)}s`;
    const m = Math.floor(s / 60);
    const sec = Math.round(s % 60);
    return `${m}:${sec.toString().padStart(2, '0')}`;
}
