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
import { openMapModal, GEO_ICONS } from './geo-map-modal.js';

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

const SET_FIELDS = [
  { key: 'name',         label: 'Set Name',     edit: 'text' },
  { key: 'license',      label: 'License',      edit: 'text' },
  { key: 'creator',      label: 'Creator',      edit: 'text' },
  { key: 'creatorId',    label: 'Creator ID',   edit: 'text' },
  { key: 'owner',        label: 'Owner',        edit: 'text' },
  { key: 'source',       label: 'Set Source',   edit: 'text' },
  { key: 'uri',          label: 'Set URI',      edit: 'text' },
  { key: 'projectName',  label: 'Project',      edit: 'text' },
  { key: 'projectUri',   label: 'Project URI',  edit: 'text' },
  { key: 'funding',      label: 'Funding',      edit: 'text' },
  { key: 'taxonCoverage',label: 'Taxon cover.', edit: 'text' },
  { key: 'completeness', label: 'Completeness', edit: 'text' },
  { key: 'createdOn',    label: 'Created on' },
  { key: 'origin',       label: 'Origin' },
];

export class PropertiesPanel {
  /**
   * @param {object} [opts]
   * @param {(setId: string) => object|null} [opts.getSetInfo]
   * @param {((anchor: HTMLElement, cb: function) => {el:HTMLElement,input:HTMLInputElement,destroy:function})|null} [opts.speciesSearchFactory]
   */
  constructor(opts = {}) {
    this.el = document.createElement('div');
    this.el.className = 'scroll-panel properties-panel';

    /** @type {object|null} */
    this._recordingMeta = null;
    /** @type {object|null} */
    this._audioInfo = null;

    /** @type {Map<string, {status: 'pending'|'done'|'error', value?: number}>} */
    this._snrCache = new Map();
    /** @type {HTMLElement|null} Reference to the SNR value cell for fast in-place updates. */
    this._snrDd = null;

    /** @type {object|null} Actively selected (pinned) label */
    this._pinnedLabel = null;
    /** @type {object|null} Temporarily hovered label */
    this._hoverLabel = null;

    /** @type {import('./custom-tag-store.js').CustomTagStore|null} */
    this._tagStore = null;
    this._esInstances = [];
    /** @type {Set<string>} */
    this._lockedIds = new Set();

    this._getSetInfo = opts.getSetInfo || null;
    /** @type {((anchor: HTMLElement, cb: function) => object)|null} */
    this._speciesSearchFactory = opts.speciesSearchFactory || null;

    /** Structural signature of the last full render — used to short-circuit to in-place value patching. */
    this._renderSig = null;

    /**
     * Called when the user edits a label field. Signature: (labelId, updates) => void
     * @type {((id: string, updates: object) => void)|null}
     */
    this.onChange = null;
    /**
     * Called when the user edits a set field. Signature: (setId, updates) => void
     * @type {((id: string, updates: object) => void)|null}
     */
    this.onSetChange = null;

    this._build();
  }

  /** Provide or update the species search factory after construction. */
  setSpeciesSearchFactory(fn) { this._speciesSearchFactory = fn || null; }

  /**
   * Mark a set of label ids as locked (shown read-only in the panel).
   * @param {string[]} ids
   */
  setLockedIds(ids = []) {
    this._lockedIds = new Set(ids);
    this._renderLabel();
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
    if (!this._isPanelInputFocused()) this._renderLabel();
  }

  /**
   * End hover — reverts to pinned label.
   */
  clearHover() {
    this._hoverLabel = null;
    if (!this._isPanelInputFocused()) this._renderLabel();
  }

  /** @returns {object|null} The currently displayed label */
  get displayedLabel() {
    return this._hoverLabel || this._pinnedLabel;
  }

  /**
   * Scroll the label section into view and briefly highlight it.
   * Call this after pinLabel() when navigating from another tab.
   */
  highlightLabelSection() {
    const section = this._lblSection;
    if (!section) return;
    // Remove class first so the animation can restart
    section.classList.remove('props-section--highlight');
    // Force reflow so removing + re-adding triggers the animation fresh
    void section.offsetWidth;
    section.classList.add('props-section--highlight');
    section.addEventListener('animationend', () => {
      section.classList.remove('props-section--highlight');
    }, { once: true });
    // Scroll into view (smooth, but fallback gracefully)
    try { section.scrollIntoView({ behavior: 'smooth', block: 'nearest' }); } catch {}
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

  /**
   * Update the cached SNR for a label and refresh the display if it is visible.
   * @param {string} id  Label id
   * @param {'pending'|'done'|'error'} status
   * @param {number} [value]  SNR in dB (only when status === 'done')
   */
  setSnr(id, status, value) {
    if (status === 'done' && value != null) {
      this._snrCache.set(id, { status, value });
    } else {
      this._snrCache.set(id, { status });
    }
    // Fast path: update the cell directly without rebuilding the whole panel.
    if (this.displayedLabel?.id === id && this._snrDd) {
      this._snrDd.textContent = this._formatSnr(this._snrCache.get(id));
    }
  }

  /** @private */
  _formatSnr(entry) {
    if (!entry) return '—';
    if (entry.status === 'pending') return 'Computing…';
    if (entry.status === 'done' && entry.value != null) return `${entry.value.toFixed(1)} dB`;
    return '—';
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

    // Set section (between Recording and Label)
    this._setSection = document.createElement('div');
    this._setSection.className = 'props-section props-section--set';
    this._setSection.hidden = true;
    const setHdr = document.createElement('div');
    setHdr.className = 'props-section-title';
    setHdr.textContent = 'Annotation Set';
    this._setSection.appendChild(setHdr);
    this._setBody = document.createElement('div');
    this._setBody.className = 'props-section-body';
    this._setSection.appendChild(this._setBody);
    this.el.appendChild(this._setSection);

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

    const lat = parseFloat(merged.lat);
    const lon = parseFloat(merged.lng);
    const hasCoords = isFinite(lat) && isFinite(lon);

    this._recBody.appendChild(
      this._buildReadonlyGrid(RECORDING_FIELDS, merged, hasCoords ? { lat, lon } : null)
    );
  }

  _renderSet() {
    const lbl = this._hoverLabel || this._pinnedLabel;
    const setId = lbl?.setId || null;
    const setInfo = (setId && this._getSetInfo) ? this._getSetInfo(setId) : null;
    this._setSection.hidden = !setInfo;
    this._setBody.innerHTML = '';
    if (!setInfo) return;
    const isLocked = !!lbl && (lbl.readonly === true || this._lockedIds.has(lbl.id));
    const editable = !this._hoverLabel && !isLocked;
    const dl = document.createElement('dl');
    dl.className = 'props-grid';
    for (const f of SET_FIELDS) {
      const raw = setInfo[f.key];
      if (!f.edit && (raw == null || raw === '')) continue;
      if (!editable && (raw == null || raw === '')) continue;
      const dt = document.createElement('dt');
      dt.textContent = f.label;
      const dd = document.createElement('dd');
      if (editable && f.edit) {
        dd.classList.add('props-editable');
        const inp = document.createElement('input');
        inp.type = 'text';
        inp.className = 'props-input';
        inp.dataset.focusKey = `set:${f.key}`;
        inp.value = raw ?? '';
        inp.placeholder = f.label;
        inp.addEventListener('change', () => {
          this.onSetChange?.(setId, { [f.key]: inp.value.trim() });
        });
        this._bindEnterBlur(inp);
        dd.appendChild(inp);
      } else {
        dd.textContent = String(raw ?? '');
        dd.classList.add('props-readonly');
      }
      dl.appendChild(dt);
      dl.appendChild(dd);
    }
    this._setBody.appendChild(dl);
  }

  _renderLabel() {
    const lbl = this._hoverLabel || this._pinnedLabel;
    const isHover = !!this._hoverLabel;
    const isLocked = !isHover && !!lbl && (lbl.readonly === true || this._lockedIds.has(lbl.id));
    const editable = !isHover && !isLocked;

    // Structural signature: determines whether a full DOM rebuild is needed.
    // Only the things that change the shape of the form (which rows/inputs exist)
    // are included. Value changes are handled by _patchValues() without DOM teardown.
    const customTagKeys = editable && lbl
      ? Object.keys(lbl.tags || {}).filter(k => !PRESET_MAP.has(k)).sort().join('\0')
      : '';
    const sig = `${lbl?.id ?? ''}\0${isHover}\0${isLocked}\0${lbl?.setId ?? ''}\0${customTagKeys}`;

    if (sig === this._renderSig && lbl !== null) {
      // Same structure — just update values in place without touching the DOM.
      // This keeps focus exactly where it is.
      this._patchValues(lbl, editable);
      return;
    }
    this._renderSig = sig;

    // ── Full rebuild ────────────────────────────────────────────────
    for (const es of this._esInstances) es.destroy();
    this._esInstances = [];
    this._lblBody.innerHTML = '';

    this._renderSet();

    let headerText = 'Selected Label';
    if (isHover) headerText = 'Hovered Label';
    else if (isLocked) headerText = 'Locked Label';
    this._lblHeader.textContent = headerText;
    this._lblHeader.classList.toggle('props-hover-hint', isHover || isLocked);

    if (!lbl) {
      this._snrDd = null;
      this._lblBody.innerHTML = '<div class="props-empty">No label selected.</div>';
      return;
    }

    this._snrDd = null;
    this._lblBody.appendChild(this._buildLabelGrid(lbl, editable));
    if (isLocked && !isHover) {
      const hint = document.createElement('div');
      hint.className = 'props-locked-hint';
      hint.textContent = '🔒 Label is locked — unlock the set to edit.';
      this._lblBody.appendChild(hint);
    }
    this._lblBody.appendChild(this._buildTagsSection(lbl, editable));
  }

  /**
   * Update input values in-place without rebuilding the DOM.
   * Called when the label data changes but the form structure stays the same.
   */
  _patchValues(lbl, editable) {
    const active = document.activeElement;

    if (editable) {
      for (const f of LABEL_FIELDS) {
        if (!f.edit) continue;
        const input = this._lblBody.querySelector(`[data-focus-key="field:${f.key}"]`);
        if (!input || input === active) continue;
        const val = lbl[f.key];
        if (f.edit === 'number') {
          input.value = val != null ? String(Number(val)) : '';
        } else if (f.edit === 'color') {
          input.value = val ?? '';
          const swatch = input.closest('.props-color-wrap')?.querySelector('input[type="color"]');
          if (swatch && /^#[0-9a-f]{6}$/i.test(val)) swatch.value = val;
        } else {
          input.value = val ?? '';
        }
      }
      // Custom tag values
      const tags = lbl.tags || {};
      for (const [k, v] of Object.entries(tags)) {
        if (PRESET_MAP.has(k)) continue;
        const input = this._lblBody.querySelector(`[data-focus-key="tag:${k}"]`);
        if (input && input !== active) input.value = v ?? '';
      }
    }

    // Set section
    const setId = lbl?.setId ?? null;
    const setInfo = setId && this._getSetInfo ? this._getSetInfo(setId) : null;
    if (setInfo) {
      for (const f of SET_FIELDS) {
        if (!f.edit) continue;
        const input = this._setBody.querySelector(`[data-focus-key="set:${f.key}"]`);
        if (input && input !== active) input.value = setInfo[f.key] ?? '';
      }
    }
  }

  // ── Grid builders ─────────────────────────────────────────────────

  /**
   * Read-only DL grid for recording metadata.
   * @param {Array} fields
   * @param {object} data
   * @param {{lat:number, lon:number}|null} [mapCoords]  When set, lat/lng rows get a map trigger.
   */
  _buildReadonlyGrid(fields, data, mapCoords = null) {
    const dl = document.createElement('dl');
    dl.className = 'props-grid';
    for (const f of fields) {
      const raw = data[f.key];
      if (raw == null || raw === '') continue;
      const dt = document.createElement('dt');
      dt.textContent = f.label;
      const dd = document.createElement('dd');

      if (mapCoords && (f.key === 'lat' || f.key === 'lng')) {
        // Render as a clickable coordinate value
        dd.className = 'props-coord-cell';
        const span = document.createElement('span');
        span.textContent = f.fmt ? f.fmt(raw) : String(raw);
        dd.appendChild(span);
        if (f.key === 'lat') {
          // Map icon button — only on the lat row to avoid duplication
          const mapBtn = document.createElement('button');
          mapBtn.type = 'button';
          mapBtn.className = 'props-coord-map-btn';
          mapBtn.title = `Show on map (${mapCoords.lat.toFixed(4)}, ${mapCoords.lon.toFixed(4)})`;
          mapBtn.innerHTML = GEO_ICONS.map;
          mapBtn.addEventListener('click', () =>
            openMapModal({ lat: mapCoords.lat, lon: mapCoords.lon, zoom: 10, readOnly: true })
          );
          dd.appendChild(mapBtn);
        }
      } else {
        dd.textContent = f.fmt ? f.fmt(raw) : String(raw);
      }

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
    // SNR row — always read-only, value comes from SnrComputer
    const snrDt = document.createElement('dt');
    snrDt.textContent = 'SNR';
    const snrDd = document.createElement('dd');
    snrDd.classList.add('props-readonly');
    snrDd.textContent = this._formatSnr(this._snrCache.get(lbl.id));
    this._snrDd = snrDd;
    dl.appendChild(snrDt);
    dl.appendChild(snrDd);

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

    // 'label' field: use taxonomy search widget when factory is available
    if (field.key === 'label' && this._speciesSearchFactory) {
      const placeholder = document.createElement('span');
      const widget = this._speciesSearchFactory(placeholder, ({ name, scientificName }) => {
        this._emitChange(lbl.id, {
          label: name,
          scientificName: scientificName || '',
          commonName: '',
        });
      });
      widget.input.dataset.focusKey = `field:${field.key}`;
      widget.input.value = value ?? '';
      if (value) widget.input.classList.add('has-selection');
      return widget.el;
    }

    // text
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'props-input';
    input.dataset.focusKey = `field:${field.key}`;
    input.value = value ?? '';
    input.placeholder = field.label;
    input.addEventListener('change', () => {
      this._emitChange(lbl.id, { [field.key]: input.value });
    });
    this._bindEnterBlur(input);
    return input;
  }

  _buildNumberInput(field, value, lbl) {
    const wrap = document.createElement('span');
    wrap.className = 'props-number-wrap';
    const input = document.createElement('input');
    input.type = 'number';
    input.className = 'props-input props-input-number';
    input.dataset.focusKey = `field:${field.key}`;
    input.value = value != null ? Number(value) : '';
    input.step = String(field.step || 0.001);
    input.addEventListener('change', () => {
      const v = input.value === '' ? null : Number(input.value);
      this._emitChange(lbl.id, { [field.key]: v });
    });
    this._bindEnterBlur(input);
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
    text.dataset.focusKey = `field:${field.key}`;
    text.value = value ?? '';
    text.addEventListener('change', () => {
      if (/^#[0-9a-f]{6}$/i.test(text.value)) {
        swatch.value = text.value;
        this._emitChange(lbl.id, { color: text.value });
      }
    });
    this._bindEnterBlur(text);

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
          const cur = this.displayedLabel;
          if (!cur) return;
          const newTags = { ...cur.tags };
          if (val) newTags[preset.key] = val;
          else delete newTags[preset.key];
          this._emitChange(cur.id, { tags: newTags });
        },
        onAdd: store ? (val) => store.add(preset.key, val) : undefined,
        onRemove: store ? (val) => store.remove(preset.key, val) : undefined,
        onRename: store ? (oldV, newV) => store.rename(preset.key, oldV, newV) : undefined,
      });
      dd.appendChild(es.el);
      this._esInstances.push(es);
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
      valInput.dataset.focusKey = `tag:${k}`;
      valInput.value = tags[k] ?? '';
      valInput.addEventListener('change', () => {
        const cur = this.displayedLabel;
        if (!cur) return;
        const newTags = { ...cur.tags };
        newTags[k] = valInput.value;
        this._emitChange(cur.id, { tags: newTags });
      });
      this._bindEnterBlur(valInput);
      const delBtn = document.createElement('button');
      delBtn.className = 'props-tag-del';
      delBtn.textContent = '×';
      delBtn.title = 'Remove tag';
      delBtn.addEventListener('click', () => {
        const cur = this.displayedLabel;
        if (!cur) return;
        const newTags = { ...cur.tags };
        delete newTags[k];
        this._emitChange(cur.id, { tags: newTags });
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

  /** Commit and blur when Enter is pressed. */
  _bindEnterBlur(input) {
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); input.blur(); } });
  }

  _isPanelInputFocused() {
    const active = document.activeElement;
    if (!active || active === document.body) return false;
    const tag = active.tagName;
    if (tag !== 'INPUT' && tag !== 'TEXTAREA' && tag !== 'SELECT') return false;
    return this.el.contains(active);
  }
}
