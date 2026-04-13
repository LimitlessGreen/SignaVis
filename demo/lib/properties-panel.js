/**
 * Properties / Attributes sidebar panel.
 *
 * Shows an attribute table for:
 *  1) Recording metadata (read-only)
 *  2) The currently pinned or hovered label — with inline editing for
 *     editable fields (name, times, frequencies, color, tags, etc.)
 *
 * Selection model:
 *  - "pinned" = actively clicked / selected label → persists
 *  - "hover"  = label under the cursor → temporary, reverts to pinned
 *
 * Inspired by the property editors in GIS software and modern IDEs.
 */

import { TAG_PRESETS } from './label-table.js';
import { createEditableSelect } from './editable-select.js';

// ── Field definitions ────────────────────────────────────────────────

const RECORDING_FIELDS = [
  { key: 'source',      label: 'Source' },
  { key: 'filename',    label: 'File' },
  { key: 'sampleRate',  label: 'Sample rate', fmt: (v) => `${v} Hz` },
  { key: 'duration',    label: 'Duration',    fmt: (v) => `${Number(v).toFixed(2)} s` },
  { key: 'channels',    label: 'Channels' },
  { key: 'recordist',   label: 'Recordist' },
  { key: 'species',     label: 'Species' },
  { key: 'country',     label: 'Country' },
  { key: 'locality',    label: 'Locality' },
  { key: 'date',        label: 'Date' },
  { key: 'time',        label: 'Time' },
  { key: 'quality',     label: 'Quality' },
  { key: 'license',     label: 'License' },
  { key: 'lat',         label: 'Latitude' },
  { key: 'lng',         label: 'Longitude' },
  { key: 'alt',         label: 'Altitude' },
  { key: 'method',      label: 'Method' },
  { key: 'animalSeen',  label: 'Animal seen' },
  { key: 'playbackUsed', label: 'Playback used' },
  { key: 'backgroundSpecies', label: 'Background spp.' },
  { key: 'remarks',     label: 'Remarks' },
];

/**
 * @typedef {'text'|'number'|'color'} EditType
 */

/** @type {Array<{key: string, label: string, fmt?: (v:any)=>string, edit?: EditType, step?: number, suffix?: string}>} */
const LABEL_FIELDS = [
  { key: 'label',            label: 'Name',            edit: 'text' },
  { key: 'scientificName',   label: 'Scientific name', edit: 'text' },
  { key: 'commonName',       label: 'Common name',     edit: 'text' },
  { key: 'start',            label: 'Start',           edit: 'number', step: 0.001, suffix: 's', fmt: (v) => `${Number(v).toFixed(3)} s` },
  { key: 'end',              label: 'End',             edit: 'number', step: 0.001, suffix: 's', fmt: (v) => `${Number(v).toFixed(3)} s` },
  { key: 'freqMin',          label: 'Freq min',        edit: 'number', step: 1,     suffix: 'Hz', fmt: (v) => v != null ? `${Number(v).toFixed(0)} Hz` : '' },
  { key: 'freqMax',          label: 'Freq max',        edit: 'number', step: 1,     suffix: 'Hz', fmt: (v) => v != null ? `${Number(v).toFixed(0)} Hz` : '' },
  { key: 'confidence',       label: 'Confidence',      fmt: (v) => v != null ? `${(Number(v) * 100).toFixed(1)}%` : '' },
  { key: 'origin',           label: 'Origin' },
  { key: 'author',           label: 'Author',          edit: 'text' },
  { key: 'color',            label: 'Color',           edit: 'color' },
];

const PRESET_MAP = new Map(TAG_PRESETS.map((p) => [p.key, p.options]));

export class PropertiesPanel {
  constructor() {
    this.el = document.createElement('div');
    this.el.className = 'scroll-panel properties-panel';

    /** @type {object|null} */
    this._recordingMeta = null;
    /** @type {object|null} */
    this._audioInfo = null;

    /** @type {object|null} Actively selected (pinned) label */
    this._pinnedLabel = null;
    /** @type {object|null} Temporarily hovered label */
    this._hoverLabel = null;

    /** @type {import('./custom-tag-store.js').CustomTagStore|null} */
    this._tagStore = null;

    /**
     * Called when the user edits a field. Signature: (labelId, updates) => void
     * @type {((id: string, updates: object) => void)|null}
     */
    this.onChange = null;

    this._build();
  }

  /** Set the custom tag store for editable dropdowns. */
  setTagStore(store) {
    this._tagStore = store || null;
  }

  // ── Public API ────────────────────────────────────────────────────

  /**
   * Set recording metadata (from XC import or manual source).
   * @param {object|null} meta
   * @param {object}      [audioInfo]
   */
  setRecordingMeta(meta, audioInfo) {
    this._recordingMeta = meta || null;
    this._audioInfo = audioInfo || null;
    this._renderRecording();
  }

  /**
   * Pin (select) a label — persists until another label is pinned or cleared.
   * @param {object|null} label
   */
  pinLabel(label) {
    this._pinnedLabel = label || null;
    if (!this._hoverLabel) this._renderLabel();
  }

  /**
   * Hover-preview a label (temporary).
   * @param {object|null} label
   */
  hoverLabel(label) {
    this._hoverLabel = label || null;
    this._renderLabel();
  }

  /**
   * End hover — reverts to pinned label.
   */
  clearHover() {
    this._hoverLabel = null;
    this._renderLabel();
  }

  /** @returns {object|null} The currently displayed label */
  get displayedLabel() {
    return this._hoverLabel || this._pinnedLabel;
  }

  /**
   * Refresh the currently displayed label (e.g. after external edit).
   * @param {object} label  Updated label with same id
   */
  refreshLabel(label) {
    if (this._pinnedLabel?.id === label?.id) this._pinnedLabel = label;
    if (this._hoverLabel?.id === label?.id) this._hoverLabel = label;
    this._renderLabel();
  }

  /** Clear all content. */
  clear() {
    this._recordingMeta = null;
    this._audioInfo = null;
    this._pinnedLabel = null;
    this._hoverLabel = null;
    this._renderRecording();
    this._renderLabel();
  }

  // ── DOM ───────────────────────────────────────────────────────────

  _build() {
    // Recording section
    this._recSection = document.createElement('div');
    this._recSection.className = 'props-section';
    const recHeader = document.createElement('div');
    recHeader.className = 'props-section-title';
    recHeader.textContent = 'Recording';
    this._recSection.appendChild(recHeader);
    this._recBody = document.createElement('div');
    this._recBody.className = 'props-section-body';
    this._recSection.appendChild(this._recBody);
    this.el.appendChild(this._recSection);

    // Label section
    this._lblSection = document.createElement('div');
    this._lblSection.className = 'props-section';
    this._lblHeader = document.createElement('div');
    this._lblHeader.className = 'props-section-title';
    this._lblSection.appendChild(this._lblHeader);
    this._lblBody = document.createElement('div');
    this._lblBody.className = 'props-section-body';
    this._lblSection.appendChild(this._lblBody);
    this.el.appendChild(this._lblSection);

    this._renderRecording();
    this._renderLabel();
  }

  _renderRecording() {
    this._recBody.innerHTML = '';
    const merged = { ...this._audioInfo, ...this._recordingMeta };
    if (!Object.keys(merged).length) {
      this._recBody.innerHTML = '<div class="props-empty">No recording loaded.</div>';
      return;
    }
    this._recBody.appendChild(this._buildReadonlyGrid(RECORDING_FIELDS, merged));
  }

  _renderLabel() {
    this._lblBody.innerHTML = '';
    const lbl = this._hoverLabel || this._pinnedLabel;
    const isHover = !!this._hoverLabel;

    // Update section header
    this._lblHeader.textContent = isHover ? 'Hovered Label' : 'Selected Label';
    this._lblHeader.classList.toggle('props-hover-hint', isHover);

    if (!lbl) {
      this._lblBody.innerHTML = '<div class="props-empty">No label selected.</div>';
      return;
    }

    const editable = !isHover; // only pinned labels are editable
    this._lblBody.appendChild(this._buildLabelGrid(lbl, editable));

    // Tags section
    this._lblBody.appendChild(this._buildTagsSection(lbl, editable));
  }

  // ── Grid builders ─────────────────────────────────────────────────

  /** Read-only DL grid (for recording metadata). */
  _buildReadonlyGrid(fields, data) {
    const dl = document.createElement('dl');
    dl.className = 'props-grid';
    for (const f of fields) {
      const raw = data[f.key];
      if (raw == null || raw === '') continue;
      const dt = document.createElement('dt');
      dt.textContent = f.label;
      const dd = document.createElement('dd');
      dd.textContent = f.fmt ? f.fmt(raw) : String(raw);
      dl.appendChild(dt);
      dl.appendChild(dd);
    }
    return dl;
  }

  /** Label grid with editable / read-only fields. */
  _buildLabelGrid(lbl, editable) {
    const dl = document.createElement('dl');
    dl.className = 'props-grid';

    for (const f of LABEL_FIELDS) {
      const raw = lbl[f.key];
      // For editable fields, always show the row (even if empty) so user can fill it
      if (!f.edit && (raw == null || raw === '')) continue;
      if (!editable && (raw == null || raw === '')) continue;

      const dt = document.createElement('dt');
      dt.textContent = f.label;

      const dd = document.createElement('dd');

      if (editable && f.edit) {
        dd.classList.add('props-editable');
        dd.appendChild(this._buildInput(f, raw, lbl));
      } else if (f.key === 'color' && typeof raw === 'string' && raw.startsWith('#')) {
        const swatch = document.createElement('span');
        swatch.className = 'props-color-swatch';
        swatch.style.background = raw;
        dd.appendChild(swatch);
        dd.appendChild(document.createTextNode(raw));
      } else {
        dd.textContent = f.fmt ? f.fmt(raw) : String(raw ?? '');
        if (!f.edit) dd.classList.add('props-readonly');
      }

      dl.appendChild(dt);
      dl.appendChild(dd);
    }
    return dl;
  }

  /** Create the appropriate input element for an editable field. */
  _buildInput(field, value, lbl) {
    if (field.edit === 'color') {
      return this._buildColorInput(field, value, lbl);
    }

    if (field.edit === 'number') {
      return this._buildNumberInput(field, value, lbl);
    }

    // text
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'props-input';
    input.value = value ?? '';
    input.placeholder = field.label;
    input.addEventListener('change', () => {
      this._emitChange(lbl.id, { [field.key]: input.value });
    });
    return input;
  }

  _buildNumberInput(field, value, lbl) {
    const wrap = document.createElement('span');
    wrap.className = 'props-number-wrap';
    const input = document.createElement('input');
    input.type = 'number';
    input.className = 'props-input props-input-number';
    input.value = value != null ? Number(value) : '';
    input.step = String(field.step || 0.001);
    input.addEventListener('change', () => {
      const v = input.value === '' ? null : Number(input.value);
      this._emitChange(lbl.id, { [field.key]: v });
    });
    wrap.appendChild(input);
    if (field.suffix) {
      const suf = document.createElement('span');
      suf.className = 'props-suffix';
      suf.textContent = field.suffix;
      wrap.appendChild(suf);
    }
    return wrap;
  }

  _buildColorInput(field, value, lbl) {
    const wrap = document.createElement('span');
    wrap.className = 'props-color-wrap';

    const swatch = document.createElement('input');
    swatch.type = 'color';
    swatch.className = 'props-color-input';
    let defaultSwatch = '';
    if (typeof window !== 'undefined' && window.getComputedStyle) {
      const cssVal = getComputedStyle(document.documentElement).getPropertyValue('--muted') || getComputedStyle(document.documentElement).getPropertyValue('--color-text-secondary') || '';
      const v = cssVal.trim();
      if (v.startsWith('#')) {
        defaultSwatch = v;
      } else if (/rgba?\(/i.test(v)) {
        const m = v.match(/rgba?\((\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i);
        if (m) defaultSwatch = '#' + [1,2,3].map(i => Number(m[i]).toString(16).padStart(2,'0')).join('');
      }
    }
    swatch.value = (typeof value === 'string' && value.startsWith('#')) ? value : (defaultSwatch || '');
    swatch.addEventListener('input', () => {
      text.value = swatch.value;
    });
    swatch.addEventListener('change', () => {
      this._emitChange(lbl.id, { color: swatch.value });
    });

    const text = document.createElement('input');
    text.type = 'text';
    text.className = 'props-input props-input-color-text';
    text.value = value ?? '';
    text.addEventListener('change', () => {
      if (/^#[0-9a-f]{6}$/i.test(text.value)) {
        swatch.value = text.value;
        this._emitChange(lbl.id, { color: text.value });
      }
    });

    wrap.appendChild(swatch);
    wrap.appendChild(text);
    return wrap;
  }

  // ── Tags section ──────────────────────────────────────────────────

  _buildTagsSection(lbl, editable) {
    const frag = document.createDocumentFragment();
    const header = document.createElement('div');
    header.className = 'props-tag-header';
    header.textContent = 'Tags';
    frag.appendChild(header);

    const tags = (lbl.tags && typeof lbl.tags === 'object') ? { ...lbl.tags } : {};

    if (!editable) {
      // Read-only: just show key-value pairs
      if (!Object.keys(tags).length) {
        const empty = document.createElement('div');
        empty.className = 'props-empty';
        empty.textContent = 'No tags.';
        frag.appendChild(empty);
      } else {
        const dl = document.createElement('dl');
        dl.className = 'props-grid';
        for (const [k, v] of Object.entries(tags)) {
          const dt = document.createElement('dt');
          dt.textContent = k;
          const dd = document.createElement('dd');
          dd.textContent = String(v);
          dl.appendChild(dt);
          dl.appendChild(dd);
        }
        frag.appendChild(dl);
      }
      return frag;
    }

    // Editable: preset selects + custom tags + add button
    const grid = document.createElement('dl');
    grid.className = 'props-grid';

    // Preset tags (sex, lifeStage, soundType)
    for (const preset of TAG_PRESETS) {
      const dt = document.createElement('dt');
      dt.textContent = preset.key;
      const dd = document.createElement('dd');
      dd.classList.add('props-editable');
      const store = this._tagStore;
      const items = store
        ? store.getMerged(preset.key, preset.options)
        : preset.options.map((v) => ({ value: v, custom: false }));
      const es = createEditableSelect({
        placeholder: '–',
        value: tags[preset.key] || '',
        items,
        onChange: (val) => {
          const newTags = { ...lbl.tags };
          if (val) newTags[preset.key] = val;
          else delete newTags[preset.key];
          this._emitChange(lbl.id, { tags: newTags });
        },
        onAdd: store ? (val) => store.add(preset.key, val) : undefined,
        onRemove: store ? (val) => store.remove(preset.key, val) : undefined,
        onRename: store ? (oldV, newV) => store.rename(preset.key, oldV, newV) : undefined,
      });
      dd.appendChild(es.el);
      grid.appendChild(dt);
      grid.appendChild(dd);
    }

    // Custom (non-preset) tags
    const customKeys = Object.keys(tags).filter((k) => !PRESET_MAP.has(k));
    for (const k of customKeys) {
      const dt = document.createElement('dt');
      const keyInput = document.createElement('input');
      keyInput.type = 'text';
      keyInput.className = 'props-input props-input-tag-key';
      keyInput.value = k;
      keyInput.readOnly = true;
      dt.appendChild(keyInput);

      const dd = document.createElement('dd');
      dd.classList.add('props-editable');
      const wrap = document.createElement('span');
      wrap.className = 'props-custom-tag-wrap';
      const valInput = document.createElement('input');
      valInput.type = 'text';
      valInput.className = 'props-input';
      valInput.value = tags[k] ?? '';
      valInput.addEventListener('change', () => {
        const newTags = { ...lbl.tags };
        newTags[k] = valInput.value;
        this._emitChange(lbl.id, { tags: newTags });
      });
      const delBtn = document.createElement('button');
      delBtn.className = 'props-tag-del';
      delBtn.textContent = '×';
      delBtn.title = 'Remove tag';
      delBtn.addEventListener('click', () => {
        const newTags = { ...lbl.tags };
        delete newTags[k];
        this._emitChange(lbl.id, { tags: newTags });
      });
      wrap.appendChild(valInput);
      wrap.appendChild(delBtn);
      dd.appendChild(wrap);
      grid.appendChild(dt);
      grid.appendChild(dd);
    }

    frag.appendChild(grid);

    // Add custom tag button
    const addBtn = document.createElement('button');
    addBtn.className = 'props-tag-add';
    addBtn.textContent = '+ Tag';
    addBtn.addEventListener('click', () => {
      const key = prompt('Tag key:');
      if (!key?.trim()) return;
      const val = prompt('Tag value:') ?? '';
      const newTags = { ...lbl.tags, [key.trim()]: val };
      this._emitChange(lbl.id, { tags: newTags });
    });
    frag.appendChild(addBtn);

    return frag;
  }

  // ── Helpers ───────────────────────────────────────────────────────

  _emitChange(id, updates) {
    this.onChange?.(id, updates);
  }
}
