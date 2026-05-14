// ═══════════════════════════════════════════════════════════════════════
// ui/panels/JobMonitorPanel.ts — Topbar job monitor chip + dropdown
//
// Renders a compact chip in the topbar.  When jobs are running a spinner
// and count appear.  Clicking opens a dropdown with job details.
//
// Subscribes to Tauri events:
//   "dataset:birdnet-progress" — updates active job progress
//   "dataset:birdnet-done"     — moves job to history
// ═══════════════════════════════════════════════════════════════════════

import {
    datasetListRuns,
    type AnalysisRunRecord,
    type BirdnetDonePayload,
} from '../../infrastructure/tauri/TauriCorpusAdapter.ts';

export interface JobMonitorOptions {
    container: HTMLElement;
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

const MAX_HISTORY = 8;

export class JobMonitorPanel {
    private readonly container: HTMLElement;
    private readonly onOpenDataset: ((id: string) => void) | undefined;

    private activeJobs = new Map<string, ActiveJob>();
    private doneJobs: DoneJob[] = [];
    private isOpen = false;

    private unlistenProgress: (() => void) | null = null;
    private unlistenDone: (() => void) | null = null;

    constructor(opts: JobMonitorOptions) {
        this.container = opts.container;
        this.onOpenDataset = opts.onOpenDataset;
    }

    async mount(): Promise<void> {
        this.renderChip();
        await this.subscribeEvents();
    }

    dispose(): void {
        this.unlistenProgress?.();
        this.unlistenDone?.();
    }

    async loadRunsForDataset(datasetId: string): Promise<void> {
        try {
            const runs = await datasetListRuns(datasetId);
            for (const run of runs) {
                if ((run.status === 'completed' || run.status === 'failed')
                    && !this.doneJobs.some((d) => d.jobId === run.key)) {
                    this.doneJobs.unshift({
                        jobId: run.key,
                        datasetId,
                        label: labelForRun(run),
                        status: run.status as 'completed' | 'failed',
                        processed: run.processed ?? 0,
                        errors: run.errors ?? 0,
                        doneAt: run.completedAt ?? 0,
                        errorMessage: run.errorMessage,
                    });
                }
            }
            this.doneJobs = this.doneJobs.slice(0, MAX_HISTORY);
            this.renderChip();
        } catch { /* non-critical */ }
    }

    // ── Chip ──────────────────────────────────────────────────────────

    private renderChip(): void {
        const nRunning = this.activeJobs.size;
        const hasAny   = nRunning > 0 || this.doneJobs.length > 0;

        if (!hasAny) {
            this.container.innerHTML = '';
            return;
        }

        const chipClass = nRunning > 0 ? 'job-monitor-btn--running' : '';
        const label = nRunning > 0
            ? `${nRunning} running`
            : `${this.doneJobs.length} recent`;

        this.container.innerHTML = `
            <div class="job-monitor-chip">
                <button class="job-monitor-btn ${chipClass}" id="jmChipBtn">
                    ${nRunning > 0 ? '<span class="job-monitor-btn__spinner"></span>' : '●'}
                    ${escapeHtml(label)}
                </button>
                <div class="job-monitor-panel" id="jmPanel" hidden></div>
            </div>
        `;

        this.container.querySelector('#jmChipBtn')?.addEventListener('click', (e) => {
            e.stopPropagation();
            this.togglePanel();
        });

        document.addEventListener('click', () => this.closePanel());

        if (this.isOpen) this.openPanel();
    }

    private togglePanel(): void {
        this.isOpen ? this.closePanel() : this.openPanel();
    }

    private openPanel(): void {
        this.isOpen = true;
        const panel = this.container.querySelector<HTMLElement>('#jmPanel');
        if (!panel) return;
        panel.hidden = false;
        panel.innerHTML = this.renderPanelContent();
        this.bindPanelEvents(panel);
    }

    private closePanel(): void {
        this.isOpen = false;
        const panel = this.container.querySelector<HTMLElement>('#jmPanel');
        if (panel) panel.hidden = true;
    }

    // ── Panel content ─────────────────────────────────────────────────

    private renderPanelContent(): string {
        const activeSections = Array.from(this.activeJobs.values())
            .map((job) => this.renderActiveJob(job))
            .join('');

        const doneSections = this.doneJobs
            .map((job) => this.renderDoneJob(job))
            .join('');

        const hasActive = this.activeJobs.size > 0;
        const hasDone   = this.doneJobs.length > 0;

        return `
            <div class="job-monitor-panel__header">
                Jobs
                ${hasDone ? `<button class="btn btn--ghost btn--xs" id="jmClearBtn">Clear</button>` : ''}
            </div>
            <div class="job-monitor-panel__body">
                ${hasActive ? `
                    <div class="jm-section">
                        <div class="jm-section-label">Running</div>
                        ${activeSections}
                    </div>
                ` : ''}
                ${hasDone ? `
                    <div class="jm-section">
                        <div class="jm-section-label">Recent</div>
                        ${doneSections}
                    </div>
                ` : ''}
                ${!hasActive && !hasDone ? '<div class="job-monitor-panel__empty">No jobs yet.</div>' : ''}
            </div>
        `;
    }

    private renderActiveJob(job: ActiveJob): string {
        const pct = job.total > 0 ? Math.round((job.current / job.total) * 100) : 0;
        return `
            <div class="jm-job jm-job--running">
                <div class="jm-job__header">
                    <span class="jm-job__label">${escapeHtml(job.label)}</span>
                    <span class="jm-job__meta">${job.current} / ${job.total}</span>
                </div>
                <div class="progress-bar" style="height:3px">
                    <div class="progress-bar__fill" style="width:${pct}%"></div>
                </div>
                <div class="jm-job__file">${escapeHtml(job.currentFile)}</div>
            </div>
        `;
    }

    private renderDoneJob(job: DoneJob): string {
        const isOk  = job.status === 'completed';
        const icon  = isOk ? '✓' : '✕';
        const cls   = isOk ? 'jm-job--ok' : 'jm-job--error';
        const meta  = isOk
            ? `${job.processed} processed${job.errors > 0 ? `, ${job.errors} err` : ''}`
            : (job.errorMessage?.slice(0, 40) ?? 'failed');
        const ago   = formatAgo(job.doneAt);
        return `
            <div class="jm-job jm-job--clickable ${cls}"
                 data-open-dataset="${escapeHtml(job.datasetId)}"
                 title="Open dataset">
                <span class="jm-job__icon">${icon}</span>
                <span class="jm-job__label">${escapeHtml(job.label)}</span>
                <span class="jm-job__meta">${escapeHtml(meta)} · ${ago}</span>
            </div>
        `;
    }

    private bindPanelEvents(panel: HTMLElement): void {
        panel.querySelector('#jmClearBtn')?.addEventListener('click', (e) => {
            e.stopPropagation();
            this.doneJobs = [];
            this.renderChip();
        });

        panel.querySelectorAll('[data-open-dataset]').forEach((el) => {
            el.addEventListener('click', (e) => {
                e.stopPropagation();
                this.onOpenDataset?.((el as HTMLElement).dataset.openDataset!);
                this.closePanel();
            });
        });

        // Prevent clicks inside panel from closing it
        panel.addEventListener('click', (e) => e.stopPropagation());
    }

    // ── Event subscriptions ───────────────────────────────────────────

    private async subscribeEvents(): Promise<void> {
        const { listen } = await import('@tauri-apps/api/event');

        const unlistenProgress = await listen<{
            jobId: string; datasetId: string;
            current: number; total: number; filepath: string | null;
        }>('dataset:birdnet-progress', (ev) => {
            const { jobId, datasetId, current, total, filepath } = ev.payload;
            const existing = this.activeJobs.get(jobId);
            this.activeJobs.set(jobId, {
                jobId, datasetId,
                label: existing?.label ?? 'BirdNET',
                current, total,
                currentFile: filepath ? (filepath.split('/').pop() ?? filepath) : '…',
            });
            this.renderChip();
            if (this.isOpen) this.openPanel();
        });

        const unlistenDone = await listen<BirdnetDonePayload>(
            'dataset:birdnet-done',
            (ev) => {
                const p = ev.payload;
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
                this.renderChip();
                if (this.isOpen) this.openPanel();
            },
        );

        this.unlistenProgress = unlistenProgress;
        this.unlistenDone = unlistenDone;
    }
}

function labelForRun(run: AnalysisRunRecord): string {
    const model   = (run.config.model as string) ?? 'analysis';
    const version = (run.config.version as string) ?? '';
    const field   = (run.config.outputField as string) ?? '';
    return `${model}${version ? ` v${version}` : ''}${field ? ` → ${field}` : ''}`;
}

function escapeHtml(s: string): string {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function formatAgo(ts: number): string {
    if (!ts) return '';
    const s = Math.round((Date.now() - ts) / 1000);
    if (s < 60) return `${s}s ago`;
    if (s < 3600) return `${Math.round(s / 60)}m ago`;
    return `${Math.round(s / 3600)}h ago`;
}
