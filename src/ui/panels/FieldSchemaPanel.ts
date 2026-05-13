// ═══════════════════════════════════════════════════════════════════════
// ui/panels/FieldSchemaPanel.ts — Dataset field schema editor
//
// Slide-in panel listing all fields on a dataset and allowing new
// fields to be added.  Opens as an overlay from the gallery toolbar.
// ═══════════════════════════════════════════════════════════════════════

import type { Dataset, FieldDefinition, FieldKind } from '../../domain/corpus/types.ts';
import {
    datasetAddFieldToSchema,
    type DatasetAddFieldArgs,
} from '../../infrastructure/tauri/TauriCorpusAdapter.ts';

const FIELD_KINDS: FieldKind[] = [
    'string', 'int', 'float', 'bool', 'date',
    'string_list', 'dict', 'geo_location', 'vector',
    'classification', 'classifications', 'sound_event', 'sound_events', 'regression',
];

export interface FieldSchemaPanelOptions {
    dataset: Dataset;
    onDatasetUpdated: (updated: Dataset) => void;
    onClose: () => void;
    onStatusMessage?: (msg: string) => void;
}

export class FieldSchemaPanel {
    private readonly opts: FieldSchemaPanelOptions;
    private dataset: Dataset;
    private overlay: HTMLElement | null = null;

    constructor(opts: FieldSchemaPanelOptions) {
        this.opts = opts;
        this.dataset = opts.dataset;
    }

    open(): void {
        if (this.overlay) return;
        this.overlay = document.createElement('div');
        this.overlay.className = 'field-schema-overlay';
        this.overlay.innerHTML = this.render();
        document.body.appendChild(this.overlay);
        this.bindEvents();
    }

    close(): void {
        this.overlay?.remove();
        this.overlay = null;
        this.opts.onClose();
    }

    private render(): string {
        const fields = this.dataset.fieldSchema ?? [];
        const systemFields = fields.filter((f) => f.system);
        const userFields = fields.filter((f) => !f.system);

        const renderField = (f: FieldDefinition): string => `
            <tr class="field-row" data-field="${escapeHtml(f.name)}">
                <td class="field-row__name">${escapeHtml(f.name)}</td>
                <td class="field-row__kind"><span class="badge badge--neutral">${escapeHtml(f.kind)}</span></td>
                <td class="field-row__group">${escapeHtml(f.group ?? '—')}</td>
                <td class="field-row__desc">${escapeHtml(f.description ?? '')}</td>
            </tr>
        `;

        const kindOptions = FIELD_KINDS
            .map((k) => `<option value="${k}">${k}</option>`)
            .join('');

        return `
            <div class="field-schema-panel" role="dialog" aria-label="Field schema">
                <div class="field-schema-panel__header">
                    <h3 class="field-schema-panel__title">Fields — ${escapeHtml(this.dataset.name)}</h3>
                    <button class="btn btn--ghost btn--icon" id="fieldSchemaClose" title="Close">✕</button>
                </div>

                <div class="field-schema-panel__body">

                    ${userFields.length > 0 ? `
                    <section class="field-schema-section">
                        <div class="field-schema-section__label">User-defined fields</div>
                        <table class="field-table">
                            <thead><tr>
                                <th>Name</th><th>Type</th><th>Group</th><th>Description</th>
                            </tr></thead>
                            <tbody>${userFields.map(renderField).join('')}</tbody>
                        </table>
                    </section>` : `
                    <section class="field-schema-section">
                        <div class="field-schema-empty">No user-defined fields yet.</div>
                    </section>`}

                    ${systemFields.length > 0 ? `
                    <section class="field-schema-section">
                        <details class="field-schema-section__details">
                            <summary class="field-schema-section__label">System fields (${systemFields.length})</summary>
                            <table class="field-table field-table--muted">
                                <thead><tr>
                                    <th>Name</th><th>Type</th><th>Group</th><th>Description</th>
                                </tr></thead>
                                <tbody>${systemFields.map(renderField).join('')}</tbody>
                            </table>
                        </details>
                    </section>` : ''}

                    <!-- Add field form -->
                    <section class="field-schema-section field-schema-section--add">
                        <div class="field-schema-section__label">Add field</div>
                        <div class="field-add-form">
                            <input
                                class="input input--sm" id="fieldAddName"
                                type="text" placeholder="Field name (e.g. recorder_id)"
                                maxlength="64"
                            />
                            <select class="input input--sm" id="fieldAddKind">
                                ${kindOptions}
                            </select>
                            <input
                                class="input input--sm" id="fieldAddGroup"
                                type="text" placeholder="Group (optional)"
                                maxlength="64"
                            />
                            <input
                                class="input input--sm" id="fieldAddDesc"
                                type="text" placeholder="Description (optional)"
                                maxlength="200"
                            />
                            <button class="btn btn--primary btn--sm" id="fieldAddBtn">Add</button>
                        </div>
                        <div class="field-add-error" id="fieldAddError" style="display:none"></div>
                    </section>

                </div>
            </div>
            <div class="field-schema-backdrop" id="fieldSchemaBackdrop"></div>
        `;
    }

    private rerender(): void {
        if (!this.overlay) return;
        this.overlay.innerHTML = this.render();
        this.bindEvents();
    }

    private bindEvents(): void {
        this.overlay!.querySelector('#fieldSchemaClose')?.addEventListener('click', () => this.close());
        this.overlay!.querySelector('#fieldSchemaBackdrop')?.addEventListener('click', () => this.close());

        const nameInput = this.overlay!.querySelector('#fieldAddName') as HTMLInputElement;
        const kindSelect = this.overlay!.querySelector('#fieldAddKind') as HTMLSelectElement;
        const groupInput = this.overlay!.querySelector('#fieldAddGroup') as HTMLInputElement;
        const descInput = this.overlay!.querySelector('#fieldAddDesc') as HTMLInputElement;
        const addBtn = this.overlay!.querySelector('#fieldAddBtn') as HTMLButtonElement;
        const errorEl = this.overlay!.querySelector('#fieldAddError') as HTMLElement;

        const showError = (msg: string) => {
            errorEl.textContent = msg;
            errorEl.style.display = '';
        };
        const clearError = () => { errorEl.style.display = 'none'; };

        nameInput?.addEventListener('input', clearError);

        const submit = async () => {
            const name = nameInput.value.trim().replace(/\s+/g, '_');
            if (!name) { showError('Field name is required.'); nameInput.focus(); return; }
            if (!/^[a-zA-Z][a-zA-Z0-9_]*$/.test(name)) {
                showError('Name must start with a letter and contain only letters, digits, underscores.');
                nameInput.focus();
                return;
            }
            if (this.dataset.fieldSchema.some((f) => f.name === name)) {
                showError(`Field "${name}" already exists.`);
                nameInput.focus();
                return;
            }

            addBtn.disabled = true;
            addBtn.textContent = 'Adding…';
            clearError();
            try {
                const args: DatasetAddFieldArgs = {
                    datasetId: this.dataset.id,
                    fieldName: name,
                    fieldKind: kindSelect.value,
                    group: groupInput.value.trim() || undefined,
                    description: descInput.value.trim() || undefined,
                };
                const updated = await datasetAddFieldToSchema(args);
                this.dataset = updated;
                this.opts.onDatasetUpdated(updated);
                this.opts.onStatusMessage?.(`Field "${name}" added.`);
                this.rerender();
            } catch (e) {
                showError(`Error: ${e}`);
                addBtn.disabled = false;
                addBtn.textContent = 'Add';
            }
        };

        addBtn?.addEventListener('click', submit);
        nameInput?.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
    }
}

function escapeHtml(s: string): string {
    return s
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}
