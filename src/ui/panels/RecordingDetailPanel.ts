// ═══════════════════════════════════════════════════════════════════════
// ui/panels/RecordingDetailPanel.ts — Slide-In Detailansicht für Aufnahmen
//
// Öffnet sich von rechts als Side-Panel wenn eine Recording-Karte geklickt wird.
// Zeigt: Dateiname, Pfad, AudioMetadata, extrahierte Felder, Tags (Quick-Edit),
//         BirdNET-Ergebnisse (falls vorhanden), "Im Labeler öffnen"-Button.
// ═══════════════════════════════════════════════════════════════════════

import type { Recording, SoundEvent } from '../../domain/corpus/types.ts';
import { recordingSetTags, datasetRunBirdnet, type BirdnetRunArgs } from '../../infrastructure/tauri/TauriCorpusAdapter.ts';
import { listen } from '@tauri-apps/api/event';

export interface RecordingDetailPanelOptions {
    /** Container-Element — typischerweise die rechte Spalte der Desktop-App */
    container: HTMLElement;
    onOpenInLabeler?: (recording: Recording) => void;
    onTagsChanged?: (recording: Recording) => void;
    onStatusMessage?: (msg: string) => void;
    /** Wird aufgerufen wenn BirdNET-Run abgeschlossen — damit die Galerie neu laden kann. */
    onAnalysisDone?: (recording: Recording, fieldName: string) => void;
}

export class RecordingDetailPanel {
    private readonly container: HTMLElement;
    private readonly onOpenInLabeler: ((r: Recording) => void) | undefined;
    private readonly onTagsChanged: ((r: Recording) => void) | undefined;
    private readonly onStatusMessage: (msg: string) => void;
    private readonly onAnalysisDone: ((r: Recording, fieldName: string) => void) | undefined;

    private current: Recording | null = null;
    private newTagInput = '';
    private birdnetRunning = false;
    private unlistenProgress: (() => void) | null = null;

    constructor(opts: RecordingDetailPanelOptions) {
        this.container = opts.container;
        this.onOpenInLabeler = opts.onOpenInLabeler;
        this.onTagsChanged = opts.onTagsChanged;
        this.onStatusMessage = opts.onStatusMessage ?? ((m) => console.log(m));
        this.onAnalysisDone = opts.onAnalysisDone;
        this.renderEmpty();
    }

    /** Zeigt die Detailansicht für eine Aufnahme. */
    show(recording: Recording): void {
        this.current = recording;
        this.birdnetRunning = false;
        this.render();
    }

    /** Blendet das Panel aus (zeigt Platzhalter). */
    hide(): void {
        this.unlistenProgress?.();
        this.unlistenProgress = null;
        this.current = null;
        this.renderEmpty();
    }

    // ── Private ─────────────────────────────────────────────────────

    private renderEmpty(): void {
        this.container.innerHTML = `
            <div class="detail-panel detail-panel--empty">
                <div class="detail-panel__placeholder">
                    <div class="detail-panel__placeholder-icon">🎵</div>
                    <div class="detail-panel__placeholder-text">Aufnahme auswählen</div>
                </div>
            </div>
        `;
    }

    private render(): void {
        if (!this.current) return;
        const r = this.current;
        const filename = r.filepath.split('/').pop() ?? r.filepath;
        const dir = r.filepath.split('/').slice(0, -1).join('/') || '/';

        this.container.innerHTML = `
            <div class="detail-panel">
                <div class="detail-panel__header">
                    <div class="detail-panel__title" title="${escapeHtml(r.filepath)}">${escapeHtml(filename)}</div>
                    <button class="btn btn--ghost btn--icon detail-panel__close" id="detailClose" title="Schließen">✕</button>
                </div>

                <div class="detail-panel__body">

                    <!-- Pfad -->
                    <section class="detail-section">
                        <div class="detail-section__label">Pfad</div>
                        <div class="detail-section__value detail-section__value--mono" title="${escapeHtml(r.filepath)}">${escapeHtml(dir)}</div>
                    </section>

                    <!-- Audio-Metadaten -->
                    <section class="detail-section">
                        <div class="detail-section__label">Audio</div>
                        <div class="detail-meta-grid">
                            ${this.renderMetaRow('Dauer', formatDuration(r.metadata.duration))}
                            ${this.renderMetaRow('Sample-Rate', r.metadata.sampleRate > 0 ? `${r.metadata.sampleRate.toLocaleString()} Hz` : '—')}
                            ${this.renderMetaRow('Kanäle', r.metadata.numChannels > 0 ? String(r.metadata.numChannels) : '—')}
                            ${this.renderMetaRow('Größe', formatBytes(r.metadata.sizeBytes))}
                            ${r.metadata.mimeType ? this.renderMetaRow('Format', r.metadata.mimeType) : ''}
                        </div>
                    </section>

                    <!-- Extrahierte Felder -->
                    ${this.renderFields(r)}

                    <!-- Aufnahmezeitpunkt -->
                    ${r.recordedAt ? `
                    <section class="detail-section">
                        <div class="detail-section__label">Aufgenommen</div>
                        <div class="detail-section__value">${new Date(r.recordedAt).toLocaleString()}</div>
                    </section>` : ''}

                    <!-- Tags -->
                    <section class="detail-section">
                        <div class="detail-section__label">Tags</div>
                        <div class="detail-tags" id="detailTags">
                            ${this.renderTagList(r.tags)}
                        </div>
                        <div class="detail-tag-add">
                            <input
                                type="text"
                                class="input input--sm detail-tag-input"
                                id="detailTagInput"
                                placeholder="Tag hinzufügen…"
                                value=""
                            />
                            <button class="btn btn--ghost btn--sm" id="detailTagAddBtn">+</button>
                        </div>
                    </section>

                    <!-- Analyseergebnisse -->
                    ${this.renderAnalysisResults(r)}

                </div>

                <div class="detail-panel__footer">
                    <button class="btn btn--primary detail-panel__open-btn" id="detailOpenLabeler">
                        Im Labeler öffnen →
                    </button>
                </div>
            </div>
        `;

        this.bindEvents();
    }

    private renderMetaRow(label: string, value: string): string {
        return `
            <div class="detail-meta-row">
                <span class="detail-meta-row__label">${escapeHtml(label)}</span>
                <span class="detail-meta-row__value">${escapeHtml(value)}</span>
            </div>
        `;
    }

    private renderFields(r: Recording): string {
        const fields = r.fields as Record<string, string> | undefined;
        if (!fields || Object.keys(fields).length === 0) return '';
        const rows = Object.entries(fields)
            .map(([k, v]) => this.renderMetaRow(k, String(v)))
            .join('');
        return `
            <section class="detail-section">
                <div class="detail-section__label">Pfad-Felder</div>
                <div class="detail-meta-grid">${rows}</div>
            </section>
        `;
    }

    private renderTagList(tags: string[]): string {
        if (tags.length === 0) {
            return `<span class="detail-tags__empty">Keine Tags</span>`;
        }
        return tags
            .map(
                (t) => `
                <span class="detail-tag">
                    ${escapeHtml(t)}
                    <button
                        class="detail-tag__remove"
                        data-remove-tag="${escapeHtml(t)}"
                        title="Tag entfernen"
                    >✕</button>
                </span>
            `,
            )
            .join('');
    }

    private renderAnalysisResults(r: Recording): string {
        // Alle SoundEvents-Felder aus r.fields sammeln
        // Jedes Feld mit shape { soundEvents: [...] } wird als Analyse-Ergebnis dargestellt.
        const sections: string[] = [];

        for (const [fieldName, fieldValue] of Object.entries(r.fields ?? {})) {
            if (!isValidSoundEventsField(fieldValue)) continue;
            const events = (fieldValue as { soundEvents: SoundEvent[] }).soundEvents;
            if (!events.length) {
                sections.push(`
                    <section class="detail-section">
                        <div class="detail-section__label analysis-field-label">
                            ${escapeHtml(fieldName)}
                            <span class="badge badge--neutral">keine Detektionen</span>
                        </div>
                    </section>
                `);
                continue;
            }

            const rows = events
                .slice(0, 20)
                .map((e) => {
                    const confidence = (e.confidence * 100).toFixed(1);
                    const confClass =
                        e.confidence >= 0.8 ? 'conf--high'
                        : e.confidence >= 0.5 ? 'conf--mid'
                        : 'conf--low';
                    return `
                        <tr>
                            <td class="analysis-table__label">${escapeHtml(e.label)}</td>
                            <td class="analysis-table__conf ${confClass}">${confidence}%</td>
                            <td class="analysis-table__time">${e.support[0].toFixed(1)}–${e.support[1].toFixed(1)}s</td>
                        </tr>
                    `;
                })
                .join('');

            const moreNote = events.length > 20
                ? `<div class="analysis-table__more">+ ${events.length - 20} weitere</div>`
                : '';

            sections.push(`
                <section class="detail-section">
                    <div class="detail-section__label analysis-field-label">
                        ${escapeHtml(fieldName)}
                        <span class="badge badge--accent">${events.length} Detektionen</span>
                    </div>
                    <table class="analysis-table">
                        <thead>
                            <tr>
                                <th>Art</th>
                                <th>Konfidenz</th>
                                <th>Zeitbereich</th>
                            </tr>
                        </thead>
                        <tbody>${rows}</tbody>
                    </table>
                    ${moreNote}
                </section>
            `);
        }

        const analysisHtml = sections.length > 0
            ? sections.join('')
            : '';

        const birdnetBtn = this.birdnetRunning
            ? `<button class="btn btn--ghost btn--sm" disabled>⏳ Analyse läuft…</button>`
            : `<button class="btn btn--ghost btn--sm" id="detailRunBirdnet">🔍 BirdNET analysieren</button>`;

        return `
            <section class="detail-section">
                <div class="detail-section__label detail-section__label--with-action">
                    Analyseergebnisse
                    ${birdnetBtn}
                </div>
                ${analysisHtml || '<div class="detail-section__empty">Noch keine Analyse durchgeführt.</div>'}
                <div class="detail-birdnet-progress" id="detailBirdnetProgress" style="display:none">
                    <div class="progress-bar"><div class="progress-bar__fill" id="detailProgressFill" style="width:0%"></div></div>
                    <span class="progress-label" id="detailProgressLabel">Starte…</span>
                </div>
            </section>
        `;
    }

    private bindEvents(): void {
        const r = this.current!;

        // Schließen
        this.container.querySelector('#detailClose')?.addEventListener('click', () => this.hide());

        // Im Labeler öffnen
        this.container.querySelector('#detailOpenLabeler')?.addEventListener('click', () => {
            this.onOpenInLabeler?.(r);
        });

        // Tags entfernen
        this.container.querySelectorAll('[data-remove-tag]').forEach((btn) => {
            btn.addEventListener('click', async () => {
                const tag = (btn as HTMLElement).dataset.removeTag!;
                const newTags = r.tags.filter((t) => t !== tag);
                await this.saveTags(newTags);
            });
        });

        // Tag hinzufügen
        const tagInput = this.container.querySelector('#detailTagInput') as HTMLInputElement;
        const tagAddBtn = this.container.querySelector('#detailTagAddBtn');

        const addTag = async () => {
            const val = tagInput.value.trim();
            if (!val || r.tags.includes(val)) return;
            await this.saveTags([...r.tags, val]);
            tagInput.value = '';
        };

        tagAddBtn?.addEventListener('click', addTag);
        tagInput?.addEventListener('keydown', (e) => {
            if ((e as KeyboardEvent).key === 'Enter') addTag();
        });

        // BirdNET analysieren
        this.container.querySelector('#detailRunBirdnet')?.addEventListener('click', () => {
            this.runBirdnetForCurrent();
        });
    }

    private async runBirdnetForCurrent(): Promise<void> {
        if (!this.current || this.birdnetRunning) return;
        const r = this.current;

        // Standardfeld: birdnetV24
        const fieldName = 'birdnetV24';
        this.birdnetRunning = true;

        // Fortschritts-UI einblenden
        const progressBar = this.container.querySelector('#detailBirdnetProgress') as HTMLElement | null;
        const progressFill = this.container.querySelector('#detailProgressFill') as HTMLElement | null;
        const progressLabel = this.container.querySelector('#detailProgressLabel') as HTMLElement | null;
        const runBtn = this.container.querySelector('#detailRunBirdnet') as HTMLButtonElement | null;
        if (progressBar) progressBar.style.display = '';
        if (runBtn) { runBtn.disabled = true; runBtn.textContent = '⏳ Analyse läuft…'; }

        // Tauri-Event-Listener für Fortschritt dieser Recording
        this.unlistenProgress?.();
        let unlistenFn: (() => void) | null = null;
        const unlistenHandle = await listen<{ filepath: string; current: number; total: number }>(
            'dataset:birdnet-progress',
            (event) => {
                const { current, total } = event.payload;
                const pct = total > 0 ? Math.round((current / total) * 100) : 0;
                if (progressFill) progressFill.style.width = `${pct}%`;
                if (progressLabel) progressLabel.textContent = `${current} / ${total}`;
            },
        );
        unlistenFn = unlistenHandle;
        this.unlistenProgress = () => { unlistenFn?.(); };

        try {
            const args: BirdnetRunArgs = {
                datasetId: r.datasetId,
                fieldName,
                recordingIds: [r.id],
            };
            await datasetRunBirdnet(args);

            // Recording neu laden um Ergebnisse zu zeigen
            const { recordingGet } = await import('../../infrastructure/tauri/TauriCorpusAdapter.ts');
            const updated = await recordingGet(r.id);
            this.current = updated;
            this.birdnetRunning = false;
            this.render();
            this.onStatusMessage(`BirdNET: Analyse abgeschlossen.`);
            this.onAnalysisDone?.(updated, fieldName);
        } catch (e) {
            this.birdnetRunning = false;
            this.onStatusMessage(`BirdNET-Fehler: ${e}`);
            if (progressBar) progressBar.style.display = 'none';
            if (runBtn) { runBtn.disabled = false; runBtn.textContent = '🔍 BirdNET analysieren'; }
        } finally {
            this.unlistenProgress?.();
            this.unlistenProgress = null;
        }
    }

    private async saveTags(newTags: string[]): Promise<void> {
        if (!this.current) return;
        try {
            await recordingSetTags(this.current.id, newTags);
            this.current = { ...this.current, tags: newTags };
            // Tags-Bereich neu rendern (ohne komplettes Panel-Re-render)
            const tagsEl = this.container.querySelector('#detailTags');
            if (tagsEl) {
                tagsEl.innerHTML = this.renderTagList(newTags);
                // Events neu binden
                tagsEl.querySelectorAll('[data-remove-tag]').forEach((btn) => {
                    btn.addEventListener('click', async () => {
                        const tag = (btn as HTMLElement).dataset.removeTag!;
                        await this.saveTags(newTags.filter((t) => t !== tag));
                    });
                });
            }
            this.onTagsChanged?.(this.current);
        } catch (e) {
            this.onStatusMessage(`Tag-Fehler: ${e}`);
        }
    }
}

// ── Helpers ──────────────────────────────────────────────────────────

function escapeHtml(s: string): string {
    return s
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

/** Prüft, ob ein Feld-Wert das Shape { soundEvents: SoundEvent[] } hat. */
function isValidSoundEventsField(value: unknown): boolean {
    if (!value || typeof value !== 'object') return false;
    const v = value as Record<string, unknown>;
    return Array.isArray(v.soundEvents);
}

function formatDuration(s: number): string {
    if (!s || s <= 0) return '—';
    if (s < 60) return `${s.toFixed(1)}s`;
    const m = Math.floor(s / 60);
    const sec = Math.round(s % 60);
    return `${m}:${sec.toString().padStart(2, '0')}`;
}

function formatBytes(b: number): string {
    if (!b || b <= 0) return '—';
    if (b < 1024) return `${b} B`;
    if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
    return `${(b / (1024 * 1024)).toFixed(1)} MB`;
}
