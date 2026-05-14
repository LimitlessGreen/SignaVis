// ═══════════════════════════════════════════════════════════════════════
// ui/panels/ExportPanel.ts — Training data export + fine-tuning launcher
//
// Two tabs:
//   Export — configure label field, confidence threshold, split tag,
//             output directory, then run recording_export_training
//   Fine-tune — configure base model, epochs, learning rate,
//               output dir, then launch dataset_run_finetuning
// ═══════════════════════════════════════════════════════════════════════

import type { Dataset } from '../../domain/corpus/types.ts';
import { listen } from '@tauri-apps/api/event';
import { open as openDialog } from '@tauri-apps/plugin-dialog';

async function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
    const { invoke: ti } = await import('@tauri-apps/api/core');
    return ti<T>(cmd, args);
}

export interface ExportPanelOptions {
    container: HTMLElement;
    dataset: Dataset;
    onStatusMessage?: (msg: string) => void;
    onClose?: () => void;
}

export class ExportPanel {
    private readonly container: HTMLElement;
    private readonly dataset: Dataset;
    private readonly onStatusMessage: (msg: string) => void;
    private readonly onClose: (() => void) | undefined;
    private activeTab: 'export' | 'finetune' = 'export';

    constructor(opts: ExportPanelOptions) {
        this.container = opts.container;
        this.dataset = opts.dataset;
        this.onStatusMessage = opts.onStatusMessage ?? console.log;
        this.onClose = opts.onClose;
    }

    mount(): void {
        this.render();
        this.bindEvents();
    }

    private render(): void {
        const fields = this.dataset.fieldSchema
            .filter((f) => f.kind === 'sound_events')
            .map((f) => `<option value="${escapeHtml(f.name)}">${escapeHtml(f.name)}</option>`)
            .join('');

        const noFields = fields.length === 0
            ? '<option value="">— no sound_events fields —</option>'
            : '';

        this.container.innerHTML = `
            <div class="export-panel">
                <div class="export-panel__header">
                    <h3 class="export-panel__title">Export &amp; Fine-tune — ${escapeHtml(this.dataset.name)}</h3>
                    <button class="btn btn--ghost btn--icon" id="exportClose" title="Close">✕</button>
                </div>

                <div class="xc-sub-tabs">
                    <button class="xc-sub-tab ${this.activeTab === 'export' ? 'active' : ''}"
                        data-tab="export">Export training data</button>
                    <button class="xc-sub-tab ${this.activeTab === 'finetune' ? 'active' : ''}"
                        data-tab="finetune">Fine-tune BirdNET</button>
                </div>

                <div class="export-panel__body">
                    <!-- Export tab -->
                    <div id="tabExport" class="export-panel__tab-content"
                         style="${this.activeTab !== 'export' ? 'display:none' : ''}">
                        <div class="form-row">
                            <label class="form-label">Label field</label>
                            <select class="input" id="exportLabelField">
                                ${noFields}${fields}
                            </select>
                            <span class="form-hint">SoundEvents field to use as labels.</span>
                        </div>
                        <div class="form-row">
                            <label class="form-label">Minimum confidence</label>
                            <input class="input" id="exportMinConf" type="number"
                                value="0.8" min="0" max="1" step="0.05" />
                        </div>
                        <div class="form-row">
                            <label class="form-label">Split tag filter</label>
                            <select class="input" id="exportTagFilter">
                                <option value="">All recordings</option>
                                <option value="train">train</option>
                                <option value="val">val</option>
                                <option value="test">test</option>
                            </select>
                            <span class="form-hint">Only export recordings with this tag.</span>
                        </div>
                        <div class="form-row">
                            <label class="form-label">Output directory</label>
                            <div class="input-with-btn">
                                <input class="input" id="exportOutputDir" type="text"
                                    placeholder="/path/to/training_export" />
                                <button class="btn btn--ghost btn--sm" id="exportBrowseDir">Browse</button>
                            </div>
                        </div>
                        <div class="form-row form-row--inline">
                            <label>
                                <input type="checkbox" id="exportCopyAudio" checked />
                                Copy audio files (for audio-trimming script)
                            </label>
                        </div>
                        <div class="form-actions">
                            <button class="btn btn--primary" id="exportRunBtn">Export</button>
                        </div>
                        <div class="export-result" id="exportResult" style="display:none"></div>
                    </div>

                    <!-- Fine-tune tab -->
                    <div id="tabFinetune" class="export-panel__tab-content"
                         style="${this.activeTab !== 'finetune' ? 'display:none' : ''}">
                        <div class="form-row">
                            <label class="form-label">Training data directory</label>
                            <div class="input-with-btn">
                                <input class="input" id="ftTrainingDir" type="text"
                                    placeholder="/path/to/training_export" />
                                <button class="btn btn--ghost btn--sm" id="ftBrowseDir">Browse</button>
                            </div>
                            <span class="form-hint">Output directory from the Export step.</span>
                        </div>
                        <div class="form-row">
                            <label class="form-label">Base model version</label>
                            <input class="input" id="ftBaseModel" type="text" value="2.4" />
                        </div>
                        <div class="form-row">
                            <label class="form-label">Epochs</label>
                            <input class="input" id="ftEpochs" type="number" value="50" min="1" max="500" />
                        </div>
                        <div class="form-row">
                            <label class="form-label">Learning rate</label>
                            <input class="input" id="ftLr" type="number" value="0.001"
                                min="0.00001" max="0.1" step="0.0001" />
                        </div>
                        <div class="form-row">
                            <label class="form-label">Model output directory (optional)</label>
                            <input class="input" id="ftOutputDir" type="text"
                                placeholder="Default: training_dir/model_output" />
                        </div>
                        <div class="form-actions">
                            <button class="btn btn--primary" id="ftRunBtn">Start fine-tuning</button>
                        </div>
                        <div class="ft-log" id="ftLog" style="display:none">
                            <div class="ft-log__header">Training log</div>
                            <pre class="ft-log__content" id="ftLogContent"></pre>
                        </div>
                    </div>
                </div>
            </div>
        `;
    }

    private bindEvents(): void {
        this.container.querySelector('#exportClose')?.addEventListener('click', () => this.onClose?.());

        // Tab switching
        this.container.querySelectorAll<HTMLButtonElement>('[data-tab]').forEach((btn) => {
            btn.addEventListener('click', () => {
                this.activeTab = btn.dataset.tab as 'export' | 'finetune';
                this.render();
                this.bindEvents();
            });
        });

        // Export tab
        this.container.querySelector('#exportBrowseDir')?.addEventListener('click', async () => {
            const dir = await pickDirectory();
            if (dir) (this.container.querySelector('#exportOutputDir') as HTMLInputElement).value = dir;
        });

        this.container.querySelector('#exportRunBtn')?.addEventListener('click', () => this.runExport());

        // Fine-tune tab
        this.container.querySelector('#ftBrowseDir')?.addEventListener('click', async () => {
            const dir = await pickDirectory();
            if (dir) (this.container.querySelector('#ftTrainingDir') as HTMLInputElement).value = dir;
        });

        this.container.querySelector('#ftRunBtn')?.addEventListener('click', () => this.runFinetune());
    }

    private async runExport(): Promise<void> {
        const labelField = (this.container.querySelector('#exportLabelField') as HTMLSelectElement).value;
        const minConf = parseFloat((this.container.querySelector('#exportMinConf') as HTMLInputElement).value);
        const tagFilter = (this.container.querySelector('#exportTagFilter') as HTMLSelectElement).value || undefined;
        const outputDir = (this.container.querySelector('#exportOutputDir') as HTMLInputElement).value.trim();
        const copyAudio = (this.container.querySelector('#exportCopyAudio') as HTMLInputElement).checked;

        if (!labelField) { this.onStatusMessage('Select a label field first.'); return; }
        if (!outputDir) { this.onStatusMessage('Specify an output directory.'); return; }

        const btn = this.container.querySelector('#exportRunBtn') as HTMLButtonElement;
        const resultEl = this.container.querySelector('#exportResult') as HTMLElement;
        btn.disabled = true;
        btn.textContent = 'Exporting…';
        resultEl.style.display = 'none';

        try {
            const result = await invoke<{
                exported: number; skipped: number; errors: number; outputDir: string;
            }>('recording_export_training', {
                args: {
                    datasetId: this.dataset.id,
                    labelField,
                    minConfidence: minConf,
                    tagFilter,
                    outputDir,
                    copyAudio,
                },
            });

            resultEl.style.display = '';
            resultEl.innerHTML = `
                <div class="export-result__ok">
                    ✓ ${result.exported} segments exported,
                    ${result.skipped} skipped,
                    ${result.errors} errors.
                    <br>Output: <code>${escapeHtml(result.outputDir)}</code>
                </div>
            `;
            this.onStatusMessage(`Export complete: ${result.exported} segments.`);

            // Pre-fill the fine-tune tab with the output dir
            const ftInput = this.container.querySelector('#ftTrainingDir') as HTMLInputElement | null;
            if (ftInput) ftInput.value = result.outputDir;
        } catch (e) {
            this.onStatusMessage(`Export error: ${e}`);
        } finally {
            btn.disabled = false;
            btn.textContent = 'Export';
        }
    }

    private async runFinetune(): Promise<void> {
        const trainingDir = (this.container.querySelector('#ftTrainingDir') as HTMLInputElement).value.trim();
        const baseModel = (this.container.querySelector('#ftBaseModel') as HTMLInputElement).value.trim();
        const epochs = parseInt((this.container.querySelector('#ftEpochs') as HTMLInputElement).value);
        const lr = parseFloat((this.container.querySelector('#ftLr') as HTMLInputElement).value);
        const outputDir = (this.container.querySelector('#ftOutputDir') as HTMLInputElement).value.trim() || undefined;

        if (!trainingDir) { this.onStatusMessage('Specify the training data directory.'); return; }

        const btn = this.container.querySelector('#ftRunBtn') as HTMLButtonElement;
        const logEl = this.container.querySelector('#ftLog') as HTMLElement;
        const logContent = this.container.querySelector('#ftLogContent') as HTMLElement;
        btn.disabled = true;
        btn.textContent = 'Running…';
        logEl.style.display = '';
        logContent.textContent = 'Starting training…\n';

        let jobId = '';

        const unlistenProgress = await listen<{ jobId: string; line: string }>(
            'dataset:finetune-progress',
            (e) => {
                if (jobId && e.payload.jobId !== jobId) return;
                logContent.textContent += e.payload.line + '\n';
                logContent.scrollTop = logContent.scrollHeight;
            },
        );

        const unlistenDone = await listen<{ jobId: string; status: string; errorMessage?: string }>(
            'dataset:finetune-done',
            (e) => {
                if (jobId && e.payload.jobId !== jobId) return;
                unlistenProgress();
                unlistenDone();
                btn.disabled = false;
                btn.textContent = 'Start fine-tuning';
                if (e.payload.status === 'completed') {
                    this.onStatusMessage('Fine-tuning complete.');
                    logContent.textContent += '\n✓ Training complete.\n';
                } else {
                    this.onStatusMessage(`Fine-tuning failed: ${e.payload.errorMessage ?? 'unknown'}`);
                    logContent.textContent += `\n✕ Failed: ${e.payload.errorMessage ?? 'unknown'}\n`;
                }
            },
        );

        try {
            const summary = await invoke<{ jobId: string }>('dataset_run_finetuning', {
                args: {
                    datasetId: this.dataset.id,
                    trainingDataDir: trainingDir,
                    baseModel,
                    epochs,
                    learningRate: lr,
                    outputDir,
                },
            });
            jobId = summary.jobId;
            this.onStatusMessage(`Fine-tuning started (job ${jobId.slice(0, 8)}).`);
        } catch (e) {
            unlistenProgress();
            unlistenDone();
            btn.disabled = false;
            btn.textContent = 'Start fine-tuning';
            this.onStatusMessage(`Fine-tuning error: ${e}`);
        }
    }
}

async function pickDirectory(): Promise<string | null> {
    try {
        const result = await openDialog({ directory: true, multiple: false });
        return typeof result === 'string' ? result : null;
    } catch {
        return null;
    }
}

function escapeHtml(s: string): string {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
