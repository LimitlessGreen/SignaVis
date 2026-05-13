// ═══════════════════════════════════════════════════════════════════════
// ui/panels/ImportWizardPanel.ts — Import-Assistent für Ordner-Import
//
// Schritte:
//   1. Quelle wählen (Ordner)
//   2. Ordnerstruktur-Muster definieren (Live-Vorschau)
//   3. Import starten + Fortschritt
// ═══════════════════════════════════════════════════════════════════════

import type { Corpus } from '../../domain/corpus/types.ts';
import {
    recordingImportFolder,
    type ImportResult,
} from '../../infrastructure/tauri/TauriCorpusAdapter.ts';

export interface ImportWizardOptions {
    container: HTMLElement;
    corpus: Corpus;
    onDone: (result: ImportResult) => void;
    onCancel: () => void;
    onStatusMessage?: (msg: string) => void;
    /** Tauri-Dialog für Ordnerauswahl (nur im Desktop-Kontext). */
    openFolderDialog?: () => Promise<string | null>;
}

type WizardStep = 'source' | 'pattern' | 'running' | 'done';

export class ImportWizardPanel {
    private readonly container: HTMLElement;
    private readonly corpus: Corpus;
    private readonly onDone: (result: ImportResult) => void;
    private readonly onCancel: () => void;
    private readonly onStatusMessage: (msg: string) => void;
    private readonly openFolderDialog: (() => Promise<string | null>) | undefined;

    private step: WizardStep = 'source';
    private folderPath = '';
    private pathPattern = '';
    private lastResult: ImportResult | null = null;

    constructor(opts: ImportWizardOptions) {
        this.container = opts.container;
        this.corpus = opts.corpus;
        this.onDone = opts.onDone;
        this.onCancel = opts.onCancel;
        this.onStatusMessage = opts.onStatusMessage ?? ((m) => console.log(m));
        this.openFolderDialog = opts.openFolderDialog;
    }

    mount(): void {
        this.render();
    }

    private render(): void {
        this.container.innerHTML = `
            <div class="import-wizard">
                <div class="import-wizard__header">
                    <h2 class="import-wizard__title">Aufnahmen importieren</h2>
                    <div class="import-wizard__subtitle">in Corpus: <strong>${escapeHtml(this.corpus.name)}</strong></div>
                </div>
                <div class="import-wizard__steps">
                    ${this.renderStepIndicator()}
                </div>
                <div class="import-wizard__body" id="wizardBody">
                    ${this.renderCurrentStep()}
                </div>
                <div class="import-wizard__footer" id="wizardFooter">
                    ${this.renderFooter()}
                </div>
            </div>
        `;
        this.bindEvents();
    }

    private renderStepIndicator(): string {
        const steps = [
            { key: 'source', label: '1. Quelle' },
            { key: 'pattern', label: '2. Muster' },
            { key: 'running', label: '3. Import' },
        ];
        return `
            <div class="wizard-steps">
                ${steps
                    .map((s) => {
                        const isActive = s.key === this.step;
                        const isDone =
                            (s.key === 'source' && ['pattern', 'running', 'done'].includes(this.step)) ||
                            (s.key === 'pattern' && ['running', 'done'].includes(this.step));
                        return `
                            <div class="wizard-step ${isActive ? 'wizard-step--active' : ''} ${isDone ? 'wizard-step--done' : ''}">
                                ${s.label}
                            </div>
                        `;
                    })
                    .join('<div class="wizard-step-sep">→</div>')}
            </div>
        `;
    }

    private renderCurrentStep(): string {
        switch (this.step) {
            case 'source':
                return this.renderSourceStep();
            case 'pattern':
                return this.renderPatternStep();
            case 'running':
                return this.renderRunningStep();
            case 'done':
                return this.renderDoneStep();
        }
    }

    private renderSourceStep(): string {
        return `
            <div class="wizard-step-content">
                <p class="wizard-hint">Wähle den Ordner, der die Audiodateien enthält. Der Ordner wird rekursiv durchsucht.</p>
                <div class="wizard-folder-row">
                    <input
                        type="text"
                        class="input"
                        id="folderPathInput"
                        placeholder="/pfad/zum/ordner"
                        value="${escapeHtml(this.folderPath)}"
                    />
                    ${this.openFolderDialog ? `<button class="btn btn--secondary" id="browseFolderBtn">Durchsuchen…</button>` : ''}
                </div>
                <p class="wizard-hint wizard-hint--sm">
                    Unterstützte Formate: WAV, FLAC, MP3, OGG, OPUS, AAC, M4A, AIFF
                </p>
            </div>
        `;
    }

    private renderPatternStep(): string {
        const exampleFolder = this.folderPath.split('/').pop() ?? 'ordner';
        return `
            <div class="wizard-step-content">
                <p class="wizard-hint">
                    Ordner: <code>${escapeHtml(this.folderPath)}</code>
                </p>
                <p class="wizard-hint">
                    Definiere ein Muster für die Unterordner-Struktur um Metadaten automatisch zu extrahieren.
                    Platzhalter <code>{feldname}</code> werden zu Feldern auf der Aufnahme.
                </p>

                <div class="wizard-pattern-row">
                    <label class="label" for="patternInput">Muster (optional)</label>
                    <input
                        type="text"
                        class="input"
                        id="patternInput"
                        placeholder="{recorder_id}/{site}/{week}/"
                        value="${escapeHtml(this.pathPattern)}"
                    />
                </div>

                <div class="wizard-pattern-preview" id="patternPreview">
                    ${this.renderPatternPreview(this.pathPattern)}
                </div>

                <div class="wizard-pattern-examples">
                    <p class="wizard-hint wizard-hint--sm">Beispiel-Muster:</p>
                    <ul class="wizard-examples-list">
                        <li><code>{recorder_id}/{site}/{week}/</code> → Gerät, Standort, Woche</li>
                        <li><code>{year}/{month}/{day}/</code> → Datum-Hierarchie</li>
                        <li><code>{species}/{quality}/</code> → Art, Qualität</li>
                        <li>(leer lassen) → nur Dateipfad importieren</li>
                    </ul>
                </div>
            </div>
        `;
    }

    private renderPatternPreview(pattern: string): string {
        if (!pattern.trim()) {
            return `<div class="pattern-preview__msg">Kein Muster — nur Dateipfade werden importiert.</div>`;
        }
        const tokens = pattern
            .split('/')
            .filter((p) => p)
            .map((p) => {
                const m = p.match(/\{(\w+)\}/);
                return m ? `<span class="pattern-token pattern-token--field">{${escapeHtml(m[1])}}</span>` : `<span class="pattern-token">${escapeHtml(p)}</span>`;
            })
            .join(' / ');
        const fields = [...pattern.matchAll(/\{(\w+)\}/g)].map((m) => m[1]);
        const fieldList = fields.length > 0
            ? `<div class="pattern-preview__fields">Extrahierte Felder: ${fields.map((f) => `<code>${escapeHtml(f)}</code>`).join(', ')}</div>`
            : '';
        return `
            <div class="pattern-preview__tokens">Unterordner-Struktur: ${tokens}</div>
            ${fieldList}
        `;
    }

    private renderRunningStep(): string {
        return `
            <div class="wizard-step-content wizard-step-content--center">
                <div class="wizard-spinner"></div>
                <p id="importProgress" class="wizard-hint">Importiere…</p>
            </div>
        `;
    }

    private renderDoneStep(): string {
        if (!this.lastResult) return '';
        const r = this.lastResult;
        const hasErrors = r.errors > 0;
        return `
            <div class="wizard-step-content">
                <div class="wizard-done-icon">${hasErrors ? '⚠️' : '✅'}</div>
                <h3 class="wizard-done-title">${hasErrors ? 'Import abgeschlossen (mit Fehlern)' : 'Import erfolgreich'}</h3>
                <div class="wizard-done-stats">
                    <div class="wizard-stat">
                        <span class="wizard-stat__val">${r.imported.toLocaleString()}</span>
                        <span class="wizard-stat__label">importiert</span>
                    </div>
                    <div class="wizard-stat">
                        <span class="wizard-stat__val">${r.skipped.toLocaleString()}</span>
                        <span class="wizard-stat__label">übersprungen (Duplikate)</span>
                    </div>
                    ${r.errors > 0 ? `
                    <div class="wizard-stat wizard-stat--danger">
                        <span class="wizard-stat__val">${r.errors.toLocaleString()}</span>
                        <span class="wizard-stat__label">Fehler</span>
                    </div>` : ''}
                </div>
                <p class="wizard-hint wizard-hint--sm">Dauer: ${(r.durationMs / 1000).toFixed(1)}s</p>
                ${r.errorMessages.length > 0 ? `
                <details class="wizard-errors">
                    <summary>Fehlermeldungen (${r.errorMessages.length})</summary>
                    <ul>${r.errorMessages.slice(0, 20).map((m) => `<li>${escapeHtml(m)}</li>`).join('')}</ul>
                </details>` : ''}
            </div>
        `;
    }

    private renderFooter(): string {
        switch (this.step) {
            case 'source':
                return `
                    <button class="btn btn--ghost" id="wizardCancel">Abbrechen</button>
                    <button class="btn btn--primary" id="wizardNext">Weiter →</button>
                `;
            case 'pattern':
                return `
                    <button class="btn btn--ghost" id="wizardBack">← Zurück</button>
                    <button class="btn btn--primary" id="wizardStartImport">Import starten</button>
                `;
            case 'running':
                return `<button class="btn btn--ghost" disabled>Importiere…</button>`;
            case 'done':
                return `<button class="btn btn--primary" id="wizardFinish">Fertig</button>`;
        }
    }

    private bindEvents(): void {
        const body = this.container.querySelector('#wizardBody')!;
        const footer = this.container.querySelector('#wizardFooter')!;

        const on = (id: string, handler: () => void) => {
            this.container.querySelector(`#${id}`)?.addEventListener('click', handler);
        };

        on('wizardCancel', () => this.onCancel());
        on('wizardBack', () => { this.step = 'source'; this.render(); });
        on('wizardFinish', () => {
            if (this.lastResult) this.onDone(this.lastResult);
        });

        on('browseFolderBtn', async () => {
            const path = await this.openFolderDialog?.();
            if (path) {
                this.folderPath = path;
                const input = this.container.querySelector('#folderPathInput') as HTMLInputElement;
                if (input) input.value = path;
            }
        });

        on('wizardNext', () => {
            const input = this.container.querySelector('#folderPathInput') as HTMLInputElement;
            const val = input?.value.trim() ?? this.folderPath;
            if (!val) {
                this.onStatusMessage('Bitte einen Ordnerpfad eingeben.');
                input?.focus();
                return;
            }
            this.folderPath = val;
            this.step = 'pattern';
            this.render();
        });

        on('wizardStartImport', async () => {
            const patternInput = this.container.querySelector('#patternInput') as HTMLInputElement;
            this.pathPattern = patternInput?.value.trim() ?? '';
            await this.runImport();
        });

        // Live-Vorschau des Musters
        const patternInput = this.container.querySelector('#patternInput') as HTMLInputElement;
        patternInput?.addEventListener('input', () => {
            this.pathPattern = patternInput.value.trim();
            const preview = this.container.querySelector('#patternPreview');
            if (preview) preview.innerHTML = this.renderPatternPreview(this.pathPattern);
        });
    }

    private async runImport(): Promise<void> {
        this.step = 'running';
        this.render();

        try {
            const result = await recordingImportFolder({
                corpusId: this.corpus.id,
                folderPath: this.folderPath,
                pathPattern: this.pathPattern || undefined,
            });
            this.lastResult = result;
            this.step = 'done';
            this.render();
        } catch (e) {
            this.onStatusMessage(`Import-Fehler: ${e}`);
            this.step = 'pattern';
            this.render();
        }
    }
}

function escapeHtml(s: string): string {
    return s
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}
