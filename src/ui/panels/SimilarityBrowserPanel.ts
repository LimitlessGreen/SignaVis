// ═══════════════════════════════════════════════════════════════════════
// ui/panels/SimilarityBrowserPanel.ts — Shows recordings similar to a
// reference recording, ranked by cosine similarity of BirdNET embeddings.
// ═══════════════════════════════════════════════════════════════════════

import type { Recording } from '../../domain/corpus/types.ts';
import {
    recordingGetSimilar,
    recordingGet,
    type SimilarityResult,
} from '../../infrastructure/tauri/TauriCorpusAdapter.ts';
import { getWaveformThumbnail } from '../services/WaveformThumbnailService.ts';

export interface SimilarityBrowserOptions {
    container: HTMLElement;
    /** Default embedding field name. */
    embeddingField?: string;
    /** How many similar recordings to fetch. */
    topK?: number;
    onOpenRecording?: (recording: Recording) => void;
    onStatusMessage?: (msg: string) => void;
}

export class SimilarityBrowserPanel {
    private readonly container: HTMLElement;
    private readonly embeddingField: string;
    private readonly topK: number;
    private readonly onOpenRecording: ((r: Recording) => void) | undefined;
    private readonly onStatusMessage: (msg: string) => void;

    private reference: Recording | null = null;
    private results: SimilarityResult[] = [];
    private loading = false;

    constructor(opts: SimilarityBrowserOptions) {
        this.container = opts.container;
        this.embeddingField = opts.embeddingField ?? 'embedding';
        this.topK = opts.topK ?? 20;
        this.onOpenRecording = opts.onOpenRecording;
        this.onStatusMessage = opts.onStatusMessage ?? ((m) => console.log(m));
        this.renderEmpty();
    }

    /** Sets the reference recording and immediately fetches similar ones. */
    async showSimilarTo(recording: Recording): Promise<void> {
        this.reference = recording;
        this.results = [];
        this.renderLoading();

        try {
            this.results = await recordingGetSimilar({
                recordingId: recording.id,
                datasetId: recording.datasetId,
                embeddingField: this.embeddingField,
                topK: this.topK,
            });
        } catch (e) {
            this.onStatusMessage(`Similarity search failed: ${e}`);
            this.results = [];
        }

        await this.render();
    }

    /** Clears the panel back to its placeholder state. */
    clear(): void {
        this.reference = null;
        this.results = [];
        this.renderEmpty();
    }

    // ── Private ─────────────────────────────────────────────────────

    private renderEmpty(): void {
        this.container.innerHTML = `
            <div class="similarity-browser similarity-browser--empty">
                <div class="similarity-browser__placeholder">
                    <div class="similarity-browser__icon">🔍</div>
                    <div class="similarity-browser__hint">Click "Find Similar" on a recording to search by acoustic similarity.</div>
                </div>
            </div>
        `;
    }

    private renderLoading(): void {
        const ref = this.reference!;
        const filename = ref.filepath.split('/').pop() ?? ref.filepath;
        this.container.innerHTML = `
            <div class="similarity-browser">
                <div class="similarity-browser__header">
                    <span class="similarity-browser__title">Similar to: <strong>${escapeHtml(filename)}</strong></span>
                </div>
                <div class="similarity-browser__loading">
                    <span class="spinner"></span> Searching…
                </div>
            </div>
        `;
    }

    private async render(): Promise<void> {
        const ref = this.reference!;
        const filename = ref.filepath.split('/').pop() ?? ref.filepath;

        if (this.results.length === 0) {
            this.container.innerHTML = `
                <div class="similarity-browser">
                    <div class="similarity-browser__header">
                        <span class="similarity-browser__title">Similar to: <strong>${escapeHtml(filename)}</strong></span>
                    </div>
                    <div class="similarity-browser__empty">
                        No similar recordings found. Make sure embeddings have been computed for this dataset.
                    </div>
                </div>
            `;
            return;
        }

        this.container.innerHTML = `
            <div class="similarity-browser">
                <div class="similarity-browser__header">
                    <span class="similarity-browser__title">Similar to: <strong>${escapeHtml(filename)}</strong></span>
                    <span class="badge badge--neutral">${this.results.length} results</span>
                </div>
                <div class="similarity-browser__grid" id="simGrid">
                    ${this.results.map((r, i) => this.renderCard(r, i)).join('')}
                </div>
            </div>
        `;

        // Load waveform thumbnails asynchronously
        const grid = this.container.querySelector('#simGrid')!;
        await Promise.all(
            this.results.map(async (result, i) => {
                try {
                    const thumb = await getWaveformThumbnail(result.filepath);
                    const img = grid.querySelector<HTMLImageElement>(`[data-thumb-idx="${i}"]`);
                    if (img && thumb) {
                        img.src = thumb;
                        img.style.display = '';
                    }
                } catch {
                    // thumbnail optional
                }
            }),
        );

        // Bind click events
        grid.querySelectorAll<HTMLElement>('[data-result-idx]').forEach((card) => {
            card.addEventListener('click', async () => {
                const idx = parseInt(card.dataset.resultIdx!, 10);
                const result = this.results[idx];
                if (!result || !this.onOpenRecording) return;
                try {
                    const rec = await recordingGet(result.recordingId);
                    this.onOpenRecording(rec);
                } catch (e) {
                    this.onStatusMessage(`Could not load recording: ${e}`);
                }
            });
        });
    }

    private renderCard(result: SimilarityResult, idx: number): string {
        const filename = result.filepath.split('/').pop() ?? result.filepath;
        const simPct = Math.round(result.similarity * 100);
        const simClass = simPct >= 80
            ? 'similarity-badge--high'
            : simPct >= 60
            ? 'similarity-badge--mid'
            : 'similarity-badge--low';

        return `
            <div class="similarity-card" data-result-idx="${idx}" role="button" tabindex="0">
                <div class="similarity-card__thumb-wrap">
                    <img
                        class="similarity-card__thumb"
                        data-thumb-idx="${idx}"
                        src=""
                        alt=""
                        style="display:none"
                    />
                    <div class="similarity-card__thumb-placeholder">🎵</div>
                </div>
                <div class="similarity-card__info">
                    <div class="similarity-card__name" title="${escapeHtml(result.filepath)}">${escapeHtml(filename)}</div>
                    <div class="similarity-badge ${simClass}">${simPct}% similar</div>
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
