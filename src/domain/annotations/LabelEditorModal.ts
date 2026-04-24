// ═══════════════════════════════════════════════════════════════════════
// LabelEditorModal.js — Label / species editor modal dialog
//
// Extracted from the openLabelNameEditor() function in annotations.js.
//
// Usage:
//   const modal = new LabelEditorModal({ player, initialValue, onSubmit });
//   modal.open();
//
// The old openLabelNameEditor() function in annotations.js is now a thin
// wrapper that creates an instance and calls open().
// ═══════════════════════════════════════════════════════════════════════

import ModalManager from '../../ui/modal-manager.ts';
import { createEditableSelect } from '../../ui/editable-select.ts';
import { getOverlayColorStyle } from '../annotations.ts';

const DEFAULT_TAG_PRESETS = [
    { key: 'sex',       label: 'Sex',        options: ['male', 'female', 'unknown'] },
    { key: 'lifeStage', label: 'Life stage',  options: ['adult', 'juvenile', 'immature', 'subadult'] },
    { key: 'soundType', label: 'Sound type',  options: ['song', 'call', 'alarm call', 'flight call', 'begging call', 'drumming', 'nocturnal flight call'] },
];

export class LabelEditorModal {
    /**
     * @param {object} opts
     * @param {object}   opts.player          - BirdNETPlayer instance
     * @param {Element | null} [opts.anchorEl] - element to position the panel near (unused, reserved)
     * @param {string | null} [opts.initialValue]
     * @param {string | null} [opts.initialColor]
     * @param {object | null} [opts.initialTags]
     * @param {Array | null}  [opts.existingLabels]
     * @param {string | null} [opts.initialScientificName]
     * @param {string | null} [opts.title]
     * @param {Function} opts.onSubmit
     * @param {Function | null} [opts.onDelete]
     * @param {((event: string, detail: object) => void) | null} [opts.onLayerEmit]
     *   Optional emit callback for layer-originating events (tagcustom*).
     *   When omitted, these events are silently dropped (no player dependency needed).
     */
    constructor({ player, anchorEl, initialValue, initialColor, initialTags,
                  existingLabels, initialScientificName, title,
                  onSubmit, onDelete, onLayerEmit }) {
        this._player         = player;
        this._anchorEl       = anchorEl;
        this._onSubmit       = onSubmit;
        this._onDelete       = onDelete;
        this._title          = title;
        this._existingLabels = existingLabels;
        // Optional emit callback — replaces direct player._emit() calls for tag events.
        // Callers that don't need tagcustom* events can omit this.
        this._onLayerEmit    = onLayerEmit ?? null;

        // ── State ────────────────────────────────────────────────────
        const initialStyle = getOverlayColorStyle(initialColor);
        this._initialValueTrim = String(initialValue || '').trim();
        this._initialStyleHex  = initialStyle?.hex || '';
        this._initialTagsNorm  = (initialTags && typeof initialTags === 'object') ? { ...initialTags } : {};
        this._initialScientific = String(initialScientificName || '').trim();

        this._currentTags   = { ...(initialTags || {}) };
        this._selectedSci   = this._initialScientific;
        this._colorTouched  = false;
        this._tagsTouched   = false;
        this._sciTouched    = false;
        this._activeIndex   = -1;
        /** @type {HTMLElement[]} */
        this._resultItems   = [];
        this._esInstances   = [];
        this._modal         = /** @type {any} */ (null);

        // ── DOM ──────────────────────────────────────────────────────
        this._backdrop   = /** @type {HTMLElement} */ (/** @type {unknown} */ (null));
        this._panel      = /** @type {HTMLElement} */ (/** @type {unknown} */ (null));
        this._input      = /** @type {HTMLInputElement} */ (/** @type {unknown} */ (null));
        this._colorInput = /** @type {HTMLInputElement} */ (/** @type {unknown} */ (null));
        this._tagsRow    = /** @type {HTMLElement} */ (/** @type {unknown} */ (null));
        this._results    = /** @type {HTMLElement} */ (/** @type {unknown} */ (null));
        this._confirmBtn = /** @type {HTMLButtonElement} */ (/** @type {unknown} */ (null));

        this._tagPresets = player?.getTagPresets?.() || DEFAULT_TAG_PRESETS;
        this._initialColor = initialColor;
        this._initialValue = initialValue;
    }

    // ── Public API ───────────────────────────────────────────────────

    open() {
        const host = this._player?.root || this._player?.container || document.body;
        if (!host || typeof this._onSubmit !== 'function') return;

        this._buildDOM();
        host.appendChild(this._backdrop);
        this._renderTags();
        this._renderResults();

        this._modal = new ModalManager({
            backdrop: this._backdrop,
            dialog:   this._panel,
            onClose:  () => this.close(),
        });
        this._modal.open();

        setTimeout(() => {
            this._input.focus();
            this._input.select();
        }, 0);
    }

    close() {
        for (const es of this._esInstances) { try { es.destroy(); } catch { /* ignore */ } }
        this._esInstances = [];
        try { this._modal?.close(); } catch { /* ignore */ }
        if (this._backdrop?.parentNode) this._backdrop.parentNode.removeChild(this._backdrop);
        try { this._modal?.dispose(); } catch { /* ignore */ }
        this._modal = null;
    }

    // ── Private: DOM construction ─────────────────────────────────────

    _buildDOM() {
        const initialStyle = getOverlayColorStyle(this._initialColor);

        this._backdrop = document.createElement('div');
        this._backdrop.className = 'label-editor-backdrop';

        this._panel = document.createElement('div');
        this._panel.className = 'label-name-editor';

        // Header row
        const header = document.createElement('div');
        header.className = 'label-editor-header';
        const titleEl = document.createElement('span');
        titleEl.className = 'label-editor-title';
        titleEl.textContent = this._title || 'Edit label';
        const xBtn = document.createElement('button');
        xBtn.type = 'button';
        xBtn.className = 'modal-close';
        xBtn.setAttribute('aria-label', 'Close');
        xBtn.textContent = '×';
        xBtn.dataset.modalHandlerBound = '1';
        xBtn.addEventListener('click', () => this.close());
        header.append(titleEl, xBtn);

        // Search row: text input + color swatch
        const searchRow = document.createElement('div');
        searchRow.className = 'label-search-row';

        this._input = document.createElement('input');
        this._input.type = 'text';
        this._input.maxLength = 96;
        this._input.className = 'label-search-input';
        this._input.placeholder = this._title || 'Search species or label…';
        this._input.value = this._initialValueTrim;

        this._colorInput = document.createElement('input');
        this._colorInput.type = 'color';
        this._colorInput.className = 'label-search-color';
        this._colorInput.value = initialStyle?.hex || '#0ea5e9';
        this._colorInput.addEventListener('input', () => { this._colorTouched = true; });

        searchRow.append(this._input, this._colorInput);

        // Tags row (populated by _renderTags)
        this._tagsRow = document.createElement('div');
        this._tagsRow.className = 'label-tags-row';

        // Results list (populated by _renderResults)
        this._results = document.createElement('div');
        this._results.className = 'label-search-results';

        // Footer with hints + optional delete + save
        const footer = document.createElement('div');
        footer.className = 'label-search-footer';
        const hints = document.createElement('span');
        hints.className = 'label-search-hints';
        hints.textContent = '↑↓ navigate · click select · dblclick confirm · esc close';
        footer.appendChild(hints);

        if (this._onDelete) {
            const delBtn = document.createElement('button');
            delBtn.type = 'button';
            delBtn.className = 'label-search-delete';
            delBtn.textContent = 'Delete';
            delBtn.addEventListener('click', () => { this.close(); this._onDelete?.(); });
            footer.appendChild(delBtn);
        }

        this._confirmBtn = document.createElement('button');
        this._confirmBtn.type = 'button';
        this._confirmBtn.className = 'label-search-confirm';
        this._confirmBtn.textContent = 'Save';
        this._confirmBtn.addEventListener('click', () => this._submit(this._input.value));
        footer.appendChild(this._confirmBtn);

        this._panel.append(header, searchRow, this._tagsRow, this._results, footer);
        this._backdrop.appendChild(this._panel);

        // Input events
        this._input.addEventListener('input', () => {
            this._selectedSci = '';
            this._sciTouched = true;
            this._renderResults();
        });
        this._input.addEventListener('keydown', (e: unknown) => this._handleKeydown(e));
    }

    // ── Private: tag management ───────────────────────────────────────

    _renderTags() {
        this._tagsRow.innerHTML = '';
        // Destroy old editable-select instances before rebuilding
        for (const es of this._esInstances) { try { es.destroy(); } catch { /* ignore */ } }
        this._esInstances = [];

        for (const preset of this._tagPresets) {
            this._tagsRow.appendChild(this._makeTagCombobox(preset));
        }

        // Custom tag badges
        const customKeys = Object.keys(this._currentTags).filter((k) => !this._tagPresets.some((p: unknown) => p.key === k));
        for (const key of customKeys) {
            const badge = document.createElement('span');
            badge.className = 'label-tag-badge';
            badge.textContent = `${key}: ${this._currentTags[key]}`;
            const delBtn = document.createElement('span');
            delBtn.className = 'label-tag-badge-del';
            delBtn.textContent = '×';
            delBtn.addEventListener('click', () => { delete this._currentTags[key]; this._renderTags(); });
            badge.appendChild(delBtn);
            this._tagsRow.appendChild(badge);
        }

        // Add custom tag button
        const addBtn = document.createElement('button');
        addBtn.type = 'button';
        addBtn.className = 'label-tag-add';
        addBtn.textContent = '+ Tag';
        addBtn.addEventListener('click', () => {
            addBtn.hidden = true;
            const form = document.createElement('span');
            form.className = 'label-tag-inline-form';
            const keyInput = document.createElement('input');
            keyInput.type = 'text'; keyInput.placeholder = 'key'; keyInput.className = 'label-tag-inline-input';
            const valInput = document.createElement('input');
            valInput.type = 'text'; valInput.placeholder = 'value'; valInput.className = 'label-tag-inline-input';
            const okBtn  = document.createElement('button'); okBtn.type = 'button'; okBtn.textContent = '✓'; okBtn.className = 'label-tag-inline-confirm';
            const noBtn  = document.createElement('button'); noBtn.type = 'button'; noBtn.textContent = '✕'; noBtn.className = 'label-tag-inline-cancel';
            const commit = () => {
                const k = keyInput.value.trim();
                const v = valInput.value.trim();
                if (k) this._currentTags[k] = v;
                this._renderTags();
            };
            okBtn.addEventListener('click', commit);
            noBtn.addEventListener('click', () => this._renderTags());
            valInput.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') { e.preventDefault(); commit(); }
                if (e.key === 'Escape') this._renderTags();
            });
            form.append(keyInput, valInput, okBtn, noBtn);
            this._tagsRow.appendChild(form);
            keyInput.focus();
        });
        this._tagsRow.appendChild(addBtn);
    }

    _makeTagCombobox(preset: unknown) {
        const presetDef     = this._tagPresets.find((p: unknown) => p.key === preset.key) || preset;
        const defaultDef    = DEFAULT_TAG_PRESETS.find((p) => p.key === preset.key) || preset;
        const presetOptions = Array.isArray(presetDef.options) ? presetDef.options.slice() : (preset.options || []);
        const baseOptions   = Array.isArray(defaultDef.options) ? defaultDef.options.slice() : (preset.options || []);
        const curVal        = this._currentTags[preset.key] || '';

        const items = presetOptions.map((v: unknown) => ({ value: v, custom: !baseOptions.includes(v) }));
        if (curVal && !items.some((it: unknown) => it.value === curVal)) {
            items.push({ value: curVal, custom: !baseOptions.includes(curVal) });
        }

        const es = createEditableSelect({
            placeholder: preset.label || '–',
            value: curVal,
            items,
            onChange: (val: unknown) => {
                this._tagsTouched = true;
                if (val) this._currentTags[preset.key] = val;
                else     delete this._currentTags[preset.key];
            },
            onAdd:    (val: unknown)        => { this._tagsTouched = true; this._onLayerEmit?.('tagcustomadd',    { key: preset.key, value: val }); },
            onRemove: (val: unknown)        => { this._tagsTouched = true; this._onLayerEmit?.('tagcustomremove', { key: preset.key, value: val }); },
            onRename: (oldV: unknown, newV: unknown) => { this._tagsTouched = true; this._onLayerEmit?.('tagcustomrename', { key: preset.key, oldValue: oldV, newValue: newV }); },
        });
        es.el.classList.add('label-tag-combo');
        const trig = es.el.querySelector('.esel-trigger');
        if (trig) trig.setAttribute('title', preset.label || preset.key);
        this._esInstances.push(es);
        return es.el;
    }

    // ── Private: results rendering ────────────────────────────────────

    _renderResults() {
        const player       = this._player;
        const suggestionMode = player?.getLabelEditorSuggestionMode?.() || 'merge';
        const customOnly   = suggestionMode === 'custom-only';
        const taxonomy     = player?.getLabelTaxonomy?.() || [];
        const recent       = player?.getLabelSuggestions?.('', 8) || [];
        const filtered     = player?.getLabelSuggestions?.(this._input.value, 8) || [];
        const custom       = player?.getLabelEditorSuggestions?.(this._input.value, 14) || [];

        this._results.innerHTML = '';
        this._resultItems = [];
        this._activeIndex = -1;

        const seen = new Set();
        const addResult = ({ name, scientificName = '', color = '', detail = '', tags = {} }) => {
            const label = String(name || '').trim();
            if (!label) return;
            const key = label.toLowerCase();
            if (seen.has(key)) return;
            seen.add(key);

            const row = document.createElement('button');
            row.type = 'button';
            row.className = 'label-search-item';

            if (color) {
                const dot = document.createElement('span');
                dot.className = 'label-search-dot';
                dot.style.background = getOverlayColorStyle(color)?.hex || color;
                row.appendChild(dot);
            }
            const nameSpan = document.createElement('span');
            nameSpan.className = 'label-search-name';
            nameSpan.textContent = label;
            row.appendChild(nameSpan);
            if (scientificName) {
                const sub = document.createElement('span');
                sub.className = 'label-search-sci';
                sub.textContent = scientificName;
                row.appendChild(sub);
            }
            if (detail) {
                const detailSpan = document.createElement('span');
                detailSpan.className = 'label-search-detail';
                detailSpan.textContent = detail;
                row.appendChild(detailSpan);
            }

            const select = () => {
                this._input.value = label;
                if (color) { this._colorInput.value = getOverlayColorStyle(color)?.hex || this._colorInput.value; this._colorTouched = true; }
                this._selectedSci = String(scientificName || '').trim();
                this._sciTouched  = true;
                if (tags && typeof tags === 'object') {
                    for (const [k, v] of Object.entries(tags)) { if (v) this._currentTags[k] = v; }
                    this._tagsTouched = true;
                    this._renderTags();
                }
                for (const item of this._resultItems) item.classList.remove('selected');
                row.classList.add('selected');
                this._confirmBtn.disabled = false;
            };

            row.addEventListener('click', select);
            row.addEventListener('dblclick', () => { select(); this._submit(label); });
            row.addEventListener('pointerenter', () => {
                this._activeIndex = this._resultItems.indexOf(row);
                this._updateHighlight();
            });

            this._results.appendChild(row);
            this._resultItems.push(row);
        };

        if (this._existingLabels?.length) {
            for (const item of this._existingLabels) {
                if (typeof item === 'string') addResult({ name: item });
                else addResult({ name: item.name, color: item.color || '', scientificName: item.scientificName || '', tags: item.tags || {} });
            }
        }
        for (const item of custom) addResult({ name: item?.name, scientificName: item?.scientificName || '', color: item?.color || '', detail: item?.detail || '' });
        if (!customOnly) {
            for (const item of taxonomy) addResult({ name: item?.shortcut ? `${item.shortcut}: ${item.name}` : item?.name, color: item?.color || '' });
            for (const name of recent)   addResult({ name });
            for (const name of filtered) addResult({ name });
        }
    }

    // ── Private: interaction ──────────────────────────────────────────

    _updateHighlight() {
        for (let i = 0; i < this._resultItems.length; i++) {
            this._resultItems[i].classList.toggle('active', i === this._activeIndex);
        }
        if (this._activeIndex >= 0 && this._resultItems[this._activeIndex]) {
            this._resultItems[this._activeIndex].scrollIntoView({ block: 'nearest' });
        }
    }

    _handleKeydown(e: unknown) {
        const key = /** @type {KeyboardEvent} */ (e).key;
        if (key === 'ArrowDown') {
            e.preventDefault();
            if (this._resultItems.length) {
                this._activeIndex = (this._activeIndex + 1) % this._resultItems.length;
                this._updateHighlight();
            }
        } else if (key === 'ArrowUp') {
            e.preventDefault();
            if (this._resultItems.length) {
                this._activeIndex = this._activeIndex <= 0 ? this._resultItems.length - 1 : this._activeIndex - 1;
                this._updateHighlight();
            }
        } else if (key === 'Enter') {
            e.preventDefault();
            const activeItem = this._resultItems[this._activeIndex];
            if (activeItem && !activeItem.classList.contains('selected')) {
                activeItem.click();
            } else {
                this._submit(this._input.value);
            }
        } else if (key === 'Escape') {
            e.preventDefault();
            this.close();
        }
    }

    _submit(value: unknown, opts = {}) {
        const trimmed = String(value || '').trim();
        if (!trimmed) return;
        const scientificName = String(opts?.scientificName || this._selectedSci || '').trim();
        const tags = { ...this._currentTags, ...(opts?.tags || {}) };
        for (const k of Object.keys(tags)) { if (!tags[k]) delete tags[k]; }

        const nameChanged  = trimmed !== this._initialValueTrim;
        const colorChanged = this._colorTouched || String(this._colorInput.value || '') !== String(this._initialStyleHex || '');
        const tagsChanged  = this._tagsTouched  || JSON.stringify(tags) !== JSON.stringify(this._initialTagsNorm);
        const sciChanged   = this._sciTouched   || String(scientificName || '') !== String(this._initialScientific || '');

        this._onSubmit({
            name: trimmed,
            color: this._colorInput.value,
            scientificName,
            tags,
            __changed: { name: nameChanged, color: colorChanged, scientificName: sciChanged, tags: tagsChanged },
        });
        this.close();
    }
}
