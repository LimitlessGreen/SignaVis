// ═══════════════════════════════════════════════════════════════════════
// ui/panels/RecordingDetailPanel.ts — Slide-in detail view for recordings
//
// Opens from the right as a side panel when a recording card is clicked.
// Shows: filename, path, AudioMetadata, extracted fields, tags (quick-edit),
//        BirdNET results (if present), "Open in labeler" button.
// ═══════════════════════════════════════════════════════════════════════

import type { Recording, SoundEvent } from '../../domain/corpus/types.ts';
import {
    recordingSetTags,
    recordingSetField,
    datasetRunBirdnet,
    type BirdnetRunArgs,
} from '../../infrastructure/tauri/TauriCorpusAdapter.ts';
import { listen } from '@tauri-apps/api/event';

export interface RecordingDetailPanelOptions {
    /** Container element — typically the right column of the desktop app */
    container: HTMLElement;
    onOpenInLabeler?: (recording: Recording) => void;
    onTagsChanged?: (recording: Recording) => void;
    onStatusMessage?: (msg: string) => void;
    /** Called when a BirdNET run finishes — so the gallery can reload. */
    onAnalysisDone?: (recording: Recording, fieldName: string) => void;
    /** Called when the user clicks "Find Similar" — opens the similarity browser. */
    onFindSimilar?: (recording: Recording) => void;
}

export class RecordingDetailPanel {
    private readonly container: HTMLElement;
    private readonly onOpenInLabeler: ((r: Recording) => void) | undefined;
    private readonly onTagsChanged: ((r: Recording) => void) | undefined;
    private readonly onStatusMessage: (msg: string) => void;
    private readonly onAnalysisDone: ((r: Recording, fieldName: string) => void) | undefined;
    private readonly onFindSimilar: ((r: Recording) => void) | undefined;

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
        this.onFindSimilar = opts.onFindSimilar;
        this.renderEmpty();
    }

    /** Shows the detail view for a recording. */
    show(recording: Recording): void {
        this.current = recording;
        this.birdnetRunning = false;
        this.render();
    }

    /** Hides the panel (shows placeholder). */
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
                    <div class="detail-panel__placeholder-text">Select a recording</div>
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
                    <button class="btn btn--ghost btn--icon detail-panel__close" id="detailClose" title="Close">✕</button>
                </div>

                <div class="detail-panel__body">

                    <!-- Path -->
                    <section class="detail-section">
                        <div class="detail-section__label">Path</div>
                        <div class="detail-section__value detail-section__value--mono" title="${escapeHtml(r.filepath)}">${escapeHtml(dir)}</div>
                    </section>

                    <!-- Audio metadata -->
                    <section class="detail-section">
                        <div class="detail-section__label">Audio</div>
                        <div class="detail-meta-grid">
                            ${this.renderMetaRow('Duration', formatDuration(r.metadata.duration))}
                            ${this.renderMetaRow('Sample rate', r.metadata.sampleRate > 0 ? `${r.metadata.sampleRate.toLocaleString()} Hz` : '—')}
                            ${this.renderMetaRow('Channels', r.metadata.numChannels > 0 ? String(r.metadata.numChannels) : '—')}
                            ${this.renderMetaRow('Size', formatBytes(r.metadata.sizeBytes))}
                            ${r.metadata.mimeType ? this.renderMetaRow('Format', r.metadata.mimeType) : ''}
                        </div>
                    </section>

                    <!-- Extracted fields -->
                    ${this.renderFields(r)}

                    <!-- Recorded at -->
                    ${r.recordedAt ? `
                    <section class="detail-section">
                        <div class="detail-section__label">Recorded at</div>
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
                                placeholder="Add tag…"
                                value=""
                            />
                            <button class="btn btn--ghost btn--sm" id="detailTagAddBtn">+</button>
                        </div>
                    </section>

                    <!-- Analysis results -->
                    ${this.renderAnalysisResults(r)}

                </div>

                <div class="detail-panel__footer">
                    ${this.renderUniquenessScore(r)}
                    <button class="btn btn--primary detail-panel__open-btn" id="detailOpenLabeler">
                        Open in labeler →
                    </button>
                    <button class="btn btn--ghost detail-panel__similar-btn" id="detailFindSimilar">
                        Find Similar →
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
                <div class="detail-section__label">Path fields</div>
                <div class="detail-meta-grid">${rows}</div>
            </section>
        `;
    }

    private renderUniquenessScore(r: Recording): string {
        const fields = r.fields as Record<string, unknown> | undefined;
        const score = fields?.['uniqueness'];
        if (typeof score !== 'number') return '';
        const pct = Math.round(score * 100);
        const cls = pct >= 70 ? 'badge--accent' : pct >= 40 ? 'badge--neutral' : 'badge--muted';
        return `<span class="badge ${cls}" title="Uniqueness score (1 = most unique)">⬡ ${pct}% unique</span>`;
    }

    private renderTagList(tags: string[]): string {
        if (tags.length === 0) {
            return `<span class="detail-tags__empty">No tags</span>`;
        }
        return tags
            .map(
                (t) => `
                <span class="detail-tag">
                    ${escapeHtml(t)}
                    <button
                        class="detail-tag__remove"
                        data-remove-tag="${escapeHtml(t)}"
                        title="Remove tag"
                    >✕</button>
                </span>
            `,
            )
            .join('');
    }

    private renderAnalysisResults(r: Recording): string {
        const sections: string[] = [];

        for (const [fieldName, fieldValue] of Object.entries(r.fields ?? {})) {
            if (!isValidSoundEventsField(fieldValue)) continue;
            const events = (fieldValue as { soundEvents: SoundEvent[] }).soundEvents;
            if (!events.length) {
                sections.push(`
                    <section class="detail-section">
                        <div class="detail-section__label analysis-field-label">
                            ${escapeHtml(fieldName)}
                            <span class="badge badge--neutral">no detections</span>
                        </div>
                    </section>
                `);
                continue;
            }

            const confirmed = events.filter((e) => e.tags?.includes('confirmed')).length;
            const rejected = events.filter((e) => e.tags?.includes('rejected')).length;

            const rows = events
                .slice(0, 50)
                .map((e, idx) => {
                    const isConfirmed = e.tags?.includes('confirmed');
                    const isRejected = e.tags?.includes('rejected');
                    const confidence = (e.confidence * 100).toFixed(1);
                    const confClass =
                        e.confidence >= 0.8 ? 'conf--high'
                        : e.confidence >= 0.5 ? 'conf--mid'
                        : 'conf--low';
                    const rowClass = isConfirmed
                        ? 'detection--confirmed'
                        : isRejected
                        ? 'detection--rejected'
                        : '';
                    return `
                        <tr class="detection-row ${rowClass}"
                            data-field="${escapeHtml(fieldName)}"
                            data-idx="${idx}">
                            <td class="analysis-table__label">${escapeHtml(e.label)}</td>
                            <td class="analysis-table__conf ${confClass}">${confidence}%</td>
                            <td class="analysis-table__time">${e.support[0].toFixed(1)}–${e.support[1].toFixed(1)}s</td>
                            <td class="analysis-table__actions">
                                <button
                                    class="confirm-btn ${isConfirmed ? 'confirm-btn--active' : ''}"
                                    data-action="confirm"
                                    data-field="${escapeHtml(fieldName)}"
                                    data-idx="${idx}"
                                    title="Confirm detection"
                                >✓</button>
                                <button
                                    class="confirm-btn confirm-btn--reject ${isRejected ? 'confirm-btn--active' : ''}"
                                    data-action="reject"
                                    data-field="${escapeHtml(fieldName)}"
                                    data-idx="${idx}"
                                    title="Reject detection"
                                >✕</button>
                            </td>
                        </tr>
                    `;
                })
                .join('');

            const moreNote = events.length > 50
                ? `<div class="analysis-table__more">+ ${events.length - 50} more</div>`
                : '';

            const stats = [
                confirmed > 0 ? `<span class="badge badge--ok">${confirmed} confirmed</span>` : '',
                rejected > 0  ? `<span class="badge badge--error">${rejected} rejected</span>` : '',
            ].filter(Boolean).join(' ');

            sections.push(`
                <section class="detail-section">
                    <div class="detail-section__label analysis-field-label">
                        ${escapeHtml(fieldName)}
                        <span class="badge badge--accent">${events.length} detections</span>
                        ${stats}
                    </div>
                    <table class="analysis-table">
                        <thead>
                            <tr>
                                <th>Species</th>
                                <th>Confidence</th>
                                <th>Time range</th>
                                <th></th>
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
            ? `<button class="btn btn--ghost btn--sm" disabled>⏳ Analysis running…</button>`
            : `<button class="btn btn--ghost btn--sm" id="detailRunBirdnet">🔍 Run BirdNET</button>`;

        return `
            <section class="detail-section">
                <div class="detail-section__label detail-section__label--with-action">
                    Analysis results
                    ${birdnetBtn}
                </div>
                ${analysisHtml || '<div class="detail-section__empty">No analysis run yet.</div>'}
                <div class="detail-birdnet-progress" id="detailBirdnetProgress" style="display:none">
                    <div class="progress-bar"><div class="progress-bar__fill" id="detailProgressFill" style="width:0%"></div></div>
                    <span class="progress-label" id="detailProgressLabel">Starting…</span>
                </div>
            </section>
        `;
    }

    private bindEvents(): void {
        const r = this.current!;

        // Close
        this.container.querySelector('#detailClose')?.addEventListener('click', () => this.hide());

        // Open in labeler
        this.container.querySelector('#detailOpenLabeler')?.addEventListener('click', () => {
            this.onOpenInLabeler?.(r);
        });

        // Find similar
        this.container.querySelector('#detailFindSimilar')?.addEventListener('click', () => {
            this.onFindSimilar?.(r);
        });

        // Remove tags
        this.container.querySelectorAll('[data-remove-tag]').forEach((btn) => {
            btn.addEventListener('click', async () => {
                const tag = (btn as HTMLElement).dataset.removeTag!;
                const newTags = r.tags.filter((t) => t !== tag);
                await this.saveTags(newTags);
            });
        });

        // Add tag
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

        // Run BirdNET analysis
        this.container.querySelector('#detailRunBirdnet')?.addEventListener('click', () => {
            this.runBirdnetForCurrent();
        });

        // Confirm / reject individual detections
        this.container.querySelectorAll<HTMLButtonElement>('[data-action="confirm"],[data-action="reject"]')
            .forEach((btn) => {
                btn.addEventListener('click', async (e) => {
                    e.stopPropagation();
                    const action = btn.dataset.action as 'confirm' | 'reject';
                    const fieldName = btn.dataset.field!;
                    const idx = parseInt(btn.dataset.idx!, 10);
                    await this.toggleDetectionTag(fieldName, idx, action);
                });
            });
    }

    private async toggleDetectionTag(
        fieldName: string,
        idx: number,
        action: 'confirm' | 'reject',
    ): Promise<void> {
        if (!this.current) return;
        const r = this.current;
        const fieldValue = (r.fields as Record<string, unknown>)[fieldName];
        if (!isValidSoundEventsField(fieldValue)) return;

        const events = (fieldValue as { soundEvents: SoundEvent[] }).soundEvents;
        const event = events[idx];
        if (!event) return;

        const opposite = action === 'confirm' ? 'rejected' : 'confirmed';
        const tags = event.tags ?? [];

        let newTags: string[];
        if (tags.includes(action + 'd')) {
            // Toggle off
            newTags = tags.filter((t) => t !== action + 'd');
        } else {
            // Set this, remove opposite
            newTags = tags.filter((t) => t !== opposite).concat(action + 'd');
        }
        event.tags = newTags;

        try {
            await recordingSetField(r.id, fieldName, fieldValue);
            // Re-render analysis section only
            const analysisSection = this.container.querySelector('.detail-section:last-of-type');
            if (analysisSection) {
                const tmp = document.createElement('div');
                tmp.innerHTML = this.renderAnalysisResults(r);
                analysisSection.replaceWith(tmp.firstElementChild!);
                // Rebind confirmation buttons
                this.container
                    .querySelectorAll<HTMLButtonElement>('[data-action="confirm"],[data-action="reject"]')
                    .forEach((btn) => {
                        btn.addEventListener('click', async (e) => {
                            e.stopPropagation();
                            await this.toggleDetectionTag(
                                btn.dataset.field!,
                                parseInt(btn.dataset.idx!, 10),
                                btn.dataset.action as 'confirm' | 'reject',
                            );
                        });
                    });
            }
        } catch (e) {
            this.onStatusMessage(`Confirm/reject error: ${e}`);
        }
    }

    private async runBirdnetForCurrent(): Promise<void> {
        if (!this.current || this.birdnetRunning) return;
        const r = this.current;

        // Default field: birdnetV24
        const fieldName = 'birdnetV24';
        this.birdnetRunning = true;

        // Show progress UI
        const progressBar = this.container.querySelector('#detailBirdnetProgress') as HTMLElement | null;
        const progressFill = this.container.querySelector('#detailProgressFill') as HTMLElement | null;
        const progressLabel = this.container.querySelector('#detailProgressLabel') as HTMLElement | null;
        const runBtn = this.container.querySelector('#detailRunBirdnet') as HTMLButtonElement | null;
        if (progressBar) progressBar.style.display = '';
        if (runBtn) { runBtn.disabled = true; runBtn.textContent = '⏳ Analysis running…'; }

        // Tauri event listener for progress on this recording
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

            // Reload recording to show results
            const { recordingGet } = await import('../../infrastructure/tauri/TauriCorpusAdapter.ts');
            const updated = await recordingGet(r.id);
            this.current = updated;
            this.birdnetRunning = false;
            this.render();
            this.onStatusMessage(`BirdNET: Analysis complete.`);
            this.onAnalysisDone?.(updated, fieldName);
        } catch (e) {
            this.birdnetRunning = false;
            this.onStatusMessage(`BirdNET error: ${e}`);
            if (progressBar) progressBar.style.display = 'none';
            if (runBtn) { runBtn.disabled = false; runBtn.textContent = '🔍 Run BirdNET'; }
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
            // Re-render the tags section (without a full panel re-render)
            const tagsEl = this.container.querySelector('#detailTags');
            if (tagsEl) {
                tagsEl.innerHTML = this.renderTagList(newTags);
                // Rebind events
                tagsEl.querySelectorAll('[data-remove-tag]').forEach((btn) => {
                    btn.addEventListener('click', async () => {
                        const tag = (btn as HTMLElement).dataset.removeTag!;
                        await this.saveTags(newTags.filter((t) => t !== tag));
                    });
                });
            }
            this.onTagsChanged?.(this.current);
        } catch (e) {
            this.onStatusMessage(`Tag error: ${e}`);
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

/** Checks whether a field value has the shape { soundEvents: SoundEvent[] }. */
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
