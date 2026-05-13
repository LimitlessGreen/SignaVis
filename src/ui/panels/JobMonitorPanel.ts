// ═══════════════════════════════════════════════════════════════════════
// ui/panels/JobMonitorPanel.ts — Live job monitor widget
//
// Shows running and recently completed analysis runs.
// Subscribes to Tauri events:
//   "dataset:birdnet-progress" — updates the progress bar of a running job
//   "dataset:birdnet-done"     — marks a job completed/failed, stores in history
//
// Designed to be mounted once at app startup and live for the session.
// ═══════════════════════════════════════════════════════════════════════

import {
    datasetListRuns,
    type AnalysisRunRecord,
    type BirdnetDonePayload,
} from '../../infrastructure/tauri/TauriCorpusAdapter.ts';

export interface JobMonitorOptions {
    container: HTMLElement;
    /** Called when the user clicks a completed job to navigate to its dataset. */
    onOpenDataset?: (datasetId: string) => void;
}

interface ActiveJob {
    jobId: string;
    datasetId: string;
    label: string;
    current: number;
    total: number;
    currentFile: string;
}

interface DoneJob {
    jobId: string;
    datasetId: string;
    label: string;
    status: 'completed' | 'failed';
    processed: number;
    errors: number;
    doneAt: number;
    errorMessage?: string;
}

const MAX_HISTORY = 10;

export class JobMonitorPanel {
    private readonly container: HTMLElement;
    private readonly onOpenDataset: ((id: string) => void) | undefined;

    private activeJobs: Map<string, ActiveJob> = new Map();
    private doneJobs: DoneJob[] = [];

    private unlistenProgress: (() => void) | null = null;
    private unlistenDone: (() => void) | null = null;

    constructor(opts: JobMonitorOptions) {
        this.container = opts.container;
        this.onOpenDataset = opts.onOpenDataset;
    }

    async mount(): Promise<void> {
        this.render();
        await this.subscribeEvents();
    }

    dispose(): void {
        this.unlistenProgress?.();
        this.unlistenDone?.();
        this.unlistenProgress = null;
        this.unlistenDone = null;
    }

    /** Load historical runs for a dataset into the history list. */
    async loadRunsForDataset(datasetId: string): Promise<void> {
        try {
            const runs = await datasetListRuns(datasetId);
            for (const run of runs) {
                if (run.status === 'completed' || run.status === 'failed') {
                    if (!this.doneJobs.some((d) => d.jobId === run.key)) {
                        this.doneJobs.unshift({
                            jobId: run.key,
                            datasetId,
                            label: this.labelForRun(run),
                            status: run.status as 'completed' | 'failed',
                            processed: run.processed ?? 0,
                            errors: run.errors ?? 0,
                            doneAt: run.completedAt ?? 0,
                            errorMessage: run.errorMessage,
                        });
                    }
                }
            }
            this.doneJobs = this.doneJobs.slice(0, MAX_HISTORY);
            this.render();
        } catch {
            // Non-critical — ignore
        }
    }

    private labelForRun(run: AnalysisRunRecord): string {
        const model = (run.config.model as string) ?? 'analysis';
        const version = (run.config.version as string) ?? '';
        const field = (run.config.outputField as string) ?? '';
        return `${model}${version ? ` v${version}` : ''}${field ? ` → ${field}` : ''}`;
    }

    private async subscribeEvents(): Promise<void> {
        const { listen } = await import('@tauri-apps/api/event');

        const unlistenProgress = await listen<{
            jobId: string;
            datasetId: string;
            current: number;
            total: number;
            filepath: string | null;
        }>('dataset:birdnet-progress', (event) => {
            const { jobId, datasetId, current, total, filepath } = event.payload;
            const existing = this.activeJobs.get(jobId);
            this.activeJobs.set(jobId, {
                jobId,
                datasetId,
                label: existing?.label ?? 'BirdNET',
                current,
                total,
                currentFile: filepath ? (filepath.split('/').pop() ?? filepath) : '…',
            });
            this.render();
        });

        const unlistenDone = await listen<BirdnetDonePayload>(
            'dataset:birdnet-done',
            (event) => {
                const p = event.payload;
                const active = this.activeJobs.get(p.jobId);
                this.activeJobs.delete(p.jobId);

                this.doneJobs.unshift({
                    jobId: p.jobId,
                    datasetId: p.datasetId,
                    label: active?.label ?? 'BirdNET',
                    status: p.status,
                    processed: p.processed,
                    errors: p.errors,
                    doneAt: Date.now(),
                    errorMessage: p.errorMessage,
                });
                this.doneJobs = this.doneJobs.slice(0, MAX_HISTORY);
                this.render();
            },
        );

        this.unlistenProgress = unlistenProgress;
        this.unlistenDone = unlistenDone;
    }

    private render(): void {
        const hasActive = this.activeJobs.size > 0;
        const hasDone = this.doneJobs.length > 0;

        if (!hasActive && !hasDone) {
            this.container.innerHTML = '';
            return;
        }

        const activeHtml = Array.from(this.activeJobs.values())
            .map((job) => this.renderActive(job))
            .join('');

        const doneHtml = this.doneJobs
            .map((job) => this.renderDone(job))
            .join('');

        this.container.innerHTML = `
            <div class="job-monitor">
                ${hasActive ? `
                <div class="job-monitor__section">
                    <div class="job-monitor__section-label">Running</div>
                    ${activeHtml}
                </div>` : ''}
                ${hasDone ? `
                <div class="job-monitor__section">
                    <div class="job-monitor__section-label">
                        Recent
                        <button class="btn btn--ghost btn--xs" id="jobMonitorClear">Clear</button>
                    </div>
                    ${doneHtml}
                </div>` : ''}
            </div>
        `;

        this.container.querySelector('#jobMonitorClear')?.addEventListener('click', () => {
            this.doneJobs = [];
            this.render();
        });

        this.container.querySelectorAll('[data-open-dataset]').forEach((btn) => {
            btn.addEventListener('click', () => {
                const id = (btn as HTMLElement).dataset.openDataset!;
                this.onOpenDataset?.(id);
            });
        });
    }

    private renderActive(job: ActiveJob): string {
        const pct = job.total > 0 ? Math.round((job.current / job.total) * 100) : 0;
        return `
            <div class="job-row job-row--running">
                <div class="job-row__header">
                    <span class="job-row__label">${escapeHtml(job.label)}</span>
                    <span class="job-row__count">${job.current} / ${job.total}</span>
                </div>
                <div class="progress-bar">
                    <div class="progress-bar__fill" style="width:${pct}%"></div>
                </div>
                <div class="job-row__file">${escapeHtml(job.currentFile)}</div>
            </div>
        `;
    }

    private renderDone(job: DoneJob): string {
        const isOk = job.status === 'completed';
        const stateClass = isOk ? 'job-row--ok' : 'job-row--error';
        const icon = isOk ? '✓' : '✕';
        const summary = isOk
            ? `${job.processed} processed${job.errors > 0 ? `, ${job.errors} errors` : ''}`
            : (job.errorMessage ? job.errorMessage.slice(0, 80) : 'failed');
        const ago = formatAgo(job.doneAt);
        return `
            <div class="job-row ${stateClass}"
                 data-open-dataset="${escapeHtml(job.datasetId)}"
                 role="button"
                 tabindex="0"
                 title="Open dataset">
                <span class="job-row__icon">${icon}</span>
                <span class="job-row__label">${escapeHtml(job.label)}</span>
                <span class="job-row__summary">${escapeHtml(summary)}</span>
                <span class="job-row__ago">${ago}</span>
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

function formatAgo(ts: number): string {
    if (!ts) return '';
    const diff = Math.round((Date.now() - ts) / 1000);
    if (diff < 60) return `${diff}s ago`;
    if (diff < 3600) return `${Math.round(diff / 60)}m ago`;
    return `${Math.round(diff / 3600)}h ago`;
}
