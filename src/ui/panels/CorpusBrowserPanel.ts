// ═══════════════════════════════════════════════════════════════════════
// ui/panels/CorpusBrowserPanel.ts — Corpus-Verwaltungsansicht
//
// Zeigt alle Corpora, erlaubt Erstellen, Löschen und Auswählen.
// ═══════════════════════════════════════════════════════════════════════

import type { Corpus } from '../../domain/corpus/types.ts';
import {
    corpusCreate,
    corpusList,
    corpusDelete,
} from '../../infrastructure/tauri/TauriCorpusAdapter.ts';

export interface CorpusBrowserOptions {
    container: HTMLElement;
    onCorpusSelect: (corpus: Corpus) => void;
    onStatusMessage?: (msg: string) => void;
}

export class CorpusBrowserPanel {
    private readonly container: HTMLElement;
    private readonly onCorpusSelect: (corpus: Corpus) => void;
    private readonly onStatusMessage: (msg: string) => void;
    private corpora: Corpus[] = [];

    constructor(opts: CorpusBrowserOptions) {
        this.container = opts.container;
        this.onCorpusSelect = opts.onCorpusSelect;
        this.onStatusMessage = opts.onStatusMessage ?? ((m) => console.log(m));
    }

    async mount(): Promise<void> {
        this.container.innerHTML = this.renderShell();
        this.bindEvents();
        await this.refresh();
    }

    private renderShell(): string {
        return `
            <div class="corpus-browser">
                <div class="corpus-browser__header">
                    <h2 class="corpus-browser__title">Corpora</h2>
                    <button class="btn btn--primary" id="corpusNewBtn">+ Neuer Corpus</button>
                </div>
                <div class="corpus-browser__create-form" id="corpusCreateForm" style="display:none">
                    <input
                        type="text"
                        class="input"
                        id="corpusNameInput"
                        placeholder="Name des Corpus…"
                        maxlength="120"
                    />
                    <input
                        type="text"
                        class="input"
                        id="corpusDescInput"
                        placeholder="Beschreibung (optional)"
                        maxlength="300"
                    />
                    <div class="corpus-browser__form-actions">
                        <button class="btn btn--primary" id="corpusCreateConfirm">Erstellen</button>
                        <button class="btn btn--ghost" id="corpusCreateCancel">Abbrechen</button>
                    </div>
                </div>
                <div class="corpus-browser__list" id="corpusList">
                    <div class="corpus-browser__empty">Lade…</div>
                </div>
            </div>
        `;
    }

    private bindEvents(): void {
        const newBtn = this.container.querySelector('#corpusNewBtn') as HTMLButtonElement;
        const createForm = this.container.querySelector('#corpusCreateForm') as HTMLElement;
        const nameInput = this.container.querySelector('#corpusNameInput') as HTMLInputElement;
        const descInput = this.container.querySelector('#corpusDescInput') as HTMLInputElement;
        const confirmBtn = this.container.querySelector('#corpusCreateConfirm') as HTMLButtonElement;
        const cancelBtn = this.container.querySelector('#corpusCreateCancel') as HTMLButtonElement;

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
            const corpus = await corpusCreate(name, desc);
            this.onStatusMessage(`Corpus "${corpus.name}" erstellt.`);
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
            this.corpora = await corpusList();
        } catch (e) {
            this.onStatusMessage(`Fehler beim Laden der Corpora: ${e}`);
            this.corpora = [];
        }
        this.renderList();
    }

    private renderList(): void {
        const listEl = this.container.querySelector('#corpusList')!;
        if (this.corpora.length === 0) {
            listEl.innerHTML = `
                <div class="corpus-browser__empty">
                    Noch keine Corpora vorhanden.<br>
                    Erstelle einen neuen Corpus und importiere Aufnahmen.
                </div>
            `;
            return;
        }

        listEl.innerHTML = this.corpora
            .sort((a, b) => b.updatedAt - a.updatedAt)
            .map((c) => this.renderCorpusCard(c))
            .join('');

        // Events für Cards binden
        listEl.querySelectorAll('[data-open-corpus]').forEach((btn) => {
            btn.addEventListener('click', () => {
                const id = (btn as HTMLElement).dataset.openCorpus!;
                const corpus = this.corpora.find((c) => c.id === id);
                if (corpus) this.onCorpusSelect(corpus);
            });
        });

        listEl.querySelectorAll('[data-delete-corpus]').forEach((btn) => {
            btn.addEventListener('click', async (e) => {
                e.stopPropagation();
                const id = (btn as HTMLElement).dataset.deleteCorpus!;
                const corpus = this.corpora.find((c) => c.id === id);
                if (!corpus) return;
                if (!confirm(`Corpus "${corpus.name}" und alle Aufnahmen löschen?`)) return;
                try {
                    await corpusDelete(id);
                    this.onStatusMessage(`Corpus "${corpus.name}" gelöscht.`);
                    await this.refresh();
                } catch (e) {
                    this.onStatusMessage(`Fehler: ${e}`);
                }
            });
        });
    }

    private renderCorpusCard(corpus: Corpus): string {
        const date = new Date(corpus.updatedAt).toLocaleDateString(undefined, {
            dateStyle: 'medium',
        });
        const count = corpus.recordingCount.toLocaleString();
        const desc = corpus.description
            ? `<p class="corpus-card__desc">${escapeHtml(corpus.description)}</p>`
            : '';
        return `
            <div class="corpus-card" data-corpus-id="${escapeHtml(corpus.id)}">
                <div class="corpus-card__body" data-open-corpus="${escapeHtml(corpus.id)}" role="button" tabindex="0">
                    <div class="corpus-card__icon">🎙</div>
                    <div class="corpus-card__info">
                        <div class="corpus-card__name">${escapeHtml(corpus.name)}</div>
                        ${desc}
                        <div class="corpus-card__meta">
                            <span class="badge badge--neutral">${count} Aufnahmen</span>
                            <span class="corpus-card__date">Zuletzt: ${date}</span>
                        </div>
                    </div>
                </div>
                <button
                    class="btn btn--ghost btn--icon corpus-card__delete"
                    data-delete-corpus="${escapeHtml(corpus.id)}"
                    title="Corpus löschen"
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
