// ═══════════════════════════════════════════════════════════════════════
// ui/panels/CorpusBrowserPanel.ts — Dataset-Verwaltungsansicht
//
// Zeigt alle Datasets, erlaubt Erstellen, Löschen und Auswählen.
// ═══════════════════════════════════════════════════════════════════════

import type { Dataset } from '../../domain/corpus/types.ts';
import {
    datasetCreate,
    datasetList,
    datasetDelete,
} from '../../infrastructure/tauri/TauriCorpusAdapter.ts';

export interface DatasetBrowserOptions {
    container: HTMLElement;
    onDatasetSelect: (dataset: Dataset) => void;
    onStatusMessage?: (msg: string) => void;
}

export class DatasetBrowserPanel {
    private readonly container: HTMLElement;
    private readonly onDatasetSelect: (dataset: Dataset) => void;
    private readonly onStatusMessage: (msg: string) => void;
    private datasets: Dataset[] = [];

    constructor(opts: DatasetBrowserOptions) {
        this.container = opts.container;
        this.onDatasetSelect = opts.onDatasetSelect;
        this.onStatusMessage = opts.onStatusMessage ?? ((m) => console.log(m));
    }

    async mount(): Promise<void> {
        this.container.innerHTML = this.renderShell();
        this.bindEvents();
        await this.refresh();
    }

    private renderShell(): string {
        return `
            <div class="dataset-browser">
                <div class="dataset-browser__header">
                    <h2 class="dataset-browser__title">Datasets</h2>
                    <button class="btn btn--primary" id="datasetNewBtn">+ Neues Dataset</button>
                </div>
                <div class="dataset-browser__create-form" id="datasetCreateForm" style="display:none">
                    <input
                        type="text"
                        class="input"
                        id="datasetNameInput"
                        placeholder="Name des Datasets…"
                        maxlength="120"
                    />
                    <input
                        type="text"
                        class="input"
                        id="datasetDescInput"
                        placeholder="Beschreibung (optional)"
                        maxlength="300"
                    />
                    <div class="dataset-browser__form-actions">
                        <button class="btn btn--primary" id="datasetCreateConfirm">Erstellen</button>
                        <button class="btn btn--ghost" id="datasetCreateCancel">Abbrechen</button>
                    </div>
                </div>
                <div class="dataset-browser__list" id="datasetList">
                    <div class="dataset-browser__empty">Lade…</div>
                </div>
            </div>
        `;
    }

    private bindEvents(): void {
        const newBtn = this.container.querySelector('#datasetNewBtn') as HTMLButtonElement;
        const createForm = this.container.querySelector('#datasetCreateForm') as HTMLElement;
        const nameInput = this.container.querySelector('#datasetNameInput') as HTMLInputElement;
        const descInput = this.container.querySelector('#datasetDescInput') as HTMLInputElement;
        const confirmBtn = this.container.querySelector('#datasetCreateConfirm') as HTMLButtonElement;
        const cancelBtn = this.container.querySelector('#datasetCreateCancel') as HTMLButtonElement;

        newBtn.addEventListener('click', () => {
            createForm.style.display = 'block';
            nameInput.focus();
        });

        cancelBtn.addEventListener('click', () => {
            createForm.style.display = 'none';
            nameInput.value = '';
            descInput.value = '';
        });

        confirmBtn.addEventListener('click', () => this.handleCreate(nameInput, descInput, createForm));

        nameInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') this.handleCreate(nameInput, descInput, createForm);
            if (e.key === 'Escape') cancelBtn.click();
        });
    }

    private async handleCreate(
        nameInput: HTMLInputElement,
        descInput: HTMLInputElement,
        form: HTMLElement,
    ): Promise<void> {
        const name = nameInput.value.trim();
        if (!name) {
            nameInput.focus();
            return;
        }
        const desc = descInput.value.trim() || undefined;
        try {
            const dataset = await datasetCreate(name, desc);
            this.onStatusMessage(`Dataset "${dataset.name}" erstellt.`);
            nameInput.value = '';
            descInput.value = '';
            form.style.display = 'none';
            await this.refresh();
        } catch (e) {
            this.onStatusMessage(`Fehler beim Erstellen: ${e}`);
        }
    }

    async refresh(): Promise<void> {
        try {
            this.datasets = await datasetList();
        } catch (e) {
            this.onStatusMessage(`Fehler beim Laden der Datasets: ${e}`);
            this.datasets = [];
        }
        this.renderList();
    }

    private renderList(): void {
        const listEl = this.container.querySelector('#datasetList')!;
        if (this.datasets.length === 0) {
            listEl.innerHTML = `
                <div class="dataset-browser__empty">
                    Noch keine Datasets vorhanden.<br>
                    Erstelle ein neues Dataset und importiere Aufnahmen.
                </div>
            `;
            return;
        }

        listEl.innerHTML = this.datasets
            .sort((a, b) => b.updatedAt - a.updatedAt)
            .map((c) => this.renderDatasetCard(c))
            .join('');

        // Events für Cards binden
        listEl.querySelectorAll('[data-open-dataset]').forEach((btn) => {
            btn.addEventListener('click', () => {
                const id = (btn as HTMLElement).dataset.openDataset!;
                const dataset = this.datasets.find((c) => c.id === id);
                if (dataset) this.onDatasetSelect(dataset);
            });
        });

        listEl.querySelectorAll('[data-delete-dataset]').forEach((btn) => {
            btn.addEventListener('click', async (e) => {
                e.stopPropagation();
                const id = (btn as HTMLElement).dataset.deleteDataset!;
                const dataset = this.datasets.find((c) => c.id === id);
                if (!dataset) return;
                if (!confirm(`Dataset "${dataset.name}" und alle Aufnahmen löschen?`)) return;
                try {
                    await datasetDelete(id);
                    this.onStatusMessage(`Dataset "${dataset.name}" gelöscht.`);
                    await this.refresh();
                } catch (e) {
                    this.onStatusMessage(`Fehler: ${e}`);
                }
            });
        });
    }

    private renderDatasetCard(dataset: Dataset): string {
        const date = new Date(dataset.updatedAt).toLocaleDateString(undefined, {
            dateStyle: 'medium',
        });
        const count = dataset.recordingCount.toLocaleString();
        const desc = dataset.description
            ? `<p class="dataset-card__desc">${escapeHtml(dataset.description)}</p>`
            : '';
        return `
            <div class="dataset-card" data-dataset-id="${escapeHtml(dataset.id)}">
                <div class="dataset-card__body" data-open-dataset="${escapeHtml(dataset.id)}" role="button" tabindex="0">
                    <div class="dataset-card__icon">🎙</div>
                    <div class="dataset-card__info">
                        <div class="dataset-card__name">${escapeHtml(dataset.name)}</div>
                        ${desc}
                        <div class="dataset-card__meta">
                            <span class="badge badge--neutral">${count} Aufnahmen</span>
                            <span class="dataset-card__date">Zuletzt: ${date}</span>
                        </div>
                    </div>
                </div>
                <button
                    class="btn btn--ghost btn--icon dataset-card__delete"
                    data-delete-dataset="${escapeHtml(dataset.id)}"
                    title="Dataset löschen"
                >✕</button>
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
