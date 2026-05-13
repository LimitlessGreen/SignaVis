// ═══════════════════════════════════════════════════════════════════════
// ui/panels/TrainingSplitPanel.ts — Train / Val / Test split workflow
//
// Lets the user assign train/val/test tags to the recordings in the
// current dataset (or a filtered view).  Supports:
//   - Automatic random split by ratio
//   - Manual assignment via tag pills in the gallery
//   - Stats display: how many recordings carry each split tag
// ═══════════════════════════════════════════════════════════════════════

import type { Dataset, Recording } from '../../domain/corpus/types.ts';
import { recordingList, recordingSetTags } from '../../infrastructure/tauri/TauriCorpusAdapter.ts';

const SPLIT_TAGS = ['train', 'val', 'test'] as const;
type SplitTag = typeof SPLIT_TAGS[number];

export interface TrainingSplitOptions {
    container: HTMLElement;
    dataset: Dataset;
    onStatusMessage?: (msg: string) => void;
    onClose?: () => void;
}

export class TrainingSplitPanel {
    private readonly container: HTMLElement;
    private readonly dataset: Dataset;
    private readonly onStatusMessage: (msg: string) => void;
    private readonly onClose: (() => void) | undefined;

    private recordings: Recording[] = [];
    private isLoading = false;

    constructor(opts: TrainingSplitOptions) {
        this.container = opts.container;
        this.dataset = opts.dataset;
        this.onStatusMessage = opts.onStatusMessage ?? console.log;
        this.onClose = opts.onClose;
    }

    async mount(): Promise<void> {
        this.container.innerHTML = this.renderShell();
        this.bindEvents();
        await this.loadRecordings();
    }

    private renderShell(): string {
        return `
            <div class="split-panel">
                <div class="split-panel__header">
                    <h3 class="split-panel__title">Training split — ${escapeHtml(this.dataset.name)}</h3>
                    <button class="btn btn--ghost btn--icon" id="splitClose" title="Close">✕</button>
                </div>

                <div class="split-panel__body">

                    <section class="split-section">
                        <div class="split-section__label">Current split</div>
                        <div class="split-stats" id="splitStats">
                            <span class="split-stat split-stat--loading">Loading…</span>
                        </div>
                    </section>

                    <section class="split-section">
                        <div class="split-section__label">Auto-split (random)</div>
                        <div class="split-form">
                            <label class="split-ratio-label">
                                Train <input type="number" class="input input--sm" id="splitRatioTrain"
                                    value="70" min="1" max="98" step="1"> %
                            </label>
                            <label class="split-ratio-label">
                                Val <input type="number" class="input input--sm" id="splitRatioVal"
                                    value="15" min="1" max="98" step="1"> %
                            </label>
                            <label class="split-ratio-label">
                                Test <input type="number" class="input input--sm" id="splitRatioTest"
                                    value="15" min="1" max="98" step="1"> %
                            </label>
                            <div class="split-form__hint" id="splitRatioHint"></div>
                            <div class="split-form__scope">
                                <label>
                                    <input type="radio" name="splitScope" value="all" checked> All recordings
                                </label>
                                <label>
                                    <input type="radio" name="splitScope" value="untagged"> Untagged only
                                </label>
                            </div>
                            <button class="btn btn--primary btn--sm" id="splitApplyAuto">Apply split</button>
                        </div>
                    </section>

                    <section class="split-section">
                        <div class="split-section__label">Clear split tags</div>
                        <div class="split-clear-row">
                            ${SPLIT_TAGS.map((t) => `
                                <button class="btn btn--ghost btn--sm" data-clear-tag="${t}">
                                    Clear all "${t}"
                                </button>
                            `).join('')}
                        </div>
                    </section>

                </div>
            </div>
        `;
    }

    private bindEvents(): void {
        this.container.querySelector('#splitClose')?.addEventListener('click', () => this.onClose?.());

        const trainInput = this.container.querySelector('#splitRatioTrain') as HTMLInputElement;
        const valInput   = this.container.querySelector('#splitRatioVal') as HTMLInputElement;
        const testInput  = this.container.querySelector('#splitRatioTest') as HTMLInputElement;
        const hint       = this.container.querySelector('#splitRatioHint') as HTMLElement;

        const updateHint = () => {
            const sum = parseInt(trainInput.value) + parseInt(valInput.value) + parseInt(testInput.value);
            hint.textContent = sum === 100 ? '' : `Ratios sum to ${sum}% — must be 100%`;
            hint.style.color = sum === 100 ? '' : 'var(--color-error, red)';
        };
        [trainInput, valInput, testInput].forEach((i) => i.addEventListener('input', updateHint));

        this.container.querySelector('#splitApplyAuto')?.addEventListener('click', () => {
            const sum = parseInt(trainInput.value) + parseInt(valInput.value) + parseInt(testInput.value);
            if (sum !== 100) { this.onStatusMessage('Ratios must sum to 100%.'); return; }
            const scope = (this.container.querySelector('input[name="splitScope"]:checked') as HTMLInputElement).value;
            this.applyAutoSplit(
                parseInt(trainInput.value) / 100,
                parseInt(valInput.value) / 100,
                parseInt(testInput.value) / 100,
                scope as 'all' | 'untagged',
            );
        });

        this.container.querySelectorAll<HTMLButtonElement>('[data-clear-tag]').forEach((btn) => {
            btn.addEventListener('click', () => this.clearTag(btn.dataset.clearTag as SplitTag));
        });
    }

    private async loadRecordings(): Promise<void> {
        this.isLoading = true;
        try {
            // Load all recordings (no pagination limit — we need full list for split)
            this.recordings = await recordingList({ datasetId: this.dataset.id, limit: 10000 });
        } catch (e) {
            this.onStatusMessage(`Error loading recordings: ${e}`);
        } finally {
            this.isLoading = false;
        }
        this.renderStats();
    }

    private renderStats(): void {
        const stats = this.container.querySelector('#splitStats');
        if (!stats) return;

        const counts: Record<string, number> = { train: 0, val: 0, test: 0, untagged: 0 };
        for (const r of this.recordings) {
            let hasSplit = false;
            for (const t of SPLIT_TAGS) {
                if (r.tags.includes(t)) { counts[t]++; hasSplit = true; }
            }
            if (!hasSplit) counts.untagged++;
        }

        const total = this.recordings.length;
        stats.innerHTML = [
            ...SPLIT_TAGS.map((t) => {
                const n = counts[t];
                const pct = total > 0 ? Math.round((n / total) * 100) : 0;
                return `<span class="split-stat split-stat--${t}">
                    <span class="split-stat__label">${t}</span>
                    <span class="split-stat__count">${n}</span>
                    <span class="split-stat__pct">${pct}%</span>
                </span>`;
            }),
            `<span class="split-stat split-stat--untagged">
                <span class="split-stat__label">untagged</span>
                <span class="split-stat__count">${counts.untagged}</span>
            </span>`,
        ].join('');
    }

    private async applyAutoSplit(
        trainRatio: number,
        valRatio: number,
        _testRatio: number,
        scope: 'all' | 'untagged',
    ): Promise<void> {
        const pool = scope === 'untagged'
            ? this.recordings.filter((r) => !SPLIT_TAGS.some((t) => r.tags.includes(t)))
            : [...this.recordings];

        if (pool.length === 0) {
            this.onStatusMessage('No recordings to split.');
            return;
        }

        // Fisher-Yates shuffle
        for (let i = pool.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [pool[i], pool[j]] = [pool[j], pool[i]];
        }

        const nTrain = Math.round(pool.length * trainRatio);
        const nVal   = Math.round(pool.length * valRatio);

        const assignments: [Recording, SplitTag][] = [
            ...pool.slice(0, nTrain).map((r): [Recording, SplitTag] => [r, 'train']),
            ...pool.slice(nTrain, nTrain + nVal).map((r): [Recording, SplitTag] => [r, 'val']),
            ...pool.slice(nTrain + nVal).map((r): [Recording, SplitTag] => [r, 'test']),
        ];

        this.onStatusMessage(`Applying split to ${pool.length} recordings…`);
        let done = 0;
        for (const [rec, tag] of assignments) {
            const newTags = rec.tags
                .filter((t) => !SPLIT_TAGS.includes(t as SplitTag))
                .concat(tag);
            try {
                await recordingSetTags(rec.id, newTags);
                rec.tags = newTags;
            } catch { /* continue */ }
            done++;
            if (done % 50 === 0) {
                this.onStatusMessage(`Split: ${done} / ${pool.length}…`);
            }
        }

        this.onStatusMessage(
            `Split applied: ${nTrain} train, ${nVal} val, ${pool.length - nTrain - nVal} test.`,
        );
        this.renderStats();
    }

    private async clearTag(tag: SplitTag): Promise<void> {
        const toUpdate = this.recordings.filter((r) => r.tags.includes(tag));
        if (toUpdate.length === 0) { this.onStatusMessage(`No "${tag}" recordings.`); return; }
        this.onStatusMessage(`Clearing tag "${tag}" from ${toUpdate.length} recordings…`);
        for (const rec of toUpdate) {
            const newTags = rec.tags.filter((t) => t !== tag);
            try {
                await recordingSetTags(rec.id, newTags);
                rec.tags = newTags;
            } catch { /* continue */ }
        }
        this.onStatusMessage(`Cleared "${tag}" from ${toUpdate.length} recordings.`);
        this.renderStats();
    }
}

function escapeHtml(s: string): string {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
