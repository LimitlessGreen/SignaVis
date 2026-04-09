/**
 * Properties / Attributes sidebar panel.
 *
 * Shows a read-only attribute table for:
 *  1) Recording metadata (source, recordist, date, location, etc.)
 *  2) The currently selected/highlighted label (name, time, freq, tags, etc.)
 *
 * Inspired by the attribute tables in GIS software and modern IDEs.
 */

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

const LABEL_FIELDS = [
  { key: 'label',            label: 'Name' },
  { key: 'scientificName',   label: 'Scientific name' },
  { key: 'commonName',       label: 'Common name' },
  { key: 'start',            label: 'Start',     fmt: (v) => `${Number(v).toFixed(3)} s` },
  { key: 'end',              label: 'End',        fmt: (v) => `${Number(v).toFixed(3)} s` },
  { key: 'freqMin',          label: 'Freq min',   fmt: (v) => v != null ? `${Number(v).toFixed(0)} Hz` : '' },
  { key: 'freqMax',          label: 'Freq max',   fmt: (v) => v != null ? `${Number(v).toFixed(0)} Hz` : '' },
  { key: 'confidence',       label: 'Confidence',  fmt: (v) => v != null ? `${(Number(v) * 100).toFixed(1)}%` : '' },
  { key: 'origin',           label: 'Origin' },
  { key: 'author',           label: 'Author' },
  { key: 'color',            label: 'Color' },
];

export class PropertiesPanel {
  constructor() {
    this.el = document.createElement('div');
    this.el.className = 'scroll-panel properties-panel';
    /** @type {object|null} */
    this._recordingMeta = null;
    /** @type {object|null} */
    this._audioInfo = null;
    /** @type {object|null} */
    this._selectedLabel = null;
    this._build();
  }

  // ── Public API ────────────────────────────────────────────────────

  /**
   * Set recording metadata (from XC import or manual source).
   * @param {object|null} meta  Key-value pairs from recording
   * @param {object}      [audioInfo]  { sampleRate, duration, channels, filename, source }
   */
  setRecordingMeta(meta, audioInfo) {
    this._recordingMeta = meta || null;
    this._audioInfo = audioInfo || null;
    this._renderRecording();
  }

  /**
   * Set the currently selected/highlighted label.
   * @param {object|null} label  Label object from state.labels
   */
  setSelectedLabel(label) {
    this._selectedLabel = label || null;
    this._renderLabel();
  }

  /** Clear all content. */
  clear() {
    this._recordingMeta = null;
    this._audioInfo = null;
    this._selectedLabel = null;
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
    const lblHeader = document.createElement('div');
    lblHeader.className = 'props-section-title';
    lblHeader.textContent = 'Selected Label';
    this._lblSection.appendChild(lblHeader);
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
    this._recBody.appendChild(this._buildGrid(RECORDING_FIELDS, merged));
  }

  _renderLabel() {
    this._lblBody.innerHTML = '';
    if (!this._selectedLabel) {
      this._lblBody.innerHTML = '<div class="props-empty">No label selected.</div>';
      return;
    }
    const lbl = this._selectedLabel;
    this._lblBody.appendChild(this._buildGrid(LABEL_FIELDS, lbl));

    // Tags as extra key-value pairs
    const tags = lbl.tags;
    if (tags && typeof tags === 'object' && Object.keys(tags).length) {
      const tagHeader = document.createElement('div');
      tagHeader.className = 'props-tag-header';
      tagHeader.textContent = 'Tags';
      this._lblBody.appendChild(tagHeader);
      const tagFields = Object.entries(tags).map(([k, v]) => ({ key: k, label: k }));
      this._lblBody.appendChild(this._buildGrid(tagFields, tags));
    }
  }

  /**
   * Build a DL grid from field definitions and a data object.
   * @param {Array<{key: string, label: string, fmt?: (v: any) => string}>} fields
   * @param {object} data
   * @returns {HTMLDListElement}
   */
  _buildGrid(fields, data) {
    const dl = document.createElement('dl');
    dl.className = 'props-grid';
    for (const f of fields) {
      const raw = data[f.key];
      if (raw == null || raw === '') continue;
      const dt = document.createElement('dt');
      dt.textContent = f.label;
      const dd = document.createElement('dd');
      if (f.key === 'color' && typeof raw === 'string' && raw.startsWith('#')) {
        const swatch = document.createElement('span');
        swatch.className = 'props-color-swatch';
        swatch.style.background = raw;
        dd.appendChild(swatch);
        dd.appendChild(document.createTextNode(raw));
      } else {
        dd.textContent = f.fmt ? f.fmt(raw) : String(raw);
      }
      dl.appendChild(dt);
      dl.appendChild(dd);
    }
    return dl;
  }
}
