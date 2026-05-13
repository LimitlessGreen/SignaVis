// ═══════════════════════════════════════════════════════════════════════
// ui/panels/EmbeddingScatterPanel.ts — 2-D UMAP scatter plot of recordings
//
// Reads the `umap2d` field ([x, y]) from each recording.
// Supports pan/zoom; click opens recording in detail panel.
// ═══════════════════════════════════════════════════════════════════════

import type { Recording, Dataset } from '../../domain/corpus/types.ts';
import {
    datasetComputeUmap,
    datasetRunEmbedding,
    type DatasetComputeUmapArgs,
    type EmbeddingRunArgs,
} from '../../infrastructure/tauri/TauriCorpusAdapter.ts';

export interface EmbeddingScatterOptions {
    container: HTMLElement;
    dataset: Dataset;
    /** Field holding the 1-D float embedding. Default "embedding". */
    embeddingField?: string;
    /** Field holding the [x, y] UMAP result. Default "umap2d". */
    umapField?: string;
    onOpenRecording?: (recording: Recording) => void;
    onStatusMessage?: (msg: string) => void;
    /** Called when the user clicks the Cluster Browser button in the toolbar. */
    onShowClusters?: () => void;
}

interface Point {
    x: number;
    y: number;
    recording: Recording;
}

export class EmbeddingScatterPanel {
    private readonly container: HTMLElement;
    private dataset: Dataset;
    private readonly embeddingField: string;
    private readonly umapField: string;
    private readonly onOpenRecording: ((r: Recording) => void) | undefined;
    private readonly onStatusMessage: (msg: string) => void;
    private readonly onShowClusters: (() => void) | undefined;

    private canvas: HTMLCanvasElement | null = null;
    private points: Point[] = [];

    // Pan / zoom state
    private offsetX = 0;
    private offsetY = 0;
    private scale = 1;
    private isDragging = false;
    private dragStartX = 0;
    private dragStartY = 0;

    private running = false;

    constructor(opts: EmbeddingScatterOptions) {
        this.container = opts.container;
        this.dataset = opts.dataset;
        this.embeddingField = opts.embeddingField ?? 'embedding';
        this.umapField = opts.umapField ?? 'umap2d';
        this.onOpenRecording = opts.onOpenRecording;
        this.onStatusMessage = opts.onStatusMessage ?? ((m) => console.log(m));
        this.onShowClusters = opts.onShowClusters;
    }

    /** Load recordings with umap2d coordinates and draw the scatter plot. */
    async mount(recordings: Recording[]): Promise<void> {
        this.points = [];
        for (const rec of recordings) {
            const fields = rec.fields as Record<string, unknown> | undefined;
            const raw = fields?.[this.umapField];
            if (!Array.isArray(raw) || raw.length < 2) continue;
            const [x, y] = raw as [number, number];
            if (typeof x !== 'number' || typeof y !== 'number') continue;
            this.points.push({ x, y, recording: rec });
        }

        this.renderShell();
        if (this.points.length === 0) {
            this.renderNoData();
        } else {
            this.fitView();
            this.draw();
        }
    }

    /** Update the dataset reference (e.g. after re-import). */
    updateDataset(dataset: Dataset): void {
        this.dataset = dataset;
    }

    // ── Private ─────────────────────────────────────────────────────

    private renderShell(): void {
        this.container.innerHTML = `
            <div class="scatter-panel">
                <div class="scatter-panel__toolbar">
                    <span class="scatter-panel__title">Embedding Scatter</span>
                    <div class="scatter-panel__actions">
                        <button class="btn btn--ghost btn--sm" id="scatterRunEmbed">⚙ Compute Embeddings</button>
                        <button class="btn btn--ghost btn--sm" id="scatterRunUmap">📐 Compute UMAP</button>
                        <button class="btn btn--ghost btn--sm" id="scatterFit" title="Fit all points">⊡ Fit</button>
                        <button class="btn btn--ghost btn--sm" id="scatterShowClusters" title="Open cluster browser">⬡ Clusters</button>
                    </div>
                </div>
                <canvas class="scatter-panel__canvas" id="scatterCanvas"></canvas>
                <div class="scatter-panel__tooltip" id="scatterTooltip" style="display:none"></div>
                <div class="scatter-panel__status" id="scatterStatus"></div>
            </div>
        `;
        this.canvas = this.container.querySelector('#scatterCanvas');
        this.resizeCanvas();
        this.bindEvents();
    }

    private renderNoData(): void {
        const status = this.container.querySelector('#scatterStatus');
        if (status) {
            status.innerHTML = `No UMAP coordinates found. Click <em>Compute Embeddings</em> then <em>Compute UMAP</em> to get started.`;
        }
    }

    private resizeCanvas(): void {
        if (!this.canvas) return;
        const rect = this.canvas.parentElement!.getBoundingClientRect();
        const w = Math.max(rect.width, 300);
        const h = Math.max(rect.height - 48, 200); // minus toolbar
        this.canvas.width = w;
        this.canvas.height = h;
    }

    private fitView(): void {
        if (!this.canvas || this.points.length === 0) return;
        const xs = this.points.map((p) => p.x);
        const ys = this.points.map((p) => p.y);
        const minX = Math.min(...xs);
        const maxX = Math.max(...xs);
        const minY = Math.min(...ys);
        const maxY = Math.max(...ys);
        const rangeX = maxX - minX || 1;
        const rangeY = maxY - minY || 1;
        const pad = 40;
        const w = this.canvas.width - pad * 2;
        const h = this.canvas.height - pad * 2;
        this.scale = Math.min(w / rangeX, h / rangeY);
        this.offsetX = pad - minX * this.scale;
        this.offsetY = pad - minY * this.scale;
    }

    private worldToCanvas(wx: number, wy: number): [number, number] {
        return [wx * this.scale + this.offsetX, wy * this.scale + this.offsetY];
    }

    private canvasToWorld(cx: number, cy: number): [number, number] {
        return [(cx - this.offsetX) / this.scale, (cy - this.offsetY) / this.scale];
    }

    private draw(): void {
        if (!this.canvas) return;
        const ctx = this.canvas.getContext('2d')!;
        const { width, height } = this.canvas;
        ctx.clearRect(0, 0, width, height);

        const radius = Math.max(2, Math.min(6, 600 / (this.points.length || 1)));

        for (const pt of this.points) {
            const [cx, cy] = this.worldToCanvas(pt.x, pt.y);
            const fields = pt.recording.fields as Record<string, unknown> | undefined;
            const uniqueness = fields?.['uniqueness'];
            // Color by uniqueness if available, else use accent color
            const color = typeof uniqueness === 'number'
                ? this.heatColor(uniqueness)
                : getComputedStyle(document.documentElement).getPropertyValue('--color-accent').trim() || '#4e91e8';

            ctx.beginPath();
            ctx.arc(cx, cy, radius, 0, Math.PI * 2);
            ctx.fillStyle = color;
            ctx.globalAlpha = 0.75;
            ctx.fill();
            ctx.globalAlpha = 1;
        }
    }

    /** Maps 0→blue (common) through 1→red (unique). */
    private heatColor(t: number): string {
        const r = Math.round(t * 220);
        const b = Math.round((1 - t) * 200);
        return `rgb(${r},80,${b})`;
    }

    private hitTest(cx: number, cy: number): Point | null {
        const hitRadius = Math.max(8, 600 / (this.points.length || 1));
        for (const pt of this.points) {
            const [px, py] = this.worldToCanvas(pt.x, pt.y);
            const dx = cx - px;
            const dy = cy - py;
            if (Math.sqrt(dx * dx + dy * dy) < hitRadius) return pt;
        }
        return null;
    }

    private bindEvents(): void {
        const canvas = this.canvas;
        if (!canvas) return;
        const tooltip = this.container.querySelector<HTMLElement>('#scatterTooltip');

        // Mouse down → start drag
        canvas.addEventListener('mousedown', (e) => {
            this.isDragging = true;
            this.dragStartX = e.clientX;
            this.dragStartY = e.clientY;
        });

        canvas.addEventListener('mousemove', (e) => {
            if (this.isDragging) {
                this.offsetX += e.clientX - this.dragStartX;
                this.offsetY += e.clientY - this.dragStartY;
                this.dragStartX = e.clientX;
                this.dragStartY = e.clientY;
                this.draw();
            } else if (tooltip) {
                const rect = canvas.getBoundingClientRect();
                const cx = e.clientX - rect.left;
                const cy = e.clientY - rect.top;
                const hit = this.hitTest(cx, cy);
                if (hit) {
                    const fn = hit.recording.filepath.split('/').pop() ?? hit.recording.filepath;
                    tooltip.textContent = fn;
                    tooltip.style.display = '';
                    tooltip.style.left = `${cx + 12}px`;
                    tooltip.style.top = `${cy - 8}px`;
                } else {
                    tooltip.style.display = 'none';
                }
            }
        });

        canvas.addEventListener('mouseup', (e) => {
            if (!this.isDragging) return;
            const dx = Math.abs(e.clientX - this.dragStartX);
            const dy = Math.abs(e.clientY - this.dragStartY);
            this.isDragging = false;
            // If barely moved, treat as a click
            if (dx < 4 && dy < 4) {
                const rect = canvas.getBoundingClientRect();
                const cx = e.clientX - rect.left;
                const cy = e.clientY - rect.top;
                const hit = this.hitTest(cx, cy);
                if (hit && this.onOpenRecording) {
                    this.onOpenRecording(hit.recording);
                }
            }
        });

        canvas.addEventListener('mouseleave', () => {
            this.isDragging = false;
            if (tooltip) tooltip.style.display = 'none';
        });

        // Wheel → zoom
        canvas.addEventListener('wheel', (e) => {
            e.preventDefault();
            const rect = canvas.getBoundingClientRect();
            const cx = e.clientX - rect.left;
            const cy = e.clientY - rect.top;
            const [wx, wy] = this.canvasToWorld(cx, cy);
            const factor = e.deltaY < 0 ? 1.15 : 0.87;
            this.scale *= factor;
            // Keep the mouse point stable
            this.offsetX = cx - wx * this.scale;
            this.offsetY = cy - wy * this.scale;
            this.draw();
        }, { passive: false });

        // Toolbar buttons
        this.container.querySelector('#scatterFit')?.addEventListener('click', () => {
            this.fitView();
            this.draw();
        });

        this.container.querySelector('#scatterRunEmbed')?.addEventListener('click', () => {
            this.runEmbedding();
        });

        this.container.querySelector('#scatterRunUmap')?.addEventListener('click', () => {
            this.runUmap();
        });

        this.container.querySelector('#scatterShowClusters')?.addEventListener('click', () => {
            this.onShowClusters?.();
        });
    }

    private setStatus(msg: string): void {
        const el = this.container.querySelector('#scatterStatus');
        if (el) el.textContent = msg;
    }

    private async runEmbedding(): Promise<void> {
        if (this.running) return;
        this.running = true;
        this.setStatus('⏳ Computing embeddings…');
        try {
            const args: EmbeddingRunArgs = {
                datasetId: this.dataset.id,
                fieldName: this.embeddingField,
            };
            const summary = await datasetRunEmbedding(args);
            this.setStatus(`✓ Embeddings computed for ${summary.processed} recordings.`);
            this.onStatusMessage(`Embeddings done: ${summary.processed} processed, ${summary.errors} errors.`);
        } catch (e) {
            this.setStatus(`✗ Embedding error: ${e}`);
            this.onStatusMessage(`Embedding error: ${e}`);
        } finally {
            this.running = false;
        }
    }

    private async runUmap(): Promise<void> {
        if (this.running) return;
        this.running = true;
        this.setStatus('⏳ Computing UMAP…');
        try {
            const args: DatasetComputeUmapArgs = {
                datasetId: this.dataset.id,
                embeddingField: this.embeddingField,
                outputField: this.umapField,
            };
            const summary = await datasetComputeUmap(args);
            this.setStatus(`✓ UMAP computed for ${summary.processed} recordings.`);
            this.onStatusMessage(`UMAP done: ${summary.processed} processed.`);
        } catch (e) {
            this.setStatus(`✗ UMAP error: ${e}`);
            this.onStatusMessage(`UMAP error: ${e}`);
        } finally {
            this.running = false;
        }
    }
}
