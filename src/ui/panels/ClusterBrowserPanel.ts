// ═══════════════════════════════════════════════════════════════════════
// ui/panels/ClusterBrowserPanel.ts — Browse recordings grouped by
// HDBSCAN cluster, with batch-tagging and smart-sampling (Phase 4).
// ═══════════════════════════════════════════════════════════════════════

import type { Recording, Dataset } from '../../domain/corpus/types.ts';
import {
    datasetRunClustering,
    datasetComputeHardness,
    recordingList,
    recordingSetTags,
    type DatasetRunClusteringArgs,
    type ClusteringRunSummary,
} from '../../infrastructure/tauri/TauriCorpusAdapter.ts';
import { getWaveformThumbnail } from '../services/WaveformThumbnailService.ts';

export interface ClusterBrowserOptions {
    container: HTMLElement;
    /** Dataset to display. */
    dataset: Dataset;
    /** Field storing the integer cluster_id. Default: "clusterId". */
    clusterField?: string;
    /** Field storing the HDBSCAN probability. Default: "clusterProb". */
    probabilityField?: string;
    /** Field storing uniqueness score (for smart-sampling). Default: "uniqueness". */
    uniquenessField?: string;
    /** Field storing hardness score (for smart-sampling). Default: "hardness". */
    hardnessField?: string;
    onOpenRecording?: (recording: Recording) => void;
    onStatusMessage?: (msg: string) => void;
    /** Called when the user requests re-running clustering. */
    onRunClustering?: (args: DatasetRunClusteringArgs) => Promise<ClusteringRunSummary>;
}

interface ClusterInfo {
    clusterId: number;
    recordings: Recording[];
}

export class ClusterBrowserPanel {
    private readonly opts: Required<Omit<ClusterBrowserOptions, 'onOpenRecording' | 'onRunClustering'>> & Pick<ClusterBrowserOptions, 'onOpenRecording' | 'onRunClustering'>;
    private clusters: ClusterInfo[] = [];
    private selectedClusterId: number | null = null;
    private recordings: Recording[] = [];
    private sortMode: 'default' | 'smart' = 'default';
    private loading = false;

    constructor(opts: ClusterBrowserOptions) {
        this.opts = {
            container: opts.container,
            dataset: opts.dataset,
            clusterField: opts.clusterField ?? 'clusterId',
            probabilityField: opts.probabilityField ?? 'clusterProb',
            uniquenessField: opts.uniquenessField ?? 'uniqueness',
            hardnessField: opts.hardnessField ?? 'hardness',
            onStatusMessage: opts.onStatusMessage ?? ((m) => console.log(m)),
            onOpenRecording: opts.onOpenRecording,
            onRunClustering: opts.onRunClustering,
        };
        this.render();
    }

    // ── Public API ───────────────────────────────────────────────────

    /** Load recordings from the dataset and group by cluster. */
    async load(): Promise<void> {
        this.setLoading(true);
        this.opts.onStatusMessage('Loading recordings…');
        try {
            // Load up to 50 000 recordings (no pagination limit needed for analysis)
            this.recordings = await recordingList({ datasetId: this.opts.dataset.id, limit: 50000 });
            this.buildClusters();
            this.renderClusters();
            if (this.selectedClusterId !== null) {
                this.renderGrid();
            }
            const clusterCount = this.clusters.filter(c => c.clusterId >= 0).length;
            const noiseCount   = this.clusters.find(c => c.clusterId === -1)?.recordings.length ?? 0;
            this.opts.onStatusMessage(
                `${clusterCount} clusters loaded, ${noiseCount} unassigned.`,
            );
        } catch (err) {
            this.opts.onStatusMessage(`Error: ${err}`);
        } finally {
            this.setLoading(false);
        }
    }

    updateDataset(dataset: Dataset): void {
        (this.opts as { dataset: Dataset }).dataset = dataset;
    }

    // ── Cluster building ─────────────────────────────────────────────

    private buildClusters(): void {
        const map = new Map<number, Recording[]>();

        for (const rec of this.recordings) {
            const rawId = (rec as unknown as Record<string, unknown>).fields;
            const fieldsObj = typeof rawId === 'object' && rawId !== null
                ? rawId as Record<string, unknown>
                : {};
            const cid = typeof fieldsObj[this.opts.clusterField] === 'number'
                ? (fieldsObj[this.opts.clusterField] as number)
                : -1;
            if (!map.has(cid)) map.set(cid, []);
            map.get(cid)!.push(rec);
        }

        // Sort: cluster 0, 1, 2, … then -1 (noise) last
        this.clusters = [...map.entries()]
            .sort(([a], [b]) => {
                if (a === -1) return 1;
                if (b === -1) return -1;
                return a - b;
            })
            .map(([clusterId, recs]) => ({ clusterId, recordings: recs }));
    }

    private sortedRecordings(recs: Recording[]): Recording[] {
        if (this.sortMode === 'default') return recs;

        // Smart sort: uniqueness + hardness combined (both 0–1, equal weight)
        return [...recs].sort((a, b) => {
            const score = (r: Recording): number => {
                const f = (r as unknown as Record<string, unknown>).fields as Record<string, unknown> ?? {};
                const u = typeof f[this.opts.uniquenessField] === 'number' ? (f[this.opts.uniquenessField] as number) : 0;
                const h = typeof f[this.opts.hardnessField]   === 'number' ? (f[this.opts.hardnessField]   as number) : 0;
                return (u + h) / 2;
            };
            return score(b) - score(a); // descending
        });
    }

    // ── Rendering ────────────────────────────────────────────────────

    private render(): void {
        this.opts.container.innerHTML = '';
        this.opts.container.className = 'cluster-browser';

        const toolbar = document.createElement('div');
        toolbar.className = 'cluster-toolbar';
        toolbar.innerHTML = `
            <button class="cb-btn cb-run-btn" title="Recompute clustering">⟳ Clustering</button>
            <button class="cb-btn cb-hardness-btn" title="Compute hardness scores">⚡ Hardness</button>
            <span class="cb-spacer"></span>
            <label class="cb-sort-label">
                <input type="checkbox" class="cb-smart-toggle">
                Smart-Sampling
            </label>
        `;
        this.opts.container.appendChild(toolbar);

        toolbar.querySelector<HTMLButtonElement>('.cb-run-btn')!.addEventListener('click', () => this.onClickRunClustering());
        toolbar.querySelector<HTMLButtonElement>('.cb-hardness-btn')!.addEventListener('click', () => this.onClickComputeHardness());
        toolbar.querySelector<HTMLInputElement>('.cb-smart-toggle')!.addEventListener('change', (e) => {
            this.sortMode = (e.target as HTMLInputElement).checked ? 'smart' : 'default';
            this.renderGrid();
        });

        const body = document.createElement('div');
        body.className = 'cluster-body';

        const sidebar = document.createElement('div');
        sidebar.className = 'cluster-sidebar';
        sidebar.innerHTML = '<div class="cluster-list" role="listbox"></div>';

        const main = document.createElement('div');
        main.className = 'cluster-main';
        main.innerHTML = '<div class="cluster-grid"></div><div class="cluster-batch-actions"></div>';

        body.appendChild(sidebar);
        body.appendChild(main);
        this.opts.container.appendChild(body);
    }

    private renderClusters(): void {
        const list = this.opts.container.querySelector<HTMLElement>('.cluster-list')!;
        list.innerHTML = '';

        for (const cl of this.clusters) {
            const item = document.createElement('div');
            item.className = 'cluster-list-item' + (cl.clusterId === this.selectedClusterId ? ' selected' : '');
            item.setAttribute('role', 'option');
            item.dataset.clusterId = String(cl.clusterId);

            const label = cl.clusterId === -1 ? '⊘ Noise' : `Cluster ${cl.clusterId}`;
            item.innerHTML = `
                <span class="cl-label">${label}</span>
                <span class="cl-count">${cl.recordings.length}</span>
            `;
            item.addEventListener('click', () => this.selectCluster(cl.clusterId));
            list.appendChild(item);
        }
    }

    private selectCluster(clusterId: number): void {
        this.selectedClusterId = clusterId;
        // Update active state in sidebar
        for (const item of this.opts.container.querySelectorAll<HTMLElement>('.cluster-list-item')) {
            item.classList.toggle('selected', item.dataset.clusterId === String(clusterId));
        }
        this.renderGrid();
        this.renderBatchActions();
    }

    private renderGrid(): void {
        const grid = this.opts.container.querySelector<HTMLElement>('.cluster-grid')!;
        grid.innerHTML = '';

        if (this.selectedClusterId === null) {
            grid.innerHTML = '<p class="cluster-empty">Wähle einen Cluster links aus.</p>';
            return;
        }

        const cl = this.clusters.find(c => c.clusterId === this.selectedClusterId);
        if (!cl || cl.recordings.length === 0) {
            grid.innerHTML = '<p class="cluster-empty">No recordings in this cluster.</p>';
            return;
        }

        const sorted = this.sortedRecordings(cl.recordings);
        for (const rec of sorted) {
            grid.appendChild(this.buildCard(rec));
        }
    }

    private buildCard(rec: Recording): HTMLElement {
        const card = document.createElement('div');
        card.className = 'cluster-card';

        const fields = (rec as unknown as Record<string, unknown>).fields as Record<string, unknown> ?? {};
        const uniqueness = typeof fields[this.opts.uniquenessField] === 'number'
            ? (fields[this.opts.uniquenessField] as number)
            : null;
        const hardness = typeof fields[this.opts.hardnessField] === 'number'
            ? (fields[this.opts.hardnessField] as number)
            : null;
        const prob = typeof fields[this.opts.probabilityField] === 'number'
            ? (fields[this.opts.probabilityField] as number)
            : null;

        const name = rec.filepath.split('/').pop() ?? rec.filepath;
        card.innerHTML = `
            <div class="cc-thumb"></div>
            <div class="cc-info">
                <span class="cc-name" title="${rec.filepath}">${name}</span>
                <div class="cc-badges">
                    ${uniqueness !== null ? `<span class="cc-badge cb-uniqueness" title="Uniqueness">U ${(uniqueness * 100).toFixed(0)}%</span>` : ''}
                    ${hardness   !== null ? `<span class="cc-badge cb-hardness"   title="Hardness">H ${(hardness   * 100).toFixed(0)}%</span>` : ''}
                    ${prob       !== null ? `<span class="cc-badge cb-prob"        title="Cluster-Wahrscheinlichkeit">P ${(prob * 100).toFixed(0)}%</span>` : ''}
                </div>
            </div>
        `;

        card.addEventListener('click', () => this.opts.onOpenRecording?.(rec));

        // Async waveform thumbnail
        getWaveformThumbnail(rec.filepath)
            .then((url: string | undefined) => {
                const thumb = card.querySelector<HTMLElement>('.cc-thumb');
                if (thumb && url) {
                    thumb.style.backgroundImage = `url("${url}")`;
                    thumb.style.backgroundSize = 'cover';
                }
            })
            .catch(() => { /* best-effort */ });

        return card;
    }

    private renderBatchActions(): void {
        const bar = this.opts.container.querySelector<HTMLElement>('.cluster-batch-actions')!;
        bar.innerHTML = '';
        if (this.selectedClusterId === null) return;

        const cl = this.clusters.find(c => c.clusterId === this.selectedClusterId);
        if (!cl) return;

        const label = this.selectedClusterId === -1 ? 'Noise' : `Cluster ${this.selectedClusterId}`;
        bar.innerHTML = `
            <span class="batch-info">${cl.recordings.length} recording(s) in ${label}</span>
            <input class="batch-tag-input" type="text" placeholder="Tag eingeben…" maxlength="80">
            <button class="cb-btn batch-tag-btn">Tag anwenden</button>
        `;

        bar.querySelector<HTMLButtonElement>('.batch-tag-btn')!.addEventListener('click', () => {
            const input = bar.querySelector<HTMLInputElement>('.batch-tag-input')!;
            const tag = input.value.trim();
            if (tag) this.batchApplyTag(cl.recordings, tag);
        });
    }

    // ── Actions ──────────────────────────────────────────────────────

    private async batchApplyTag(recordings: Recording[], tag: string): Promise<void> {
        this.opts.onStatusMessage(`Applying tag "${tag}" to ${recordings.length} recording(s)…`);
        let applied = 0;
        for (const rec of recordings) {
            try {
                const nextTags = rec.tags.includes(tag) ? rec.tags : [...rec.tags, tag];
                await recordingSetTags(rec.id, nextTags);
                rec.tags = nextTags;
                applied += 1;
            } catch { /* continue */ }
        }
        this.opts.onStatusMessage(`Tag "${tag}" applied to ${applied} recording(s).`);
    }

    private async onClickRunClustering(): Promise<void> {
        if (this.loading) return;

        const embeddingField = prompt('Embedding-Feld:', 'embedding');
        if (!embeddingField) return;

        const args: DatasetRunClusteringArgs = {
            datasetId:       this.opts.dataset.id,
            embeddingField,
            outputField:     this.opts.clusterField,
            probabilityField: this.opts.probabilityField,
        };

        this.setLoading(true);
        this.opts.onStatusMessage('Clustering running…');
        try {
            const fn = this.opts.onRunClustering ?? datasetRunClustering;
            const summary = await fn(args);
            this.opts.onStatusMessage(
                `Clustering complete: ${summary.nClusters} clusters, ${summary.nNoise} noise.`,
            );
            await this.load();
        } catch (err) {
            this.opts.onStatusMessage(`Clustering error: ${err}`);
        } finally {
            this.setLoading(false);
        }
    }

    private async onClickComputeHardness(): Promise<void> {
        if (this.loading) return;

        const fieldName = prompt('BirdNET-Feld (SoundEvents):', 'birdnetV24');
        if (!fieldName) return;

        this.setLoading(true);
        this.opts.onStatusMessage('Computing hardness scores…');
        try {
            const summary = await datasetComputeHardness({
                datasetId:   this.opts.dataset.id,
                fieldName,
                outputField: this.opts.hardnessField,
            });
            this.opts.onStatusMessage(`Hardness scores computed for ${summary.processed} recording(s).`);
            await this.load();
        } catch (err) {
            this.opts.onStatusMessage(`Hardness error: ${err}`);
        } finally {
            this.setLoading(false);
        }
    }

    private setLoading(on: boolean): void {
        this.loading = on;
        const btn = this.opts.container.querySelector<HTMLButtonElement>('.cb-run-btn');
        if (btn) btn.disabled = on;
    }
}
